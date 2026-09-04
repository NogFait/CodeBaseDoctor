import { PrismaClient, type JobStatus, type CategoryStatus } from "@prisma/client";
import type { CategoryId } from "@cbd/analysis";

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

// Same UUID-shape guard pattern as PrismaScoreRepository.findById(): the
// `id` column is `@db.Uuid`, so Postgres rejects a non-UUID string as a hard
// query error, not a "no rows" result. Guarding here treats a malformed id
// as "not found", matching the softer Map-like semantics callers expect.
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    const current = await this.prisma.analysisJob.findUniqueOrThrow({
      where: { id },
      select: { startedAt: true },
    });

    await this.prisma.analysisJob.update({
      where: { id },
      data: {
        status,
        ...(extra.commitSha !== undefined ? { commitSha: extra.commitSha } : {}),
        ...(extra.errorCode !== undefined ? { errorCode: extra.errorCode } : {}),
        ...(extra.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
        ...(extra.repoScanId !== undefined ? { repoScanId: extra.repoScanId } : {}),
        ...(extra.bullJobId !== undefined ? { bullJobId: extra.bullJobId } : {}),
        ...(status !== "queued" && current.startedAt === null ? { startedAt: new Date() } : {}),
        ...(TERMINAL_STATUSES.has(status) ? { finishedAt: new Date() } : {}),
      },
    });
  }

  async attachBullJobId(id: string, bullJobId: string): Promise<void> {
    await this.prisma.analysisJob.update({ where: { id }, data: { bullJobId } });
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
