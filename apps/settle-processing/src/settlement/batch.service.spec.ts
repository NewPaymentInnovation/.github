import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { BatchService } from './batch.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { RunStatus, StageStatus, StageType } from '@prisma/client';

const makeStage = (stageType: StageType, status: StageStatus, executionRef = 'batch-1') => ({
  id: `stage-${stageType}`,
  stageType,
  status,
  executionRef,
  runId: 'run-1',
  retryAttemptId: null,
  sqsMessageId: null,
  errorPayload: null,
  metadata: null,
  startedAt: new Date('2026-01-01T10:00:00Z'),
  completedAt: new Date('2026-01-01T10:01:00Z'),
  createdAt: new Date('2026-01-01T10:00:00Z'),
  updatedAt: new Date('2026-01-01T10:01:00Z'),
});

const mockBatch = {
  id: 'run-1',
  batchId: 'batch-1',
  executionRef: 'retry-1',
  status: RunStatus.COMPLETED,
  fileName: 'settlement.csv',
  s3Key: 'settlements/settlement.csv',
  s3Bucket: 'settle-processing-uploads',
  metadata: {},
  errorPayload: null,
  startedAt: new Date('2026-01-01T10:00:00Z'),
  completedAt: new Date('2026-01-01T10:05:00Z'),
  createdAt: new Date('2026-01-01T09:59:00Z'),
  updatedAt: new Date('2026-01-01T10:05:00Z'),
  stages: [
    makeStage(StageType.INGEST, StageStatus.COMPLETED),
  ],
  retries: [
    {
      id: 'retry-attempt-1',
      retryId: 'retry-1',
      executionRef: 'retry-1',
      priorRef: 'batch-1',
      runId: 'run-1',
      attemptNumber: 1,
      status: RunStatus.COMPLETED,
      errorPayload: null,
      startedAt: new Date('2026-01-01T10:02:00Z'),
      completedAt: new Date('2026-01-01T10:05:00Z'),
      createdAt: new Date('2026-01-01T10:02:00Z'),
      updatedAt: new Date('2026-01-01T10:05:00Z'),
      stages: [
        makeStage(StageType.CALC, StageStatus.COMPLETED, 'retry-1'),
        makeStage(StageType.SETTLEMENT, StageStatus.COMPLETED, 'retry-1'),
      ],
    },
  ],
};

describe('BatchService', () => {
  let service: BatchService;
  let prisma: jest.Mocked<PrismaService>;

  beforeEach(async () => {
    const mockPrisma = {
      pipelineRun: {
        findUnique: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BatchService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<BatchService>(BatchService);
    prisma = module.get(PrismaService);
  });

  describe('getBatchById', () => {
    it('should return batch with stages and retries', async () => {
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue(mockBatch);

      const result = await service.getBatchById('batch-1');

      expect(result.batchId).toBe('batch-1');
      expect(result.stages).toHaveLength(1);
      expect(result.retries).toHaveLength(1);
    });

    it('should throw NotFoundException when batch does not exist', async () => {
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.getBatchById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('buildTimeline', () => {
    it('should produce a flattened chronological timeline', () => {
      const timeline = service.buildTimeline(mockBatch as any);

      expect(timeline.length).toBe(3); // 1 initial + 2 retry stages
    });

    it('should label initial stages as phase "initial"', () => {
      const timeline = service.buildTimeline(mockBatch as any) as any[];
      const initialStages = timeline.filter((t) => t.phase === 'initial');
      expect(initialStages.length).toBe(1);
    });

    it('should label retry stages with the correct attempt number', () => {
      const timeline = service.buildTimeline(mockBatch as any) as any[];
      const retryStages = timeline.filter((t) => t.phase === 'retry-1');
      expect(retryStages.length).toBe(2);
    });

    it('should include retryId on retry stages', () => {
      const timeline = service.buildTimeline(mockBatch as any) as any[];
      const retryStage = timeline.find((t: any) => t.phase === 'retry-1');
      expect(retryStage?.retryId).toBe('retry-1');
      expect(retryStage?.priorRef).toBe('batch-1');
    });
  });
});
