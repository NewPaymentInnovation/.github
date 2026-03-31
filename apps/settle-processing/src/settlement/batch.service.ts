import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PipelineRun, PipelineStage, RetryAttempt } from '@prisma/client';

export type BatchDetail = PipelineRun & {
  stages: PipelineStage[];
  retries: (RetryAttempt & { stages: PipelineStage[] })[];
};

@Injectable()
export class BatchService {
  private readonly logger = new Logger(BatchService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Retrieve a single batch (pipeline run) by its batchId, including all stages
   * and retry history with their associated stages.
   */
  async getBatchById(batchId: string): Promise<BatchDetail> {
    this.logger.log(`Fetching batch: ${batchId}`);

    const run = await this.prisma.pipelineRun.findUnique({
      where: { batchId },
      include: {
        stages: { orderBy: { createdAt: 'asc' } },
        retries: {
          orderBy: { attemptNumber: 'asc' },
          include: {
            stages: { orderBy: { createdAt: 'asc' } },
          },
        },
      },
    });

    if (!run) {
      throw new NotFoundException(`Batch not found: ${batchId}`);
    }

    return run as BatchDetail;
  }

  /**
   * Build a timeline view of a batch – flattening run stages and retry stages
   * into a single chronological list for the "single pane of glass" response.
   */
  buildTimeline(batch: BatchDetail): object[] {
    const timeline: object[] = [];

    // Initial run stages
    for (const stage of batch.stages) {
      timeline.push({
        phase: 'initial',
        executionRef: stage.executionRef,
        stageType: stage.stageType,
        status: stage.status,
        startedAt: stage.startedAt,
        completedAt: stage.completedAt,
        errorPayload: stage.errorPayload,
        metadata: stage.metadata,
      });
    }

    // Retry stages grouped by attempt
    for (const retry of batch.retries) {
      for (const stage of retry.stages) {
        timeline.push({
          phase: `retry-${retry.attemptNumber}`,
          retryId: retry.retryId,
          priorRef: retry.priorRef,
          executionRef: stage.executionRef,
          stageType: stage.stageType,
          status: stage.status,
          startedAt: stage.startedAt,
          completedAt: stage.completedAt,
          errorPayload: stage.errorPayload,
          metadata: stage.metadata,
        });
      }
    }

    // Sort by startedAt ascending, nulls last
    timeline.sort((a: any, b: any) => {
      if (!a.startedAt) return 1;
      if (!b.startedAt) return -1;
      return new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime();
    });

    return timeline;
  }
}
