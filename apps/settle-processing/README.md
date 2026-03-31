# settle-processing

**Orchestration and observability hub for the Infinite settlement pipeline.**

`settle-processing` is a NestJS service that acts as the single pane of glass for the end-to-end settlement lifecycle. It introduces a schedule-driven, state-machine-controlled model to ensure that file ingestion (`settle-ingest`), fee processing (`settle-calc`), and account settlement occur in the correct chronological order with full awareness of upstream dependencies.

---

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Pipeline Stages](#pipeline-stages)
- [Batch ID & Retry ID Lineage](#batch-id--retry-id-lineage)
- [State Machine](#state-machine)
- [REST API](#rest-api)
- [Local Development Setup](#local-development-setup)
- [Running Tests](#running-tests)
- [Bruno API Tests](#bruno-api-tests)
- [PostHog Event Tracking](#posthog-event-tracking)
- [AWS Deployment](#aws-deployment)

---

## Architecture Overview

```
Settlement File (S3)
        │
        ▼
POST /settlement/upload ──► PipelineRun (PENDING) ──► SQS: settle-ingest
                                    │
                                    ▼
                           INGEST Stage (PROCESSING)
                                    │
                            ┌───────┴───────┐
                         SUCCESS          FAILURE
                            │                │
                            ▼                ▼
                   CALC Stage (PENDING)   CALC Stage (BLOCKED)
                            │             SETTLEMENT Stage (BLOCKED)
                         SUCCESS          Run Status → FAILED
                            │
                            ▼
                  SETTLEMENT Stage (PENDING)
                            │
                         SUCCESS
                            │
                            ▼
                     Run Status → COMPLETED
```

---

## Pipeline Stages

Stages execute in strict sequence:

| Order | Stage        | Description                                      |
|-------|--------------|--------------------------------------------------|
| 1     | `INGEST`     | File ingestion via `settle-ingest` SQS consumer  |
| 2     | `CALC`       | Fee calculation via `settle-calc` SQS consumer   |
| 3     | `SETTLEMENT` | Account settlement and ledger posting            |

If any stage **fails**, all downstream stages are automatically set to **BLOCKED** and the run status becomes **FAILED/BLOCKED**. No downstream processing occurs until a retry is initiated.

---

## Batch ID & Retry ID Lineage

### First Upload

```
batchId      = <new UUID>          (assigned at upload; never changes)
executionRef = batchId             (active reference for this run)
```

### First Retry

```
retryId      = <new UUID>          (unique to this retry attempt)
priorRef     = batchId             (previous executionRef)
executionRef = retryId             (now the active reference)
```

### Consecutive Retry

```
retryId      = <new UUID>          (unique to this retry attempt)
priorRef     = <previous retryId>  (the executionRef of the last retry)
executionRef = retryId             (advances to the latest retryId)
```

All SQS messages, S3 object metadata, and database records carry the `executionRef` for end-to-end traceability.

---

## State Machine

### Run Status Transitions

```
PENDING ──► PROCESSING ──► COMPLETED
               │
               ├──► FAILED ──► RETRYING ──► PROCESSING
               │                                │
               └──► BLOCKED ──► RETRYING ─────►┘
```

### Stage Status Transitions

```
PENDING ──► PROCESSING ──► COMPLETED
   │              │
   └──► BLOCKED   └──► FAILED
```

---

## REST API

Full Swagger documentation is available at `http://localhost:3000/api` when running locally.

### `POST /settlement/upload`

Trigger the ingestion pipeline via a manual file upload.

**Request:** `multipart/form-data`

| Field      | Type   | Required | Description                            |
|------------|--------|----------|----------------------------------------|
| `file`     | File   | ✅       | The settlement file (CSV, etc.)        |
| `metadata` | String | ❌       | JSON string of optional metadata       |

**Response (201):**
```json
{
  "success": true,
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "executionRef": "550e8400-e29b-41d4-a716-446655440000",
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "status": "PROCESSING",
  "fileName": "settlement.csv",
  "s3Key": "settlements/2026-03-31/batch-id/settlement.csv",
  "s3Bucket": "settle-processing-uploads",
  "createdAt": "2026-03-31T08:00:00.000Z"
}
```

---

### `GET /settlement/batches/:id`

Retrieve granular status, stage breakdown, retry history, and chronological timeline for a specific batch.

**Response (200):**
```json
{
  "batchId": "550e8400-e29b-41d4-a716-446655440000",
  "executionRef": "retry-uuid-after-first-retry",
  "status": "COMPLETED",
  "stages": [...],
  "retries": [
    {
      "retryId": "retry-uuid",
      "executionRef": "retry-uuid",
      "priorRef": "550e8400-e29b-41d4-a716-446655440000",
      "attemptNumber": 1,
      "status": "COMPLETED",
      "stages": [...]
    }
  ],
  "timeline": [
    { "phase": "initial", "stageType": "INGEST", "status": "FAILED", ... },
    { "phase": "retry-1", "stageType": "INGEST", "status": "COMPLETED", "retryId": "...", ... }
  ]
}
```

---

### `GET /settlement/runs`

List historical and active pipeline runs.

**Query Parameters:**

| Parameter  | Type   | Description                                     |
|------------|--------|-------------------------------------------------|
| `status`   | Enum   | Filter by `PENDING\|PROCESSING\|COMPLETED\|FAILED\|BLOCKED\|RETRYING` |
| `fromDate` | ISO    | Filter runs created on or after this date       |
| `toDate`   | ISO    | Filter runs created on or before this date      |
| `page`     | Number | Page number (default: 1)                        |
| `limit`    | Number | Results per page (default: 20, max: 100)        |

---

### `POST /settlement/runs/:id/retry`

Re-queue a failed or blocked pipeline run from the point of failure.

**Request Body:**
```json
{ "reason": "Manual retry after SQS timeout" }
```

**Response (200):**
```json
{
  "success": true,
  "runId": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "retryId": "new-retry-uuid",
  "executionRef": "new-retry-uuid",
  "priorRef": "previous-execution-ref",
  "attemptNumber": 2,
  "status": "RETRYING",
  "createdAt": "2026-03-31T09:00:00.000Z"
}
```

---

## Local Development Setup

### Prerequisites

- Node.js ≥ 20
- PostgreSQL ≥ 14
- AWS credentials configured (or LocalStack for local AWS emulation)
- [Bruno](https://www.usebruno.com/) (for API testing)

### 1. Install Dependencies

```bash
# From the monorepo root
npm install

# Or from this app directory
cd apps/settle-processing && npm install
```

### 2. Configure Environment

```bash
cp apps/settle-processing/.env.example apps/settle-processing/.env.local
# Edit .env.local with your local values
```

Key variables:

```env
SETTLE_PROCESSING_DATABASE_URL=postgresql://postgres:password@localhost:5432/settle_processing
AWS_REGION=eu-west-1
S3_BUCKET_NAME=settle-processing-uploads
SQS_INGEST_QUEUE_URL=http://localhost:4566/000000000000/settle-ingest
SQS_CALC_QUEUE_URL=http://localhost:4566/000000000000/settle-calc
POSTHOG_API_KEY=phc_your_key_here
```

### 3. Database Setup

```bash
# Run Prisma migrations
cd apps/settle-processing
npx prisma migrate dev --schema=./prisma/schema.prisma --name init

# Generate Prisma client
npx prisma generate --schema=./prisma/schema.prisma
```

### 4. (Optional) LocalStack for AWS Services

```bash
# Start LocalStack
docker run --rm -it -p 4566:4566 localstack/localstack

# Create S3 bucket
aws --endpoint-url=http://localhost:4566 s3 mb s3://settle-processing-uploads

# Create SQS queues
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name settle-ingest
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name settle-calc
aws --endpoint-url=http://localhost:4566 sqs create-queue --queue-name settle-dlq
```

### 5. Start the Service

```bash
# From the monorepo root (Nx)
npx nx serve settle-processing

# Or directly
cd apps/settle-processing && npm run start:dev
```

The service will be available at `http://localhost:3000`.  
Swagger UI: `http://localhost:3000/api`

---

## Running Tests

### Unit Tests

```bash
# From monorepo root
npx nx test settle-processing

# With coverage
npx nx test settle-processing --coverage

# From app directory
cd apps/settle-processing && npm test
```

### Integration / E2E Tests

Requires a running database and (optionally) LocalStack.

```bash
cd apps/settle-processing && npm run test:e2e
```

### Key test files

| File | Coverage |
|------|----------|
| `src/state-machine/pipeline-state-machine.spec.ts` | State transition validation, downstream blocking, run status derivation |
| `src/settlement/settlement.controller.spec.ts` | All four REST endpoints |
| `src/settlement/pipeline-run.service.spec.ts` | Run creation, retry logic, status filtering |
| `src/settlement/batch.service.spec.ts` | Batch retrieval, timeline building |
| `src/posthog/posthog.service.spec.ts` | Event capture, graceful degradation without API key |
| `test/settlement.e2e-spec.ts` | Full HTTP round-trip tests |

---

## Bruno API Tests

A complete Bruno collection is provided in `./bruno/` for manual and automated API testing.

### Setup

1. Open [Bruno](https://www.usebruno.com/) and import the collection from `apps/settle-processing/bruno/`.
2. Select the **local** environment.
3. Run the requests in sequence (they share `batchId` and `runId` variables via post-response scripts).

### Test Sequence

| # | File | Purpose |
|---|------|---------|
| 1 | `01-upload-settlement-file.bru` | Upload a settlement file; captures `batchId` and `runId` |
| 2 | `02-get-batch-by-id.bru` | Retrieve batch detail; verifies stages and timeline |
| 3 | `03-list-runs.bru` | List all runs with default pagination |
| 3b| `03b-list-runs-filtered.bru` | List runs filtered by `FAILED` status |
| 4 | `04-retry-run.bru` | Retry a run; verifies new `retryId` and lineage |
| 5 | `05-get-batch-after-retry.bru` | Re-fetch batch; verifies `executionRef` advanced, lineage preserved |

The test fixture CSV is at `./bruno/test-fixtures/settlement-sample.csv`.

### CLI Execution

```bash
# Install Bruno CLI
npm install -g @usebruno/cli

# Run the full collection against the local environment
bru run apps/settle-processing/bruno --env local
```

---

## PostHog Event Tracking

The service captures the following events via PostHog:

| Event | Trigger |
|-------|---------|
| `settle.batch.created` | New file upload and batch creation |
| `settle.run.started` | Pipeline run transitions to PROCESSING |
| `settle.run.completed` | All stages completed successfully |
| `settle.run.failed` | Run enters FAILED state |
| `settle.stage.started` | A pipeline stage begins processing |
| `settle.stage.completed` | A pipeline stage completes successfully |
| `settle.stage.failed` | A pipeline stage fails |
| `settle.stage.blocked` | A downstream stage is blocked due to upstream failure |
| `settle.retry.initiated` | A retry is initiated |
| `settle.retry.completed` | A retry completes successfully |
| `settle.retry.failed` | A retry fails |
| `settle.pipeline.error` | Generic pipeline error |

Configure PostHog via `POSTHOG_API_KEY` and `POSTHOG_HOST` environment variables. If the API key is absent, events are silently skipped (no runtime errors).

---

## AWS Deployment

### Lambda (Serverless Framework)

```bash
cd apps/settle-processing

# Deploy to dev
npx serverless deploy --stage dev

# Deploy to production
npx serverless deploy --stage prod
```

Configuration is in `./aws/serverless.yml`. Secrets are read from AWS SSM Parameter Store under `/settle-processing/{stage}/`.

### Required SSM Parameters

| Parameter | Description |
|-----------|-------------|
| `/settle-processing/{stage}/database-url` | PostgreSQL connection string |
| `/settle-processing/{stage}/s3-bucket-name` | S3 bucket for uploads |
| `/settle-processing/{stage}/sqs-ingest-queue-url` | SQS queue URL for settle-ingest |
| `/settle-processing/{stage}/sqs-calc-queue-url` | SQS queue URL for settle-calc |
| `/settle-processing/{stage}/sqs-dlq-url` | SQS dead-letter queue URL |
| `/settle-processing/{stage}/posthog-api-key` | PostHog API key |

### EC2 / ECS

Build and run as a standard Node.js process:

```bash
npm run build
NODE_ENV=production node dist/main
```

The `PORT` environment variable controls the listening port (default: 3000).

---

## Related Jira Tickets

- [IPT-827](https://newpayment.atlassian.net/browse/IPT-827) – Build settle processing orchestrator app
- [IPT-872](https://newpayment.atlassian.net/browse/IPT-872) – Basic DB Schema updates + settle-processing app bootstrap
