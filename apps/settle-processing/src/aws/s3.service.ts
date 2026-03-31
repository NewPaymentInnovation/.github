import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { Readable } from 'stream';

@Injectable()
export class S3Service {
  private readonly logger = new Logger(S3Service.name);
  private readonly client: S3Client;
  private readonly bucketName: string;

  constructor(private readonly configService: ConfigService) {
    this.client = new S3Client({
      region: this.configService.get<string>('app.aws.region') ?? 'eu-west-1',
    });
    this.bucketName =
      this.configService.get<string>('app.aws.s3.bucketName') ?? 'settle-processing-uploads';
  }

  /**
   * Upload a file buffer to S3 and return the resulting S3 key.
   */
  async uploadFile(
    key: string,
    buffer: Buffer,
    contentType: string = 'application/octet-stream',
    metadata: Record<string, string> = {},
  ): Promise<{ bucket: string; key: string; etag: string }> {
    this.logger.log(`Uploading file to S3: s3://${this.bucketName}/${key}`);

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.bucketName,
        Key: key,
        Body: buffer,
        ContentType: contentType,
        Metadata: metadata,
      },
    });

    const result = await upload.done();
    this.logger.log(`File uploaded successfully: ${key}`);

    return {
      bucket: this.bucketName,
      key,
      etag: result.ETag ?? '',
    };
  }

  /**
   * Check whether an object exists in S3.
   */
  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucketName, Key: key }),
      );
      return true;
    } catch {
      return false;
    }
  }

  getBucketName(): string {
    return this.bucketName;
  }
}
