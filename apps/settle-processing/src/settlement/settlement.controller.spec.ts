import { Test, TestingModule } from '@nestjs/testing';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { BatchService } from './batch.service';
import { PipelineRunService } from './pipeline-run.service';
import { RunStatus, StageStatus, StageType } from '@prisma/client';

const mockRun = {
  id: 'run-uuid-1',
  batchId: 'batch-uuid-1',
  executionRef: 'batch-uuid-1',
  status: RunStatus.PENDING,
  fileName: 'settlement.csv',
  s3Key: 'settlements/2026/settlement.csv',
  s3Bucket: 'settle-processing-uploads',
  metadata: {},
  errorPayload: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  stages: [
    { id: 'stage-1', stageType: StageType.INGEST, status: StageStatus.PROCESSING, executionRef: 'batch-uuid-1', runId: 'run-uuid-1', retryAttemptId: null, sqsMessageId: null, errorPayload: null, metadata: null, startedAt: new Date(), completedAt: null, createdAt: new Date(), updatedAt: new Date() },
  ],
  retries: [],
};

const mockSettlementService = {
  uploadSettlementFile: jest.fn().mockResolvedValue(mockRun),
  retryRun: jest.fn().mockResolvedValue({
    id: 'retry-attempt-1',
    retryId: 'retry-uuid-1',
    executionRef: 'retry-uuid-1',
    priorRef: 'batch-uuid-1',
    runId: 'run-uuid-1',
    attemptNumber: 1,
    status: RunStatus.RETRYING,
    createdAt: new Date(),
    updatedAt: new Date(),
  }),
};

const mockBatchService = {
  getBatchById: jest.fn().mockResolvedValue({ ...mockRun, retries: [] }),
  buildTimeline: jest.fn().mockReturnValue([]),
};

const mockPipelineRunService = {
  listRuns: jest.fn().mockResolvedValue({
    data: [mockRun],
    total: 1,
    page: 1,
    limit: 20,
  }),
};

describe('SettlementController', () => {
  let controller: SettlementController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettlementController],
      providers: [
        { provide: SettlementService, useValue: mockSettlementService },
        { provide: BatchService, useValue: mockBatchService },
        { provide: PipelineRunService, useValue: mockPipelineRunService },
      ],
    }).compile();

    controller = module.get<SettlementController>(SettlementController);
  });

  afterEach(() => jest.clearAllMocks());

  describe('POST /settlement/upload', () => {
    it('should upload a file and return batch info', async () => {
      const mockFile = {
        originalname: 'settlement.csv',
        buffer: Buffer.from('data'),
        mimetype: 'text/csv',
      } as Express.Multer.File;

      const result = await controller.uploadSettlementFile(mockFile, { metadata: undefined });

      expect(result.batchId).toBe('batch-uuid-1');
      expect(result.status).toBe(RunStatus.PENDING);
      expect(mockSettlementService.uploadSettlementFile).toHaveBeenCalledWith(mockFile, undefined);
    });

    it('should parse metadata JSON when provided', async () => {
      const mockFile = { originalname: 'settlement.csv', buffer: Buffer.from('data'), mimetype: 'text/csv' } as Express.Multer.File;
      await controller.uploadSettlementFile(mockFile, { metadata: '{"source":"manual"}' });
      expect(mockSettlementService.uploadSettlementFile).toHaveBeenCalledWith(mockFile, { source: 'manual' });
    });
  });

  describe('GET /settlement/batches/:id', () => {
    it('should return batch details with timeline', async () => {
      const result = await controller.getBatch('batch-uuid-1');

      expect(result.batchId).toBe('batch-uuid-1');
      expect(result.timeline).toEqual([]);
      expect(mockBatchService.getBatchById).toHaveBeenCalledWith('batch-uuid-1');
      expect(mockBatchService.buildTimeline).toHaveBeenCalled();
    });
  });

  describe('GET /settlement/runs', () => {
    it('should return paginated runs list', async () => {
      const result = await controller.listRuns({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(mockPipelineRunService.listRuns).toHaveBeenCalledWith({
        status: undefined,
        fromDate: undefined,
        toDate: undefined,
        page: 1,
        limit: 20,
      });
    });
  });

  describe('POST /settlement/runs/:id/retry', () => {
    it('should initiate a retry and return retry details', async () => {
      const result = await controller.retryRun('run-uuid-1', { reason: 'Manual retry' });

      expect(result.retryId).toBe('retry-uuid-1');
      expect(result.priorRef).toBe('batch-uuid-1');
      expect(result.attemptNumber).toBe(1);
      expect(mockSettlementService.retryRun).toHaveBeenCalledWith('run-uuid-1', 'Manual retry');
    });
  });
});
