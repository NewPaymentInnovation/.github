import { Global, Module } from '@nestjs/common';
import { S3Service } from './s3.service';
import { SqsService } from './sqs.service';

@Global()
@Module({
  providers: [S3Service, SqsService],
  exports: [S3Service, SqsService],
})
export class AwsModule {}
