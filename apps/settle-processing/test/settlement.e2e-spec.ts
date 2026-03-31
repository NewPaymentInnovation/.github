import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

/**
 * E2E integration tests for the settlement pipeline API.
 * These tests require a running database. Use a test database configured
 * via SETTLE_PROCESSING_DATABASE_URL environment variable.
 *
 * Run with: npm run test:e2e
 */
describe('SettlementController (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /settlement/upload', () => {
    it('should accept a file upload and return a batchId', async () => {
      const response = await request(app.getHttpServer())
        .post('/settlement/upload')
        .attach('file', Buffer.from('col1,col2\nval1,val2'), 'settlement.csv')
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.batchId).toBeDefined();
      expect(response.body.executionRef).toBe(response.body.batchId);
      expect(response.body.status).toBeDefined();
    });
  });

  describe('GET /settlement/runs', () => {
    it('should return a paginated list of runs', async () => {
      const response = await request(app.getHttpServer())
        .get('/settlement/runs')
        .query({ page: 1, limit: 10 })
        .expect(200);

      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('total');
      expect(response.body).toHaveProperty('page');
      expect(Array.isArray(response.body.data)).toBe(true);
    });

    it('should filter runs by status', async () => {
      const response = await request(app.getHttpServer())
        .get('/settlement/runs')
        .query({ status: 'PENDING' })
        .expect(200);

      expect(Array.isArray(response.body.data)).toBe(true);
    });
  });

  describe('GET /settlement/batches/:id', () => {
    it('should return 404 for a non-existent batch', async () => {
      await request(app.getHttpServer())
        .get('/settlement/batches/non-existent-batch-id')
        .expect(404);
    });
  });

  describe('POST /settlement/runs/:id/retry', () => {
    it('should return 400 for invalid UUID format', async () => {
      await request(app.getHttpServer())
        .post('/settlement/runs/not-a-uuid/retry')
        .send({ reason: 'test' })
        .expect(400);
    });

    it('should return 404 for a non-existent run', async () => {
      await request(app.getHttpServer())
        .post('/settlement/runs/00000000-0000-0000-0000-000000000000/retry')
        .send({ reason: 'test' })
        .expect(404);
    });
  });
});
