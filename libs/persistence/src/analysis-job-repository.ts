import { PrismaClient, Prisma, type JobStatus, type CategoryStatus } from "@prisma/client";
import type { CategoryId } from "@cbd/analysis";
import { UUID_PATTERN } from "./uuid";

/**
 * AnalysisJobRepository — Prisma-backed bookkeeping for `analysis_job` /
 * `analysis_job_category` row lifecycle. See design "Data Schema
 * (Postgres)" for the tables.
 *
 * Deliberately NOT one of the 5 hexagonal ports declared in
 * `libs/analysis/src/ports/` — job/queue-lifecycle bookkeeping was never
 * given a port in the design (a real design gap, not papered over here by
 * inventing a 6th port). It's registered directly as a plain provider in
 * PersistenceModule (by class, like PrismaService itself), not behind a
 * Symbol token.
 */

export type { JobStatus, CategoryStatus };

const ALL_CATEGORIES: readonly CategoryId[] = [
  "architecture",
  "security",
  "testing",
  "maintainability",
  "performance",
  "documentation",
];

// A status only counts as "left queued" (for startedAt) or "terminal" (for
// finishedAt) — see updateStatus() below.
const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set(["completed", "completed_partial", "failed"]);

// Every JobStatus value that is NOT terminal — exported for callers (e.g.
// StaleJobWatchdogService) that need a compare-and-swap "only if still
// in-flight" guard via updateStatusIfCurrentlyIn() below.
export const NON_TERMINAL_STATUSES: readonly JobStatus[] = ["queued", "resolving", "cloning", "analyzing", "aggregating"];

// Upper bound on the rows one findStale() call returns, i.e. the most jobs
// StaleJobWatchdogService.sweep() will act on per scheduler tick. sweep()
// fans out ~2 pooled DB ops per row concurrently (a CAS `updateMany` + an
// advisory-lock refund txn), so an UNBOUNDED result under a mass
// worker-crash would saturate the Prisma connection pool, make sweep()
// reject, and leave the scheduler retrying the same herd every tick. 50 is
// comfortably below a default Prisma pool while still clearing a normal
// backlog in a single tick; a larger backlog drains deterministically
// (oldest-first) across successive ticks.
export const STALE_JOB_SWEEP_BATCH_SIZE = 50;

// Same UUID-shape guard pattern as PrismaScoreRepository.findById(): the
// `id` column is `@db.Uuid`, so Postgres rejects a non-UUID string as a hard
// query error, not a "no rows" result. Guarding here treats a malformed id
// as "not found", matching the softer Map-like semantics callers expect.
// `UUID_PATTERN` is the shared definition — see ./uuid.

export interface CreateAnalysisJobInput {
  repoUrl: string;
  commitSha?: string;
  engineVersion: string;
  actorId: string;
  reservationId: string;
}

export interface AnalysisJobCategoryRow {
  category: string;
  status: CategoryStatus;
  score: number | null;
  confidence: string | null;
  rationale: string | null;
  findings: unknown;
  errorCode: string | null;
  durationMs: number | null;
  updatedAt: Date;
}

export interface AnalysisJobRecord {
  id: string;
  repoUrl: string;
  commitSha: string | null;
  engineVersion: string;
  actorId: string;
  reservationId: string;
  status: JobStatus;
  errorCode: string | null;
  errorMessage: string | null;
  repoScanId: string | null;
  bullJobId: string | null;
  attempts: number;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  categories: readonly AnalysisJobCategoryRow[];
}

export interface UpdateAnalysisJobStatusExtra {
  commitSha?: string;
  errorCode?: string;
  errorMessage?: string;
  repoScanId?: string;
  bullJobId?: string;
}

export interface UpdateCategoryStatusInput {
  status: CategoryStatus;
  score?: number | null;
  confidence?: string | null;
  rationale?: string | null;
  findings?: unknown;
  errorCode?: string | null;
  durationMs?: number | null;
}

export interface StaleAnalysisJob {
  id: string;
  reservationId: string;
}

export class AnalysisJobRepository {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Inserts the `analysis_job` row (status defaults to 'queued') and, in the
   * SAME transaction, one `analysis_job_category` row per CategoryId (all
   * 'pending') — so a job never briefly exists with a partial category set.
   */
  async create(input: CreateAnalysisJobInput): Promise<{ id: string }> {
    const job = await this.prisma.$transaction(async (tx) => {
      const created = await tx.analysisJob.create({
        data: {
          repoUrl: input.repoUrl,
          commitSha: input.commitSha,
          engineVersion: input.engineVersion,
          actorId: input.actorId,
          reservationId: input.reservationId,
        },
      });

      await tx.analysisJobCategory.createMany({
        data: ALL_CATEGORIES.map((category) => ({ jobId: created.id, category })),
      });

      return created;
    });

    return { id: job.id };
  }

