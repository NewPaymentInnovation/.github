import { Module } from '@nestjs/common';
import { SettlementController } from './settlement.controller';
import { SettlementService } from './settlement.service';
import { BatchService } from './batch.service';
import { PipelineRunService } from './pipeline-run.service';
import { AwsModule } from '../aws/aws.module';

@Module({
  imports: [AwsModule],
  controllers: [SettlementController],
  providers: [SettlementService, BatchService, PipelineRunService],
  exports: [SettlementService, BatchService, PipelineRunService],
})
export class SettlementModule {}
