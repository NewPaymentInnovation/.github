import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class RetryRunDto {
  @ApiPropertyOptional({
    description: 'Optional reason for initiating this retry',
    example: 'Manual retry after SQS timeout',
  })
  @IsOptional()
  @IsString()
  reason?: string;
}
