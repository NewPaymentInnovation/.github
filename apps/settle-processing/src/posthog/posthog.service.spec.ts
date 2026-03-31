import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { PosthogService, POSTHOG_EVENTS } from './posthog.service';

// Mock posthog-node
jest.mock('posthog-node', () => ({
  PostHog: jest.fn().mockImplementation(() => ({
    capture: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

describe('PosthogService', () => {
  let service: PosthogService;

  const mockConfigWithKey = {
    get: jest.fn((key: string) => {
      if (key === 'app.posthog.apiKey') return 'test-api-key';
      if (key === 'app.posthog.host') return 'https://app.posthog.com';
      return null;
    }),
  };

  const mockConfigWithoutKey = {
    get: jest.fn((key: string) => {
      if (key === 'app.posthog.apiKey') return '';
      return null;
    }),
  };

  describe('with valid API key', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PosthogService,
          { provide: ConfigService, useValue: mockConfigWithKey },
        ],
      }).compile();

      service = module.get<PosthogService>(PosthogService);
    });

    it('should be defined', () => {
      expect(service).toBeDefined();
    });

    it('should call capture without throwing', () => {
      expect(() =>
        service.capture(POSTHOG_EVENTS.BATCH_CREATED, { batchId: 'test-batch' }),
      ).not.toThrow();
    });

    it('should call shutdown on module destroy', async () => {
      await expect(service.onModuleDestroy()).resolves.not.toThrow();
    });
  });

  describe('without API key', () => {
    beforeEach(async () => {
      const module: TestingModule = await Test.createTestingModule({
        providers: [
          PosthogService,
          { provide: ConfigService, useValue: mockConfigWithoutKey },
        ],
      }).compile();

      service = module.get<PosthogService>(PosthogService);
    });

    it('should not throw when capturing without client', () => {
      expect(() => service.capture(POSTHOG_EVENTS.PIPELINE_ERROR)).not.toThrow();
    });
  });
});