  async findById(id: string): Promise<AnalysisJobRecord | null> {
    if (!UUID_PATTERN.test(id)) return null;

    const row = await this.prisma.analysisJob.findUnique({
      where: { id },
      include: { categories: true },
    });

    return row ? this.toRecord(row) : null;
  }

  /**
   * Generic status/field updater. `startedAt` is set exactly once, on the
   * first transition away from 'queued' (never overwritten on later
   * transitions). `finishedAt` is set whenever `status` lands on a terminal
   * value (completed / completed_partial / failed) — overwritten on each
   * such call, which is fine: a job only legitimately reaches one terminal
   * status once in practice, and re-setting the same terminal status again
   * (an idempotent replay) just refreshes the timestamp rather than
   * corrupting state.
   */
  async updateStatus(id: string, status: JobStatus, extra: UpdateAnalysisJobStatusExtra = {}): Promise<void> {
    const now = new Date();

    // One round-trip: the row write plus, only when leaving 'queued', a
    // scoped `startedAt` write — batched in a single transaction. This
    // replaces a `findUniqueOrThrow({ startedAt })` + separate `update()`
    // (two round-trips): the read existed ONLY to enforce `startedAt`'s
    // write-once rule, which the `startedAt: null` filter below now enforces
    // in the database instead. The leading `update()` (not `updateMany`)
    // preserves the original contract that an unknown `id` is a hard error
    // (Prisma P2025), exactly as the removed `findUniqueOrThrow()` did.
    const writes: Prisma.PrismaPromise<unknown>[] = [
      this.prisma.analysisJob.update({ where: { id }, data: this.statusUpdateData(status, extra, now) }),
    ];

    if (status !== "queued") {
      // `startedAt` is set exactly once, on the first transition away from
      // 'queued'; `where: { startedAt: null }` makes that write-once and
      // never overwrites an already-set value on a later transition.
      writes.push(
        this.prisma.analysisJob.updateMany({ where: { id, startedAt: null }, data: { startedAt: now } }),
      );
    }

    await this.prisma.$transaction(writes);
  }

