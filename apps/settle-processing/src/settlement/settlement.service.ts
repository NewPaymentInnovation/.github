import { Injectable, Logger } from '@nestjs/common';
import { S3Service } from '../aws/s3.service';
import { SqsService } from '../aws/sqs.service';
import { PipelineRunService } from './pipeline-run.service';
import { PosthogService, POSTHOG_EVENTS } from '../posthog/posthog.service';
import { PipelineRun, StageType } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  constructor(
    private readonly s3: S3Service,
    private readonly sqs: SqsService,
    private readonly pipelineRunService: PipelineRunService,
    private readonly posthog: PosthogService,
  ) {}

  /**
   * Handle a settlement file upload:
   * 1. Generate a unique batch ID.
   * 2. Upload the file to S3 with the batch ID embedded in the key.
   * 3. Create a PipelineRun record (PENDING).
   * 4. Publish a message to the ingest SQS queue to start the pipeline.
   * 5. Transition INGEST stage to PROCESSING.
   */
  async uploadSettlementFile(
    file: Express.Multer.File,
    metadata?: Record<string, unknown>,
  ): Promise<PipelineRun> {
    // The batchId is assigned here; propagated everywhere from this point
    const batchId = uuidv4();
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const s3Key = `settlements/${timestamp}/${batchId}/${file.originalname}`;

    this.logger.log(`Starting upload pipeline for file="${file.originalname}", batchId=${batchId}`);

    // 1. Upload to S3
    const { bucket } = await this.s3.uploadFile(
      s3Key,
      file.buffer,
      file.mimetype,
      { batchId, originalName: file.originalname },
    );

    // 2. Create the pipeline run record (pass the pre-generated batchId so it matches the S3 key)
    const run = await this.pipelineRunService.createRun({
      batchId,
      fileName: file.originalname,
      s3Key,
      s3Bucket: bucket,
      metadata,
    });

    // 3. Publish to SQS ingest queue – propagating batchId as the executionRef
    const sqsMessageId = await this.sqs.publishToIngestQueue({
      batchId: run.batchId,
      executionRef: run.executionRef,
      s3Bucket: bucket,
      s3Key,
      stageType: StageType.INGEST,
      metadata,
    });

    // 4. Mark INGEST stage as PROCESSING
    await this.pipelineRunService.startStage(run.id, StageType.INGEST);

    this.logger.log(
      `Pipeline started: runId=${run.id}, batchId=${run.batchId}, sqsMessageId=${sqsMessageId}`,
    );

    return run;
  }

  /**
   * Re-queue a failed or blocked run from the point of failure.
   * Generates a new retryId and uses it as the execution reference going forward.
   */
  async retryRun(runId: string, reason?: string) {
    this.logger.log(`Retrying run: ${runId}`);

    // Fetch the run before retrying so we have the original S3 coordinates
    const existingRun = await this.pipelineRunService.getRunById(runId);

    const retryAttempt = await this.pipelineRunService.retryRun(runId, reason);

    // Re-publish to the ingest queue using the new retryId as executionRef,
    // carrying the original S3 file reference so downstream consumers can retrieve it.
    await this.sqs.publishToIngestQueue({
      batchId: existingRun.batchId,
      executionRef: retryAttempt.retryId,
      s3Bucket: existingRun.s3Bucket,
      s3Key: existingRun.s3Key,
      stageType: StageType.INGEST,
      metadata: {
        retryId: retryAttempt.retryId,
        priorRef: retryAttempt.priorRef,
        attemptNumber: retryAttempt.attemptNumber,
        reason,
      },
    });

    this.posthog.capture(POSTHOG_EVENTS.RETRY_INITIATED, {
      runId,
      batchId: existingRun.batchId,
      retryId: retryAttempt.retryId,
      priorRef: retryAttempt.priorRef,
      attemptNumber: retryAttempt.attemptNumber,
      reason,
    });

    return retryAttempt;
  }
}
