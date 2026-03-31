import { BadRequestException } from '@nestjs/common';
import { RunStatus, StageStatus, StageType } from '@prisma/client';

/**
 * Defines the valid stage ordering for the settlement pipeline.
 * Stages must complete in this order; a failing stage blocks all downstream stages.
 */
export const STAGE_ORDER: StageType[] = [
  StageType.INGEST,
  StageType.CALC,
  StageType.SETTLEMENT,
];

/**
 * Valid RunStatus transitions.
 * Key = current status; Value = set of allowed next statuses.
 */
const RUN_TRANSITIONS: Record<RunStatus, Set<RunStatus>> = {
  [RunStatus.PENDING]: new Set([RunStatus.PROCESSING, RunStatus.FAILED]),
  [RunStatus.PROCESSING]: new Set([RunStatus.COMPLETED, RunStatus.FAILED, RunStatus.BLOCKED]),
  [RunStatus.FAILED]: new Set([RunStatus.RETRYING]),
  [RunStatus.BLOCKED]: new Set([RunStatus.RETRYING]),
  [RunStatus.RETRYING]: new Set([RunStatus.PROCESSING, RunStatus.FAILED, RunStatus.COMPLETED]),
  [RunStatus.COMPLETED]: new Set(), // terminal
};

/**
 * Valid StageStatus transitions.
 */
const STAGE_TRANSITIONS: Record<StageStatus, Set<StageStatus>> = {
  [StageStatus.PENDING]: new Set([StageStatus.PROCESSING, StageStatus.BLOCKED, StageStatus.SKIPPED]),
  [StageStatus.PROCESSING]: new Set([StageStatus.COMPLETED, StageStatus.FAILED]),
  [StageStatus.FAILED]: new Set([StageStatus.PENDING]), // reset on retry
  [StageStatus.BLOCKED]: new Set([StageStatus.PENDING]), // unblocked on retry
  [StageStatus.SKIPPED]: new Set([StageStatus.PENDING]),
  [StageStatus.COMPLETED]: new Set(), // terminal
};

export class PipelineStateMachine {
  /**
   * Returns the next valid RunStatus or throws if the transition is invalid.
   */
  static transitionRun(current: RunStatus, next: RunStatus): RunStatus {
    const allowed = RUN_TRANSITIONS[current];
    if (!allowed || !allowed.has(next)) {
      throw new BadRequestException(
        `Invalid run status transition: ${current} → ${next}`,
      );
    }
    return next;
  }

  /**
   * Returns the next valid StageStatus or throws if the transition is invalid.
   */
  static transitionStage(current: StageStatus, next: StageStatus): StageStatus {
    const allowed = STAGE_TRANSITIONS[current];
    if (!allowed || !allowed.has(next)) {
      throw new BadRequestException(
        `Invalid stage status transition: ${current} → ${next}`,
      );
    }
    return next;
  }

  /**
   * Given a stage that has failed, returns all downstream stage types that
   * must be blocked.
   */
  static getDownstreamStages(failedStage: StageType): StageType[] {
    const index = STAGE_ORDER.indexOf(failedStage);
    if (index === -1) return [];
    return STAGE_ORDER.slice(index + 1);
  }

  /**
   * Determines the overall RunStatus from the collection of stage statuses.
   */
  static deriveRunStatus(stageStatuses: StageStatus[]): RunStatus {
    if (stageStatuses.every((s) => s === StageStatus.COMPLETED)) {
      return RunStatus.COMPLETED;
    }
    if (stageStatuses.some((s) => s === StageStatus.FAILED)) {
      return RunStatus.FAILED;
    }
    if (stageStatuses.some((s) => s === StageStatus.BLOCKED)) {
      return RunStatus.BLOCKED;
    }
    if (stageStatuses.some((s) => s === StageStatus.PROCESSING)) {
      return RunStatus.PROCESSING;
    }
    return RunStatus.PENDING;
  }
}
