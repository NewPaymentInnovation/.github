/**
 * AWS Lambda handler for the settle-processing NestJS service.
 * Uses a serverless-http adapter to wrap the Express app.
 *
 * Install: npm install serverless-http @types/aws-lambda
 */
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ExpressAdapter } from '@nestjs/platform-express';
import * as express from 'express';
import * as serverlessHttp from 'serverless-http';
import { AppModule } from './app.module';

let cachedHandler: any;

async function bootstrap() {
  const expressApp = express();
  const adapter = new ExpressAdapter(expressApp);

  const app = await NestFactory.create(AppModule, adapter);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.init();
  return serverlessHttp(expressApp);
}

export const handler = async (event: any, context: any) => {
  if (!cachedHandler) {
    cachedHandler = await bootstrap();
  }
  return cachedHandler(event, context);
};
