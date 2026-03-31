import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../common/prisma/prisma.service';
import { PosthogService, POSTHOG_EVENTS } from '../posthog/posthog.service';
import { PipelineStateMachine, STAGE_ORDER } from '../state-machine/pipeline-state-machine';
import {
  PipelineRun,
  RetryAttempt,
  RunStatus,
  StageStatus,
  StageType,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid'; // used for retryId generation

@Injectable()
export class PipelineRunService {
  private readonly logger = new Logger(PipelineRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly posthog: PosthogService,
  ) {}

  /**
   * Create a new PipelineRun with an initial INGEST stage (PENDING).
   * The batchId and executionRef are both set to the same generated UUID.
   */
  async createRun(params: {
    batchId: string;
    fileName: string;
    s3Key: string;
    s3Bucket: string;
    metadata?: Record<string, unknown>;
  }): Promise<PipelineRun> {
    const batchId = params.batchId;

    this.logger.log(`Creating new pipeline run, batchId=${batchId}`);

    const run = await this.prisma.pipelineRun.create({
      data: {
        batchId,
        executionRef: batchId, // first run: executionRef === batchId
        status: RunStatus.PENDING,
        fileName: params.fileName,
        s3Key: params.s3Key,
        s3Bucket: params.s3Bucket,
        metadata: params.metadata ?? {},
        stages: {
          create: STAGE_ORDER.map((stageType) => ({
            stageType,
            status: StageStatus.PENDING,
            executionRef: batchId,
          })),
        },
      },
      include: { stages: true },
    });

    await this.logTransition({
      entityType: 'run',
      entityId: run.id,
      executionRef: batchId,
      fromStatus: null,
      toStatus: RunStatus.PENDING,
    });

    this.posthog.capture(POSTHOG_EVENTS.BATCH_CREATED, {
      batchId,
      executionRef: batchId,
      fileName: params.fileName,
      s3Key: params.s3Key,
    });

    return run;
  }

  /**
   * Advance a stage to PROCESSING and start the run if not already started.
   */
  async startStage(runId: string, stageType: StageType): Promise<void> {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { runId, stageType, retryAttemptId: null },
    });
    if (!stage) throw new NotFoundException(`Stage ${stageType} not found for run ${runId}`);

    PipelineStateMachine.transitionStage(stage.status, StageStatus.PROCESSING);

    await this.prisma.$transaction([
      this.prisma.pipelineStage.update({
        where: { id: stage.id },
        data: { status: StageStatus.PROCESSING, startedAt: new Date() },
      }),
      this.prisma.pipelineRun.update({
        where: { id: runId },
        data: { status: RunStatus.PROCESSING, startedAt: new Date() },
      }),
    ]);

    await this.logTransition({
      entityType: 'stage',
      entityId: stage.id,
      executionRef: stage.executionRef,
      fromStatus: stage.status,
      toStatus: StageStatus.PROCESSING,
    });

    this.posthog.capture(POSTHOG_EVENTS.STAGE_STARTED, {
      runId,
      stageType,
      executionRef: stage.executionRef,
    });
  }

  /**
   * Mark a stage as COMPLETED.
   * If all stages are complete, mark the run as COMPLETED too.
   */
  async completeStage(runId: string, stageType: StageType, retryAttemptId?: string): Promise<void> {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: {
        runId,
        stageType,
        retryAttemptId: retryAttemptId ?? null,
      },
    });
    if (!stage) throw new NotFoundException(`Stage ${stageType} not found`);

    PipelineStateMachine.transitionStage(stage.status, StageStatus.COMPLETED);

    await this.prisma.pipelineStage.update({
      where: { id: stage.id },
      data: { status: StageStatus.COMPLETED, completedAt: new Date() },
    });

    await this.logTransition({
      entityType: 'stage',
      entityId: stage.id,
      executionRef: stage.executionRef,
      fromStatus: stage.status,
      toStatus: StageStatus.COMPLETED,
    });

    this.posthog.capture(POSTHOG_EVENTS.STAGE_COMPLETED, {
      runId,
      stageType,
      executionRef: stage.executionRef,
    });

    // Check if all stages for this run (or retry) are done
    await this.reconcileRunStatus(runId, retryAttemptId);
  }

  /**
   * Mark a stage as FAILED and block all downstream stages.
   * Updates the run status to FAILED or BLOCKED accordingly.
   */
  async failStage(
    runId: string,
    stageType: StageType,
    errorPayload: Record<string, unknown>,
    retryAttemptId?: string,
  ): Promise<void> {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { runId, stageType, retryAttemptId: retryAttemptId ?? null },
    });
    if (!stage) throw new NotFoundException(`Stage ${stageType} not found`);

    PipelineStateMachine.transitionStage(stage.status, StageStatus.FAILED);

    // Block all downstream stages
    const downstreamTypes = PipelineStateMachine.getDownstreamStages(stageType);

    const updates = [
      this.prisma.pipelineStage.update({
        where: { id: stage.id },
        data: {
          status: StageStatus.FAILED,
          completedAt: new Date(),
          errorPayload,
        },
      }),
    ];

    if (downstreamTypes.length > 0) {
      updates.push(
        this.prisma.pipelineStage.updateMany({
          where: {
            runId,
            stageType: { in: downstreamTypes },
            retryAttemptId: retryAttemptId ?? null,
          },
          data: { status: StageStatus.BLOCKED },
        }) as any,
      );
    }

    await this.prisma.$transaction(updates);

    await this.logTransition({
      entityType: 'stage',
      entityId: stage.id,
      executionRef: stage.executionRef,
      fromStatus: stage.status,
      toStatus: StageStatus.FAILED,
      errorPayload,
    });

    this.posthog.capture(POSTHOG_EVENTS.STAGE_FAILED, {
      runId,
      stageType,
      executionRef: stage.executionRef,
      errorPayload,
    });

    for (const downstream of downstreamTypes) {
      this.posthog.capture(POSTHOG_EVENTS.STAGE_BLOCKED, {
        runId,
        stageType: downstream,
        executionRef: stage.executionRef,
        reason: `Upstream stage ${stageType} failed`,
      });
    }

    await this.reconcileRunStatus(runId, retryAttemptId);
  }

  /**
   * Initiate a retry for a failed/blocked run.
   *
   * - Generate a new retryId (UUID).
   * - The new execution reference IS the retryId.
   * - The priorRef is the run's current executionRef (could be batchId or a previous retryId).
   * - Update the run's executionRef to the new retryId.
   * - Reset all failed/blocked stages for the retry attempt.
   */
  async retryRun(runId: string, reason?: string): Promise<RetryAttempt> {
    const run = await this.prisma.pipelineRun.findUnique({
      where: { id: runId },
      include: { retries: { orderBy: { attemptNumber: 'desc' }, take: 1 } },
    });

    if (!run) throw new NotFoundException(`Pipeline run not found: ${runId}`);

    if (run.status !== RunStatus.FAILED && run.status !== RunStatus.BLOCKED) {
      throw new BadRequestException(
        `Run ${runId} is in status "${run.status}" and cannot be retried. Only FAILED or BLOCKED runs can be retried.`,
      );
    }

    const retryId = uuidv4();
    const priorRef = run.executionRef; // the ref that was active before this retry
    const attemptNumber = (run.retries[0]?.attemptNumber ?? 0) + 1;

    this.logger.log(
      `Initiating retry #${attemptNumber} for run ${runId}, retryId=${retryId}, priorRef=${priorRef}`,
    );

    const retryAttempt = await this.prisma.$transaction(async (tx) => {
      // Create retry attempt record
      const attempt = await tx.retryAttempt.create({
        data: {
          retryId,
          executionRef: retryId,
          priorRef,
          runId,
          attemptNumber,
          status: RunStatus.RETRYING,
          startedAt: new Date(),
          // Fresh stages for the retry – only stages that were FAILED or BLOCKED
          stages: {
            create: STAGE_ORDER.map((stageType) => ({
              stageType,
              status: StageStatus.PENDING,
              executionRef: retryId,
              runId,
            })),
          },
        },
        include: { stages: true },
      });

      // Advance the run's executionRef to the new retryId
      await tx.pipelineRun.update({
        where: { id: runId },
        data: {
          executionRef: retryId,
          status: RunStatus.RETRYING,
          errorPayload: null,
        },
      });

      return attempt;
    });

    await this.logTransition({
      entityType: 'retry',
      entityId: retryAttempt.id,
      executionRef: retryId,
      fromStatus: run.status,
      toStatus: RunStatus.RETRYING,
      reason,
    });

    this.posthog.capture(POSTHOG_EVENTS.RETRY_INITIATED, {
      runId,
      retryId,
      priorRef,
      attemptNumber,
      reason,
    });

    // Kick off the ingest stage for the retry
    await this.startStageForRetry(runId, StageType.INGEST, retryAttempt.id, retryId);

    return retryAttempt;
  }

  private async startStageForRetry(
    runId: string,
    stageType: StageType,
    retryAttemptId: string,
    executionRef: string,
  ): Promise<void> {
    const stage = await this.prisma.pipelineStage.findFirst({
      where: { runId, stageType, retryAttemptId },
    });
    if (!stage) return;

    await this.prisma.pipelineStage.update({
      where: { id: stage.id },
      data: { status: StageStatus.PROCESSING, startedAt: new Date() },
    });
  }

  /** Retrieve a single pipeline run by its internal ID. */
  async getRunById(runId: string): Promise<PipelineRun> {
    const run = await this.prisma.pipelineRun.findUnique({ where: { id: runId } });
    if (!run) throw new NotFoundException(`Pipeline run not found: ${runId}`);
    return run;
  }

  /** List pipeline runs with filtering and pagination. */
  async listRuns(params: {
    status?: RunStatus;
    fromDate?: string;
    toDate?: string;
    page: number;
    limit: number;
  }): Promise<{ data: PipelineRun[]; total: number; page: number; limit: number }> {
    const where: any = {};

    if (params.status) where.status = params.status;
    if (params.fromDate || params.toDate) {
      where.createdAt = {};
      if (params.fromDate) where.createdAt.gte = new Date(params.fromDate);
      if (params.toDate) where.createdAt.lte = new Date(params.toDate);
    }

    const skip = (params.page - 1) * params.limit;

    const [data, total] = await this.prisma.$transaction([
      this.prisma.pipelineRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: params.limit,
        include: {
          stages: { orderBy: { createdAt: 'asc' } },
          retries: {
            orderBy: { attemptNumber: 'asc' },
            select: {
              retryId: true,
              priorRef: true,
              executionRef: true,
              attemptNumber: true,
              status: true,
              startedAt: true,
              completedAt: true,
            },
          },
        },
      }),
      this.prisma.pipelineRun.count({ where }),
    ]);

    return { data, total, page: params.page, limit: params.limit };
  }

  /** Derive and persist the overall run status from its current stage statuses. */
  private async reconcileRunStatus(runId: string, retryAttemptId?: string): Promise<void> {
    const stages = await this.prisma.pipelineStage.findMany({
      where: { runId, retryAttemptId: retryAttemptId ?? null },
      select: { status: true },
    });

    const statuses = stages.map((s) => s.status);
    const derivedStatus = PipelineStateMachine.deriveRunStatus(statuses);

    if (retryAttemptId) {
      const attempt = await this.prisma.retryAttempt.findUnique({
        where: { id: retryAttemptId },
      });
      if (attempt) {
        await this.prisma.retryAttempt.update({
          where: { id: retryAttemptId },
          data: {
            status: derivedStatus,
            completedAt:
              derivedStatus === RunStatus.COMPLETED || derivedStatus === RunStatus.FAILED
                ? new Date()
                : undefined,
          },
        });
      }
    }

    const run = await this.prisma.pipelineRun.findUnique({ where: { id: runId } });
    if (!run) return;

    const nextRunStatus = derivedStatus;

    await this.prisma.pipelineRun.update({
      where: { id: runId },
      data: {
        status: nextRunStatus,
        completedAt:
          nextRunStatus === RunStatus.COMPLETED || nextRunStatus === RunStatus.FAILED
            ? new Date()
            : undefined,
      },
    });

    await this.logTransition({
      entityType: 'run',
      entityId: runId,
      executionRef: run.executionRef,
      fromStatus: run.status,
      toStatus: nextRunStatus,
    });

    if (nextRunStatus === RunStatus.COMPLETED) {
      this.posthog.capture(POSTHOG_EVENTS.RUN_COMPLETED, {
        runId,
        batchId: run.batchId,
        executionRef: run.executionRef,
      });
    } else if (nextRunStatus === RunStatus.FAILED) {
      this.posthog.capture(POSTHOG_EVENTS.RUN_FAILED, {
        runId,
        batchId: run.batchId,
        executionRef: run.executionRef,
      });
    }
  }

  private async logTransition(params: {
    entityType: string;
    entityId: string;
    executionRef: string;
    fromStatus: string | null;
    toStatus: string;
    reason?: string;
    errorPayload?: Record<string, unknown>;
  }): Promise<void> {
    await this.prisma.stateTransitionLog.create({
      data: {
        entityType: params.entityType,
        entityId: params.entityId,
        executionRef: params.executionRef,
        fromStatus: params.fromStatus,
        toStatus: params.toStatus,
        reason: params.reason,
        errorPayload: params.errorPayload,
      },
    });
  }
}