  /**
   * The `data` payload shared verbatim by `updateStatus()` and
   * `updateStatusIfCurrentlyIn()`: the new `status`, whichever optional
   * `extra` columns were supplied, and `finishedAt` when `status` is
   * terminal. `updateStatus()` layers its own write-once `startedAt` rule
   * on top (see there); the CAS variant uses this as-is.
   */
  private statusUpdateData(
    status: JobStatus,
    extra: UpdateAnalysisJobStatusExtra,
    now: Date,
  ): Prisma.AnalysisJobUpdateManyMutationInput {
    return {
      status,
      ...(extra.commitSha !== undefined ? { commitSha: extra.commitSha } : {}),
      ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
      ...(extra.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
      ...(extra.repoScanId !== undefined ? { repoScanId: extra.repoScanId } : {}),
      ...(extra.bullJobId !== undefined ? { bullJobId: extra.bullJobId } : {}),
      ...(TERMINAL_STATUSES.has(status) ? { finishedAt: now } : {}),
    };
  }

  /**
   * Compare-and-swap status transition: only writes `status` if the row's
   * CURRENT status is still one of `fromStatuses` at write time — via a
   * single conditional `UPDATE ... WHERE id = $1 AND status IN (...)`
   * (`updateMany` so Prisma gives us the affected-row count instead of
   * throwing `RecordNotFound` on a miss). Returns `true` iff the write
   * actually happened (count === 1), `false` if the row had already moved
   * to some other status by the time this ran (a legitimate concurrent
   * writer won the race) — in which case NOTHING is written here.
   *
   * Exists for StaleJobWatchdogService.sweep(): findStale() takes a
   * snapshot, then this method is the per-job write, closing the race where
   * a real AnalysisProcessor finishes that same job (to a terminal status)
   * in between — see that class's doc comment. Deliberately a SEPARATE
   * method from the general updateStatus() above (which stays unconditional
   * for AnalysisProcessor's own use) rather than overloading it, since
   * changing updateStatus()'s own behavior would affect every caller.
   *
   * Unlike updateStatus(), this does NOT manage `startedAt` — every current
   * caller only CAS-transitions a job that has already started (it's only
   * ever reached via findStale(), whose query itself requires a non-null
   * startedAt), so there is no "first move away from queued" case to
   * handle here.
   */
  async updateStatusIfCurrentlyIn(
    id: string,
    fromStatuses: readonly JobStatus[],
    status: JobStatus,
    extra: UpdateAnalysisJobStatusExtra = {},
  ): Promise<boolean> {
    const result = await this.prisma.analysisJob.updateMany({
      where: { id, status: { in: [...fromStatuses] } },
      data: this.statusUpdateData(status, extra, new Date()),
    });

    return result.count === 1;
  }

  async attachBullJobId(id: string, bullJobId: string): Promise<void> {
    await this.prisma.analysisJob.update({ where: { id }, data: { bullJobId } });
  }

  /**
   * Plain `UPDATE analysis_job_category SET ... WHERE job_id=$1 AND
   * category=$2`, targeting exactly one `(jobId, category)` row via the
   * table's own composite primary key. Task 4.4's "no lost updates"
   * requirement is structurally guaranteed by the schema, not by this
   * method: concurrent calls for two DIFFERENT categories touch two
   * different rows and can never conflict (see the concurrency test in the
   * integration spec).
   */
  async updateCategoryStatus(jobId: string, category: CategoryId, update: UpdateCategoryStatusInput): Promise<void> {
    await this.prisma.analysisJobCategory.update({
      where: { jobId_category: { jobId, category } },
      data: {
        status: update.status,
        ...(update.score !== undefined ? { score: update.score } : {}),
        ...(update.confidence !== undefined ? { confidence: update.confidence } : {}),
        ...(update.rationale !== undefined ? { rationale: update.rationale } : {}),
        ...(update.findings !== undefined ? { findings: update.findings as Prisma.InputJsonValue } : {}),
        ...(update.errorCode !== undefined ? { errorCode: update.errorCode } : {}),
        ...(update.durationMs !== undefined ? { durationMs: update.durationMs } : {}),
      },
    });
  }

  /**
   * Jobs that started but never reached a terminal status and are older
   * than `olderThan` — the watchdog's (task 6.3) query. `startedAt: {lt:
   * olderThan}` already excludes NULL `startedAt` rows by plain SQL
   * comparison semantics (a job still queued, never dequeued, is never
   * "stuck" in the watchdog's sense) — no separate `IS NOT NULL` clause
   * needed. `TERMINAL_STATUSES` is reused, not redefined, from
   * `updateStatus()`'s own module-level constant.
   *
   * Index: relies on the partial index `analysis_job_findstale` on
   * `(started_at) WHERE status NOT IN ('completed','completed_partial','failed')`
   * — see prisma/migrations/20260906000000_add_analysis_job_findstale_index.
   * Its predicate matches this WHERE exactly, so the scan is limited to
   * in-flight rows and ordered by `started_at` for the `< olderThan` range —
   * which is also the exact index the `orderBy` below rides.
   *
   * Bounded at `STALE_JOB_SWEEP_BATCH_SIZE`: `StaleJobWatchdogService.sweep()`
   * processes every returned row with a concurrent per-row DB fan-out, so an
   * unbounded result under a mass worker-crash would stampede the Prisma
   * connection pool. `orderBy: startedAt asc` makes the batch deterministic
   * and oldest-first, so a backlog larger than one batch drains predictably
   * across successive scheduler ticks rather than in one unbounded pass.
   */
  async findStale(olderThan: Date): Promise<StaleAnalysisJob[]> {
    const rows = await this.prisma.analysisJob.findMany({
      where: {
        startedAt: { lt: olderThan },
        status: { notIn: [...TERMINAL_STATUSES] },
      },
      select: { id: true, reservationId: true },
      orderBy: { startedAt: "asc" },
      take: STALE_JOB_SWEEP_BATCH_SIZE,
    });
    return rows;
  }

  private toRecord(row: {
    id: string;
    repoUrl: string;
    commitSha: string | null;
    engineVersion: string;
    actorId: string;
    reservationId: string;
    status: JobStatus;
    errorCode: string | null;
    errorMessage: string | null;
    repoScanId: string | null;
    bullJobId: string | null;
    attempts: number;
    createdAt: Date;
    startedAt: Date | null;
    finishedAt: Date | null;
    categories: {
      category: string;
      status: CategoryStatus;
      score: unknown;
      confidence: string | null;
      rationale: string | null;
      findings: unknown;
      errorCode: string | null;
      durationMs: number | null;
      updatedAt: Date;
    }[];
  }): AnalysisJobRecord {
    return {
      id: row.id,
      repoUrl: row.repoUrl,
      commitSha: row.commitSha,
      engineVersion: row.engineVersion,
      actorId: row.actorId,
      reservationId: row.reservationId,
      status: row.status,
      errorCode: row.errorCode,
      errorMessage: row.errorMessage,
      repoScanId: row.repoScanId,
      bullJobId: row.bullJobId,
      attempts: row.attempts,
      createdAt: row.createdAt,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
      categories: row.categories.map((c) => ({
        category: c.category,
        status: c.status,
        score: decimalToNumber(c.score),
        confidence: c.confidence,
        rationale: c.rationale,
        findings: c.findings,
        errorCode: c.errorCode,
        durationMs: c.durationMs,
        updatedAt: c.updatedAt,
      })),
    };
  }
}

/**
 * Prisma maps `Decimal` columns (categories.score) to decimal.js `Decimal`
 * instances, not plain JS numbers — `.toNumber()` is the documented
 * conversion. Same helper as PrismaScoreRepository's.
 */
function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return (value as { toNumber(): number }).toNumber();
}
