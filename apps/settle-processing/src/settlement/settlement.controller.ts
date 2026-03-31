import {
  Controller,
  Post,
  Get,
  Param,
  Query,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
  ApiParam,
} from '@nestjs/swagger';
import { SettlementService } from './settlement.service';
import { BatchService } from './batch.service';
import { PipelineRunService } from './pipeline-run.service';
import { UploadSettlementDto } from './dto/upload-settlement.dto';
import { ListRunsDto } from './dto/list-runs.dto';
import { RetryRunDto } from './dto/retry-run.dto';

@ApiTags('settlement')
@Controller('settlement')
export class SettlementController {
  private readonly logger = new Logger(SettlementController.name);

  constructor(
    private readonly settlementService: SettlementService,
    private readonly batchService: BatchService,
    private readonly pipelineRunService: PipelineRunService,
  ) {}

  /**
   * POST /settlement/upload
   * Trigger the ingestion pipeline via a manual file upload.
   */
  @Post('upload')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({
    summary: 'Upload a settlement file and trigger the ingestion pipeline',
    description:
      'Accepts a settlement file, assigns a unique batch ID, uploads to S3, and triggers the full end-to-end pipeline via SQS.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Settlement file to upload' },
        metadata: {
          type: 'string',
          description: 'Optional JSON string of metadata to attach to this batch',
        },
      },
    },
  })
  @ApiResponse({ status: 201, description: 'Pipeline run created and ingest stage triggered' })
  @ApiResponse({ status: 400, description: 'Invalid request' })
  async uploadSettlementFile(
    @UploadedFile() file: Express.Multer.File,
    @Body() dto: UploadSettlementDto,
  ) {
    this.logger.log(`POST /settlement/upload – file="${file?.originalname}"`);

    let metadata: Record<string, unknown> | undefined;
    if (dto.metadata) {
      try {
        metadata = JSON.parse(dto.metadata);
      } catch {
        metadata = { raw: dto.metadata };
      }
    }

    const run = await this.settlementService.uploadSettlementFile(file, metadata);

    return {
      success: true,
      batchId: run.batchId,
      executionRef: run.executionRef,
      runId: run.id,
      status: run.status,
      fileName: run.fileName,
      s3Key: run.s3Key,
      s3Bucket: run.s3Bucket,
      createdAt: run.createdAt,
    };
  }

  /**
   * GET /settlement/batches/:id
   * Retrieve granular status and metadata for a specific batch.
   */
  @Get('batches/:id')
  @ApiOperation({
    summary: 'Get batch details by batch ID',
    description:
      'Returns the full status, stage breakdown, retry history, and chronological timeline for a specific batch.',
  })
  @ApiParam({ name: 'id', description: 'The batch ID assigned at upload time' })
  @ApiResponse({ status: 200, description: 'Batch details retrieved' })
  @ApiResponse({ status: 404, description: 'Batch not found' })
  async getBatch(@Param('id') batchId: string) {
    this.logger.log(`GET /settlement/batches/${batchId}`);

    const batch = await this.batchService.getBatchById(batchId);
    const timeline = this.batchService.buildTimeline(batch);

    return {
      batchId: batch.batchId,
      executionRef: batch.executionRef,
      runId: batch.id,
      status: batch.status,
      fileName: batch.fileName,
      s3Key: batch.s3Key,
      s3Bucket: batch.s3Bucket,
      metadata: batch.metadata,
      errorPayload: batch.errorPayload,
      startedAt: batch.startedAt,
      completedAt: batch.completedAt,
      createdAt: batch.createdAt,
      updatedAt: batch.updatedAt,
      stages: batch.stages,
      retries: batch.retries.map((r) => ({
        retryId: r.retryId,
        executionRef: r.executionRef,
        priorRef: r.priorRef,
        attemptNumber: r.attemptNumber,
        status: r.status,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        stages: r.stages,
      })),
      timeline,
    };
  }

  /**
   * GET /settlement/runs
   * List historical and active pipeline runs with filtering by date and status.
   */
  @Get('runs')
  @ApiOperation({
    summary: 'List pipeline runs',
    description: 'Returns a paginated list of pipeline runs with optional filtering by status and date range.',
  })
  @ApiResponse({ status: 200, description: 'Paginated list of pipeline runs' })
  async listRuns(@Query() dto: ListRunsDto) {
    this.logger.log(`GET /settlement/runs – status=${dto.status}, page=${dto.page}`);

    return this.pipelineRunService.listRuns({
      status: dto.status,
      fromDate: dto.fromDate,
      toDate: dto.toDate,
      page: dto.page ?? 1,
      limit: dto.limit ?? 20,
    });
  }

  /**
   * POST /settlement/runs/:id/retry
   * Re-queue failed stages or batches.
   */
  @Post('runs/:id/retry')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Retry a failed or blocked pipeline run',
    description:
      'Generates a new retry ID, resets failed/blocked stages, re-queues the pipeline from the point of failure, and preserves full retry lineage.',
  })
  @ApiParam({ name: 'id', description: 'The pipeline run ID (not batchId)' })
  @ApiResponse({ status: 200, description: 'Retry initiated' })
  @ApiResponse({ status: 400, description: 'Run is not in a retryable state' })
  @ApiResponse({ status: 404, description: 'Run not found' })
  async retryRun(
    @Param('id', new ParseUUIDPipe()) runId: string,
    @Body() dto: RetryRunDto,
  ) {
    this.logger.log(`POST /settlement/runs/${runId}/retry`);

    const retryAttempt = await this.settlementService.retryRun(runId, dto.reason);

    return {
      success: true,
      runId,
      retryId: retryAttempt.retryId,
      executionRef: retryAttempt.executionRef,
      priorRef: retryAttempt.priorRef,
      attemptNumber: retryAttempt.attemptNumber,
      status: retryAttempt.status,
      createdAt: retryAttempt.createdAt,
    };
  }
}
