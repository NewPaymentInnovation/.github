import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class UploadSettlementDto {
  @ApiPropertyOptional({
    description: 'Optional JSON metadata to attach to this batch',
    example: '{"source":"manual","operator":"john.doe@example.com"}',
  })
  @IsOptional()
  @IsString()
  metadata?: string;
}
