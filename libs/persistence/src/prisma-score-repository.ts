import { PrismaClient } from "@prisma/client";
import type {
  CacheKey,
  CategoryScore,
  LanguageShare,
  RepoScan,
  RepoScoreReport,
  ScoreRepositoryPort,
} from "@cbd/analysis";
import { UUID_PATTERN } from "./uuid";

/**
 * PrismaScoreRepository — ScoreRepositoryPort implementation backed by
 * Postgres via Prisma. See design: "The five ports" / "Data Schema".
 *
 * `findCached` semantics deliberately mirror InMemoryScoreRepository's
 * (Phase 2): only `status='complete'` rows are ever candidates for a cache
 * hit. This is not just "matches the double" — it is exactly what the
 * design's `repo_scan_cache_uniq` partial unique index enforces at the
 * schema level (only one 'complete' row can ever exist per
 * (repoUrl, commitSha, engineVersion) — 'partial' rows are excluded from the
 * index), so there is never a competing partial to "prefer over"; querying
 * status='complete' alone is sufficient and correct.
 */
// The `id` column is `@db.Uuid` — Postgres rejects a non-UUID string at the
// query layer with a hard error, not a "no rows" result. The shared
// contract suite's "returns null for an unknown id" test passes a
// non-UUID string ("does-not-exist") and expects `null`, matching
// InMemoryScoreRepository's Map.get() semantics (any unknown key -> null).
// Deviation required to satisfy the suite UNMODIFIED: findById() below
// guards with `UUID_PATTERN` (shared, see ./uuid) before querying, so a
// malformed id is treated as "not found" rather than propagating a raw
// Prisma/Postgres error.

export class PrismaScoreRepository implements ScoreRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async findCached(key: CacheKey): Promise<RepoScan | null> {
    const row = await this.prisma.repoScan.findFirst({
      where: {
        repoUrl: key.repoUrl,
        commitSha: key.commitSha,
        engineVersion: key.engineVersion,
        status: "complete",
      },
      orderBy: { createdAt: "desc" },
    });

    return row ? this.toDomain(row) : null;
  }

  async save(report: RepoScoreReport): Promise<RepoScan> {
    const row = await this.prisma.repoScan.create({ data: this.toCreateData(report) });
    return this.toDomain(row);
  }

  /**
   * Forced re-scan (explicit user "Re-scan"). `save()` deliberately does NOT
   * swallow the P2002 from `repo_scan_cache_uniq` — the normal caller must
   * consult `findCached()` first. The forced path can't: it re-runs the
   * pipeline for an unchanged repo on purpose, so an identical-key complete
   * row is the expected state, not an error.
   *
   * Two scans of the same (repoUrl, commitSha, engineVersion) are equivalent
   * by definition — that equivalence is the whole reason the cache key
   * exists. `forceRescan` matters only because the LLM judge is
   * non-deterministic. So this refreshes the existing complete row IN PLACE
   * (fresh score/categories/createdAt, SAME `repo_scan.id`), and only
   * inserts when nothing is cached yet. Keeping the id stable means every
   * historical `analysis_job.repo_scan_id` FK still resolves (no
   * ON DELETE SET NULL fallout, so `get-analysis-response.ts`'s "a completed
   * job always has a scan" invariant holds) and old and new jobs both see
   * the refreshed verdict. Still exactly one `status='complete'` row per key.
   */
  async saveForced(report: RepoScoreReport): Promise<RepoScan> {
    const row = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.repoScan.findFirst({
        where: {
          repoUrl: report.repoUrl,
          commitSha: report.commitSha,
          engineVersion: report.engineVersion,
          status: "complete",
        },
        orderBy: { createdAt: "desc" },
      });

      return existing
        ? tx.repoScan.update({ where: { id: existing.id }, data: this.toCreateData(report) })
        : tx.repoScan.create({ data: this.toCreateData(report) });
    });

    return this.toDomain(row);
  }

  private toCreateData(report: RepoScoreReport) {
    return {
      repoUrl: report.repoUrl,
      commitSha: report.commitSha,
      engineVersion: report.engineVersion,
      status: report.status,
      compositeScore: report.compositeScore,
      completeness: report.completeness,
      dominantLanguage: report.dominantLanguage,
      languageMix: report.languageMix as unknown as object,
      categories: report.categories as unknown as object,
      createdAt: report.createdAt,
    };
  }

  async findById(id: string): Promise<RepoScan | null> {
    if (!UUID_PATTERN.test(id)) return null;
    const row = await this.prisma.repoScan.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async listByRepo(repoUrl: string, limit: number): Promise<readonly RepoScan[]> {
    const rows = await this.prisma.repoScan.findMany({
      where: { repoUrl },
      orderBy: { createdAt: "desc" },
      take: limit,
    });

    return rows.map((row) => this.toDomain(row));
  }

  private toDomain(row: {
    id: string;
    repoUrl: string;
    commitSha: string;
    engineVersion: string;
    status: string;
    compositeScore: unknown;
    completeness: unknown;
    dominantLanguage: string | null;
    languageMix: unknown;
    categories: unknown;
    createdAt: Date;
  }): RepoScan {
    return {
      id: row.id,
      repoUrl: row.repoUrl,
      commitSha: row.commitSha,
      engineVersion: row.engineVersion,
      status: row.status as "complete" | "partial",
      compositeScore: decimalToNumber(row.compositeScore),
      completeness: decimalToNumber(row.completeness) ?? 0,
      dominantLanguage: row.dominantLanguage,
      languageMix: row.languageMix as readonly LanguageShare[],
      categories: row.categories as readonly CategoryScore[],
      createdAt: row.createdAt,
    };
  }
}

/**
 * Prisma maps `Decimal` columns (compositeScore, completeness) to
 * decimal.js `Decimal` instances, not plain JS numbers — `.toNumber()` is
 * the documented conversion. Guards for the (unlikely, but cheap-to-guard)
 * case a driver already returns a plain number.
 */
function decimalToNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return value;
  return (value as { toNumber(): number }).toNumber();
}
