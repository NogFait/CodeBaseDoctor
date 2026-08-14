-- CodeBase Doctor MVP - initial schema.
--
-- The CREATE TABLE / CREATE TYPE / plain-index statements below were
-- generated with:
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- from libs/persistence/prisma/schema.prisma and are kept in sync with it.
--
-- Everything Prisma's schema DSL cannot express is hand-written, per
-- design "Data Schema (Postgres)":
--   - the two CHECK constraints (repo_scan.status, quota_reservation.state
--     are plain TEXT columns, not enums, in the design)
--   - all three PARTIAL indexes (repo_scan_cache_uniq, analysis_job_active,
--     quota_reservation_daily) - Prisma has no partial-index syntax.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "job_status" AS ENUM ('queued', 'resolving', 'cloning', 'analyzing', 'aggregating', 'completed', 'completed_partial', 'failed');

-- CreateEnum
CREATE TYPE "category_status" AS ENUM ('pending', 'running', 'scored', 'failed', 'skipped');

-- CreateTable
CREATE TABLE "repo_scan" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repo_url" TEXT NOT NULL,
    "commit_sha" CHAR(40) NOT NULL,
    "engine_version" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "composite_score" DECIMAL(5,2),
    "completeness" DECIMAL(3,2) NOT NULL,
    "dominant_language" TEXT,
    "language_mix" JSONB NOT NULL DEFAULT '[]',
    "categories" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_scan_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "repo_scan_status_check" CHECK ("status" IN ('complete', 'partial'))
);

-- CreateTable
CREATE TABLE "analysis_job" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "repo_url" TEXT NOT NULL,
    "commit_sha" CHAR(40),
    "engine_version" TEXT NOT NULL,
    "actor_id" TEXT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "status" "job_status" NOT NULL DEFAULT 'queued',
    "error_code" TEXT,
    "error_message" TEXT,
    "repo_scan_id" UUID,
    "bull_job_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "analysis_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "analysis_job_category" (
    "job_id" UUID NOT NULL,
    "category" TEXT NOT NULL,
    "status" "category_status" NOT NULL DEFAULT 'pending',
    "score" DECIMAL(5,2),
    "confidence" TEXT,
    "rationale" TEXT,
    "findings" JSONB NOT NULL DEFAULT '[]',
    "error_code" TEXT,
    "duration_ms" INTEGER,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "analysis_job_category_pkey" PRIMARY KEY ("job_id","category")
);

-- CreateTable
CREATE TABLE "quota_reservation" (
    "id" UUID NOT NULL,
    "actor_id" TEXT NOT NULL,
    "usage_date" DATE NOT NULL,
    "tier" TEXT NOT NULL DEFAULT 'free',
    "state" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quota_reservation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quota_reservation_state_check" CHECK ("state" IN ('consumed', 'refunded'))
);

-- CreateIndex (plain)
CREATE INDEX "repo_scan_cache_lookup" ON "repo_scan"("repo_url", "commit_sha", "engine_version", "created_at" DESC);

-- CreateIndex (plain)
CREATE INDEX "repo_scan_history" ON "repo_scan"("repo_url", "created_at" DESC);

-- CreateIndex (plain, unique)
CREATE UNIQUE INDEX "analysis_job_reservation_id_key" ON "analysis_job"("reservation_id");

-- CreateIndex (plain)
CREATE INDEX "analysis_job_actor" ON "analysis_job"("actor_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "analysis_job" ADD CONSTRAINT "analysis_job_repo_scan_id_fkey" FOREIGN KEY ("repo_scan_id") REFERENCES "repo_scan"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_job_category" ADD CONSTRAINT "analysis_job_category_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "analysis_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- PARTIAL INDEXES - hand-written, Prisma's schema DSL cannot express these.
-- ============================================================================

-- THE cache index (design decision #4/#6): one complete scan per
-- (repo, sha, engine). Partials are excluded so a later complete scan of the
-- same SHA can still be inserted after an earlier partial one.
CREATE UNIQUE INDEX "repo_scan_cache_uniq"
  ON "repo_scan" ("repo_url", "commit_sha", "engine_version")
  WHERE "status" = 'complete';

-- Active-jobs lookup: only rows still in flight (for the watchdog and
-- per-actor "is there already a running job" checks).
CREATE INDEX "analysis_job_active"
  ON "analysis_job" ("status")
  WHERE "status" NOT IN ('completed', 'completed_partial', 'failed');

-- Daily quota consumption for an actor = COUNT(*) over this partial index.
CREATE INDEX "quota_reservation_daily"
  ON "quota_reservation" ("actor_id", "usage_date")
  WHERE "state" = 'consumed';
