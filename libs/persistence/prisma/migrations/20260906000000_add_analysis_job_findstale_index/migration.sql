-- Supporting index for AnalysisJobRepository.findStale() (the stale-job
-- watchdog's query), which filters:
--
--   WHERE started_at < $cutoff
--     AND status NOT IN ('completed', 'completed_partial', 'failed')
--
-- Without an index this is a full scan of analysis_job that gets slower as
-- completed jobs accumulate. A PARTIAL index whose predicate is exactly the
-- query's terminal-status exclusion keeps the index tiny (only in-flight
-- rows are ever indexed) and its leading `started_at` column serves the
-- `< cutoff` range scan directly.
--
-- Hand-written raw SQL, same as the other partial indexes in
-- 20260814000000_init/migration.sql (analysis_job_active,
-- repo_scan_cache_uniq, quota_reservation_daily) - Prisma's schema DSL
-- cannot express a partial index, so this is not represented as `@@index`
-- in schema.prisma. `prisma migrate deploy` (what production and the
-- Testcontainers integration specs both run) applies this file as-is.
CREATE INDEX "analysis_job_findstale"
  ON "analysis_job" ("started_at")
  WHERE "status" NOT IN ('completed', 'completed_partial', 'failed');
