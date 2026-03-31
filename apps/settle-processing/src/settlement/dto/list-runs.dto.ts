import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { RunStatus } from '@prisma/client';

export class ListRunsDto {
  @ApiPropertyOptional({
    description: 'Filter by run status',
    enum: RunStatus,
  })
  @IsOptional()
  @IsEnum(RunStatus)
  status?: RunStatus;

  @ApiPropertyOptional({
    description: 'Filter runs created on or after this ISO date',
    example: '2026-01-01T00:00:00Z',
  })
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional({
    description: 'Filter runs created on or before this ISO date',
    example: '2026-12-31T23:59:59Z',
  })
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ description: 'Page number (1-based)', default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ description: 'Number of results per page', default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
