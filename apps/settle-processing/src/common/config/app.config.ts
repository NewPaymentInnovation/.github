import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  port: parseInt(process.env.PORT ?? '3000', 10),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  database: {
    url: process.env.SETTLE_PROCESSING_DATABASE_URL,
  },
  aws: {
    region: process.env.AWS_REGION ?? 'eu-west-1',
    s3: {
      bucketName: process.env.S3_BUCKET_NAME ?? 'settle-processing-uploads',
    },
    sqs: {
      ingestQueueUrl: process.env.SQS_INGEST_QUEUE_URL ?? '',
      calcQueueUrl: process.env.SQS_CALC_QUEUE_URL ?? '',
      dlqUrl: process.env.SQS_DLQ_URL ?? '',
    },
  },
  posthog: {
    apiKey: process.env.POSTHOG_API_KEY ?? '',
    host: process.env.POSTHOG_HOST ?? 'https://app.posthog.com',
  },
}));
