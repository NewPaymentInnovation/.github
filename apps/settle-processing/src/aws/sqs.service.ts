import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  SQSClient,
  SendMessageCommand,
  GetQueueAttributesCommand,
} from '@aws-sdk/client-sqs';

export interface SqsMessageBody {
  batchId: string;
  executionRef: string;
  s3Bucket: string;
  s3Key: string;
  stageType: string;
  metadata?: Record<string, unknown>;
}

export interface QueueAttributes {
  approximateNumberOfMessages: number;
  approximateNumberOfMessagesNotVisible: number;
  approximateNumberOfMessagesDelayed: number;
}

@Injectable()
export class SqsService {
  private readonly logger = new Logger(SqsService.name);
  private readonly client: SQSClient;
  private readonly ingestQueueUrl: string;
  private readonly calcQueueUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new SQSClient({
      region: this.configService.get<string>('app.aws.region') ?? 'eu-west-1',
    });
    this.ingestQueueUrl =
      this.configService.get<string>('app.aws.sqs.ingestQueueUrl') ?? '';
    this.calcQueueUrl =
      this.configService.get<string>('app.aws.sqs.calcQueueUrl') ?? '';
  }

  /**
   * Publish a message to the ingest SQS queue.
   */
  async publishToIngestQueue(body: SqsMessageBody): Promise<string> {
    return this.sendMessage(this.ingestQueueUrl, body);
  }

  /**
   * Publish a message to the calc SQS queue.
   */
  async publishToCalcQueue(body: SqsMessageBody): Promise<string> {
    return this.sendMessage(this.calcQueueUrl, body);
  }

  private async sendMessage(queueUrl: string, body: SqsMessageBody): Promise<string> {
    this.logger.log(`Publishing SQS message to queue: ${queueUrl}`);

    const command = new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(body),
      MessageAttributes: {
        batchId: {
          DataType: 'String',
          StringValue: body.batchId,
        },
        executionRef: {
          DataType: 'String',
          StringValue: body.executionRef,
        },
        stageType: {
          DataType: 'String',
          StringValue: body.stageType,
        },
      },
    });

    const result = await this.client.send(command);
    const messageId = result.MessageId ?? '';
    this.logger.log(`SQS message sent, MessageId=${messageId}`);
    return messageId;
  }

  /**
   * Retrieve approximate queue depth metrics for observability.
   */
  async getQueueAttributes(queueUrl: string): Promise<QueueAttributes> {
    const command = new GetQueueAttributesCommand({
      QueueUrl: queueUrl,
      AttributeNames: [
        'ApproximateNumberOfMessages',
        'ApproximateNumberOfMessagesNotVisible',
        'ApproximateNumberOfMessagesDelayed',
      ],
    });

    const result = await this.client.send(command);
    const attrs = result.Attributes ?? {};

    return {
      approximateNumberOfMessages: parseInt(
        attrs['ApproximateNumberOfMessages'] ?? '0',
        10,
      ),
      approximateNumberOfMessagesNotVisible: parseInt(
        attrs['ApproximateNumberOfMessagesNotVisible'] ?? '0',
        10,
      ),
      approximateNumberOfMessagesDelayed: parseInt(
        attrs['ApproximateNumberOfMessagesDelayed'] ?? '0',
        10,
      ),
    };
  }

  getIngestQueueUrl(): string {
    return this.ingestQueueUrl;
  }

  getCalcQueueUrl(): string {
    return this.calcQueueUrl;
  }
}
