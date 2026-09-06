import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { startGitFixtureServer, waitForPort, type GitFixtureServer } from "@cbd/repo-source/testing/git-fixture-server";
import { startE2eEnvironment, pollUntilTerminal, type E2eEnvironment } from "./support/e2e-environment";

/**
 * Task 8.4 (Phase 8) — oversized repo -> job fails, via the FILE-COUNT gate
 * (`TooManyFilesError`, `maxFiles: 50_000` in `RepoAnalysisService`'s
 * `DEFAULT_INGESTION_LIMITS`) rather than the byte-size gate
 * (`RepoTooLargeError`, 600MB volume quota). Generating 50,001+ tiny
 * (1-byte) files is far cheaper and faster than generating 600MB of real
 * fixture data, and exercises a DISTINCT code path in
 * `ShallowCloneAdapter.materialize()`: the post-clone `git ls-tree -r |
 * wc -l` count gate, not its `du`-based size gate. `git-fixture-server`'s
 * `files: Record<string,string>` fixture-spec shape already supports a
 * programmatically-generated file set (just build the object with a loop
 * before passing it in) — no changes needed to that harness file.
 *
 * Where this actually surfaces (verified empirically against the real code,
 * not assumed from the design doc's simplest-case framing): NOT a
 * synchronous 422 at POST time. `ShallowCloneAdapter.head()` always returns
 * `sizeKb: 0` (no GitHub REST call is made — see its own doc comment), so
 * `SubmitAnalysisUseCase` has zero file-count information available at POST
 * time and always returns 202 queued for a resolvable, accessible repo. The
 * file-count gate can only fire later, inside the WORKER's own
 * `materialize()` call (post-clone, pre-scan) — so this test polls `GET
 * /analyses/:id` to a terminal `failed` status rather than asserting a
 * synchronous error response, matching the SAME generic
 * catch-in-`AnalysisProcessor`-writes-`errorCode: error.name`-and-refunds
 * path every other asynchronous ingestion failure already goes through.
 *
 * `TooManyFilesError` was NOT mapped in `problem-details.ts` before this
 * batch (only `RepoTooLargeError` was — a real, confirmed gap, fixed here;
 * see `problem-details.ts`/`problem-details.spec.ts`). That fix doesn't
 * change THIS test's own assertions (the RFC 9457 filter only runs for
 * errors thrown synchronously during an HTTP request — `AnalysisProcessor`
 * writes `errorCode` straight to the `analysis_job` row for an
 * asynchronous worker-side failure, bypassing the filter entirely), but it
 * closes the spec `repo-ingestion` gap for any current/future SYNCHRONOUS
 * caller of the same error type, and is covered by its own focused unit
 * test.
 */
const REPO_URL = "https://github.com/e2e-fixture/oversized-repo";
// DEFAULT_INGESTION_LIMITS.maxFiles (repo-analysis.service.ts) is 50_000 —
// comfortably over that, with margin, not right at the boundary.
const FILE_COUNT_OVER_LIMIT = 50_010;

function buildManyTinyFiles(count: number): Record<string, string> {
  const files: Record<string, string> = { "README.md": "# Oversized Repo (file-count gate fixture)\n" };
  for (let i = 0; i < count; i++) {
    files[`file-${i}.txt`] = "x";
  }
  return files;
}

describe("E2E: oversized repo (file-count gate) -> failed (task 8.4)", () => {
  let env: E2eEnvironment;
  let fixtureServer: GitFixtureServer;

  beforeAll(async () => {
    // Building + committing 50k+ tiny files is the slow part of this
    // suite's setup (real `git add -A`/`git commit` over a real working
    // tree) — generous but bounded budget, distinct from the other E2E
    // specs' 180s (they have no comparable fixture-construction cost).
    fixtureServer = startGitFixtureServer([
      { name: "oversized-repo", files: buildManyTinyFiles(FILE_COUNT_OVER_LIMIT) },
    ]);
    await waitForPort(fixtureServer.port, "127.0.0.1", 5000);

    env = await startE2eEnvironment();
    env.repoSource.register(REPO_URL, `${fixtureServer.baseUrl}/oversized-repo`);
    // No judgeScript.set() calls needed — the job fails during
    // materialize(), strictly before any analyzer (real or scripted) runs.
  }, 300_000);

  afterAll(async () => {
    fixtureServer.stop();
    await env.stop();
  }, 200_000);

  it(
    "POST queues (202) — the file-count gate fires asynchronously in the worker; job ends 'failed', quota refunded",
    async () => {
      const postRes = await request(env.apiServer).post("/analyses").send({ repoUrl: REPO_URL });
      expect(postRes.status).toBe(202);
      expect(postRes.body.status).toBe("queued");
      const jobId = postRes.body.jobId as string;

      // Larger poll budget than the other E2E specs: cloning 50k+ real git
      // objects (even tiny ones) over the fetcher container's real network
      // transport is measurably slower than a handful-of-files fixture.
      const final = await pollUntilTerminal(env.apiServer, jobId, { timeoutMs: 240_000 });

      expect(final.status).toBe("failed");
      expect(final.result).toBeUndefined();

      const jobRow = await env.db.prisma.analysisJob.findUniqueOrThrow({ where: { id: jobId } });
      expect(jobRow.status).toBe("failed");
      expect(jobRow.errorCode).toBe("TooManyFilesError");

      // Quota refunded — checked directly against the real
      // `quota_reservation` row via the job's own `reservationId`, the same
      // direct-DB technique used by 8.5/8.6 (more direct than an indirect
      // follow-up-POST proxy, and doesn't cost a second real Docker
      // pipeline run just to observe a 429-vs-202 side effect).
      const reservation = await env.db.prisma.quotaReservation.findUniqueOrThrow({
        where: { id: jobRow.reservationId },
      });
      expect(reservation.state).toBe("refunded");
    },
    280_000,
  );
});
