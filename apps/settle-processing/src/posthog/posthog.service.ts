import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostHog } from 'posthog-node';

export const POSTHOG_EVENTS = {
  // Upload / batch creation
  BATCH_CREATED: 'settle.batch.created',

  // Stage transitions
  STAGE_STARTED: 'settle.stage.started',
  STAGE_COMPLETED: 'settle.stage.completed',
  STAGE_FAILED: 'settle.stage.failed',
  STAGE_BLOCKED: 'settle.stage.blocked',

  // Run transitions
  RUN_STARTED: 'settle.run.started',
  RUN_COMPLETED: 'settle.run.completed',
  RUN_FAILED: 'settle.run.failed',

  // Retry
  RETRY_INITIATED: 'settle.retry.initiated',
  RETRY_COMPLETED: 'settle.retry.completed',
  RETRY_FAILED: 'settle.retry.failed',

  // Errors
  PIPELINE_ERROR: 'settle.pipeline.error',
} as const;

export type PosthogEventName = (typeof POSTHOG_EVENTS)[keyof typeof POSTHOG_EVENTS];

@Injectable()
export class PosthogService implements OnModuleDestroy {
  private readonly logger = new Logger(PosthogService.name);
  private readonly client: PostHog | null;
  private readonly distinctId = 'settle-processing-service';

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.get<string>('app.posthog.apiKey');
    const host = this.configService.get<string>('app.posthog.host');

    if (apiKey) {
      this.client = new PostHog(apiKey, { host });
      this.logger.log('PostHog client initialised');
    } else {
      this.client = null;
      this.logger.warn('PostHog API key not configured – events will be skipped');
    }
  }

  /**
   * Capture an event. Fire-and-forget; errors are swallowed so they never
   * disrupt the primary pipeline flow.
   */
  capture(event: PosthogEventName, properties: Record<string, unknown> = {}): void {
    if (!this.client) return;

    try {
      this.client.capture({
        distinctId: this.distinctId,
        event,
        properties: {
          service: 'settle-processing',
          environment: process.env.NODE_ENV ?? 'development',
          timestamp: new Date().toISOString(),
          ...properties,
        },
      });
    } catch (error) {
      this.logger.error(`PostHog capture failed for event "${event}"`, error);
    }
  }

  async onModuleDestroy() {
    if (this.client) {
      await this.client.shutdown();
    }
  }
}
