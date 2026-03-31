import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PipelineRunService } from './pipeline-run.service';
import { PrismaService } from '../common/prisma/prisma.service';
import { PosthogService } from '../posthog/posthog.service';
import { RunStatus, StageStatus, StageType } from '@prisma/client';

const mockStage = (stageType: StageType, status: StageStatus = StageStatus.PENDING) => ({
  id: `stage-${stageType}`,
  stageType,
  status,
  executionRef: 'batch-uuid-1',
  runId: 'run-uuid-1',
  retryAttemptId: null,
  sqsMessageId: null,
  errorPayload: null,
  metadata: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const mockRun = {
  id: 'run-uuid-1',
  batchId: 'batch-uuid-1',
  executionRef: 'batch-uuid-1',
  status: RunStatus.PROCESSING,
  fileName: 'settlement.csv',
  s3Key: 'settlements/settlement.csv',
  s3Bucket: 'settle-processing-uploads',
  metadata: {},
  errorPayload: null,
  startedAt: new Date(),
  completedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  retries: [],
};

describe('PipelineRunService', () => {
  let service: PipelineRunService;
  let prisma: jest.Mocked<PrismaService>;
  let posthog: jest.Mocked<PosthogService>;

  beforeEach(async () => {
    const mockPrisma = {
      pipelineRun: {
        create: jest.fn(),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        count: jest.fn(),
      },
      pipelineStage: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      retryAttempt: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      stateTransitionLog: {
        create: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const mockPosthog = { capture: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PipelineRunService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: PosthogService, useValue: mockPosthog },
      ],
    }).compile();

    service = module.get<PipelineRunService>(PipelineRunService);
    prisma = module.get(PrismaService);
    posthog = module.get(PosthogService);
  });

  afterEach(() => jest.clearAllMocks());

  describe('createRun', () => {
    it('should create a pipeline run with all stages PENDING', async () => {
      const createdRun = {
        ...mockRun,
        status: RunStatus.PENDING,
        stages: [
          mockStage(StageType.INGEST),
          mockStage(StageType.CALC),
          mockStage(StageType.SETTLEMENT),
        ],
      };

      (prisma.pipelineRun.create as jest.Mock).mockResolvedValue(createdRun);
      (prisma.stateTransitionLog.create as jest.Mock).mockResolvedValue({});

      const result = await service.createRun({
        batchId: 'batch-uuid-1',
        fileName: 'settlement.csv',
        s3Key: 'settlements/settlement.csv',
        s3Bucket: 'settle-processing-uploads',
      });

      expect(result.status).toBe(RunStatus.PENDING);
      expect(prisma.pipelineRun.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RunStatus.PENDING,
            fileName: 'settlement.csv',
          }),
        }),
      );
      expect(posthog.capture).toHaveBeenCalledWith(
        'settle.batch.created',
        expect.objectContaining({ fileName: 'settlement.csv' }),
      );
    });
  });

  describe('retryRun', () => {
    it('should throw BadRequestException when run is not FAILED or BLOCKED', async () => {
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue({
        ...mockRun,
        status: RunStatus.COMPLETED,
        retries: [],
      });

      await expect(service.retryRun('run-uuid-1')).rejects.toThrow(BadRequestException);
    });

    it('should throw NotFoundException when run does not exist', async () => {
      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.retryRun('non-existent-id')).rejects.toThrow(NotFoundException);
    });

    it('should create a retry attempt with incremented attempt number', async () => {
      const failedRun = {
        ...mockRun,
        status: RunStatus.FAILED,
        retries: [{ attemptNumber: 1, retryId: 'retry-1' }],
      };

      const retryAttempt = {
        id: 'retry-attempt-2',
        retryId: 'retry-uuid-2',
        executionRef: 'retry-uuid-2',
        priorRef: 'batch-uuid-1',
        runId: 'run-uuid-1',
        attemptNumber: 2,
        status: RunStatus.RETRYING,
        errorPayload: null,
        startedAt: new Date(),
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        stages: [],
      };

      (prisma.pipelineRun.findUnique as jest.Mock).mockResolvedValue(failedRun);
      (prisma.$transaction as jest.Mock).mockResolvedValue(retryAttempt);
      (prisma.stateTransitionLog.create as jest.Mock).mockResolvedValue({});
      (prisma.pipelineStage.findFirst as jest.Mock).mockResolvedValue(null);

      const result = await service.retryRun('run-uuid-1', 'test retry');

      expect(result.attemptNumber).toBe(2);
      expect(result.priorRef).toBe('batch-uuid-1');
      expect(posthog.capture).toHaveBeenCalledWith(
        'settle.retry.initiated',
        expect.objectContaining({ attemptNumber: 2, reason: 'test retry' }),
      );
    });
  });

  describe('listRuns', () => {
    it('should return paginated runs', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([[mockRun], 1]);

      const result = await service.listRuns({ page: 1, limit: 10 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('should apply status filter', async () => {
      (prisma.$transaction as jest.Mock).mockResolvedValue([[], 0]);

      await service.listRuns({ status: RunStatus.FAILED, page: 1, limit: 10 });

      expect(prisma.$transaction).toHaveBeenCalled();
    });
  });
});
