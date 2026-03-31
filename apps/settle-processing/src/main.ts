import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  // Swagger / OpenAPI documentation
  const config = new DocumentBuilder()
    .setTitle('Settle Processing API')
    .setDescription(
      'Orchestration and observability hub for the settlement pipeline. ' +
        'Provides a single pane of glass for queue health, batch tracking, and stage management.',
    )
    .setVersion('1.0')
    .addTag('settlement')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);
  logger.log(`settle-processing service running on port ${port}`);
  logger.log(`Swagger docs available at http://localhost:${port}/api`);
}

bootstrap();
