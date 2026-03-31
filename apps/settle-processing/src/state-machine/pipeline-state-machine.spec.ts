import { BadRequestException } from '@nestjs/common';
import { RunStatus, StageStatus, StageType } from '@prisma/client';
import { PipelineStateMachine, STAGE_ORDER } from './pipeline-state-machine';

describe('PipelineStateMachine', () => {
  describe('transitionRun', () => {
    it('should allow PENDING → PROCESSING', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.PENDING, RunStatus.PROCESSING)).toBe(RunStatus.PROCESSING);
    });

    it('should allow PROCESSING → COMPLETED', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.PROCESSING, RunStatus.COMPLETED)).toBe(RunStatus.COMPLETED);
    });

    it('should allow PROCESSING → FAILED', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.PROCESSING, RunStatus.FAILED)).toBe(RunStatus.FAILED);
    });

    it('should allow PROCESSING → BLOCKED', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.PROCESSING, RunStatus.BLOCKED)).toBe(RunStatus.BLOCKED);
    });

    it('should allow FAILED → RETRYING', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.FAILED, RunStatus.RETRYING)).toBe(RunStatus.RETRYING);
    });

    it('should allow BLOCKED → RETRYING', () => {
      expect(PipelineStateMachine.transitionRun(RunStatus.BLOCKED, RunStatus.RETRYING)).toBe(RunStatus.RETRYING);
    });

    it('should throw for invalid transition COMPLETED → PROCESSING', () => {
      expect(() =>
        PipelineStateMachine.transitionRun(RunStatus.COMPLETED, RunStatus.PROCESSING),
      ).toThrow(BadRequestException);
    });

    it('should throw for invalid transition PENDING → COMPLETED', () => {
      expect(() =>
        PipelineStateMachine.transitionRun(RunStatus.PENDING, RunStatus.COMPLETED),
      ).toThrow(BadRequestException);
    });
  });

  describe('transitionStage', () => {
    it('should allow PENDING → PROCESSING', () => {
      expect(PipelineStateMachine.transitionStage(StageStatus.PENDING, StageStatus.PROCESSING)).toBe(StageStatus.PROCESSING);
    });

    it('should allow PROCESSING → COMPLETED', () => {
      expect(PipelineStateMachine.transitionStage(StageStatus.PROCESSING, StageStatus.COMPLETED)).toBe(StageStatus.COMPLETED);
    });

    it('should allow PROCESSING → FAILED', () => {
      expect(PipelineStateMachine.transitionStage(StageStatus.PROCESSING, StageStatus.FAILED)).toBe(StageStatus.FAILED);
    });

    it('should allow PENDING → BLOCKED', () => {
      expect(PipelineStateMachine.transitionStage(StageStatus.PENDING, StageStatus.BLOCKED)).toBe(StageStatus.BLOCKED);
    });

    it('should throw for invalid transition COMPLETED → FAILED', () => {
      expect(() =>
        PipelineStateMachine.transitionStage(StageStatus.COMPLETED, StageStatus.FAILED),
      ).toThrow(BadRequestException);
    });
  });

  describe('getDownstreamStages', () => {
    it('should return CALC and SETTLEMENT when INGEST fails', () => {
      const downstream = PipelineStateMachine.getDownstreamStages(StageType.INGEST);
      expect(downstream).toEqual([StageType.CALC, StageType.SETTLEMENT]);
    });

    it('should return only SETTLEMENT when CALC fails', () => {
      const downstream = PipelineStateMachine.getDownstreamStages(StageType.CALC);
      expect(downstream).toEqual([StageType.SETTLEMENT]);
    });

    it('should return empty array when SETTLEMENT fails (last stage)', () => {
      const downstream = PipelineStateMachine.getDownstreamStages(StageType.SETTLEMENT);
      expect(downstream).toEqual([]);
    });
  });

  describe('deriveRunStatus', () => {
    it('should return COMPLETED when all stages are COMPLETED', () => {
      const statuses = [StageStatus.COMPLETED, StageStatus.COMPLETED, StageStatus.COMPLETED];
      expect(PipelineStateMachine.deriveRunStatus(statuses)).toBe(RunStatus.COMPLETED);
    });

    it('should return FAILED when any stage is FAILED', () => {
      const statuses = [StageStatus.COMPLETED, StageStatus.FAILED, StageStatus.BLOCKED];
      expect(PipelineStateMachine.deriveRunStatus(statuses)).toBe(RunStatus.FAILED);
    });

    it('should return BLOCKED when no stage is FAILED but some are BLOCKED', () => {
      const statuses = [StageStatus.COMPLETED, StageStatus.BLOCKED, StageStatus.BLOCKED];
      expect(PipelineStateMachine.deriveRunStatus(statuses)).toBe(RunStatus.BLOCKED);
    });

    it('should return PROCESSING when some stage is PROCESSING', () => {
      const statuses = [StageStatus.PROCESSING, StageStatus.PENDING, StageStatus.PENDING];
      expect(PipelineStateMachine.deriveRunStatus(statuses)).toBe(RunStatus.PROCESSING);
    });

    it('should return PENDING when all stages are PENDING', () => {
      const statuses = [StageStatus.PENDING, StageStatus.PENDING, StageStatus.PENDING];
      expect(PipelineStateMachine.deriveRunStatus(statuses)).toBe(RunStatus.PENDING);
    });
  });

  describe('STAGE_ORDER', () => {
    it('should define the correct ordered pipeline stages', () => {
      expect(STAGE_ORDER).toEqual([StageType.INGEST, StageType.CALC, StageType.SETTLEMENT]);
    });
  });
});
