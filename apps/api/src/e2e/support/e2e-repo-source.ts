import type { IngestionLimits, RepoMetadata, RepoRef, RepoSourcePort, RepoWorkspace } from "@cbd/analysis";

/**
 * Test-only `RepoSourcePort` decorator for Phase 8's E2E suite. Wraps a REAL
 * `RepoSourcePort` (in practice, a real `ShallowCloneAdapter`) and rewrites
 * the concrete network target for `head()`/`materialize()` — everything
 * else (validation, Docker orchestration, git, Semgrep/OSV-Scanner) stays
 * 100% real.
 *
 * Why this exists: `ShallowCloneAdapter.resolve()` (see
 * `libs/repo-source/src/repo-url.ts`, `parseGithubRepoUrl`) hard-requires
 * the literal input URL's hostname to be exactly "github.com" — this is a
 * deliberate MVP constraint (design: "Non-GitHub hosts" deferred risk), not
 * a bug, and there is no production env var / config escape hatch to
 * redirect github.com traffic elsewhere. `head()`/`materialize()` then use
 * `RepoRef.url` VERBATIM for a real `git ls-remote` / `git clone` inside the
 * `cbd-fetcher` container. An E2E test needs `POST /analyses` to accept a
 * `https://github.com/...`-shaped URL (so the real validation genuinely
 * runs) while the actual clone target is this test run's own
 * `git-fixture-server` (see `libs/repo-source/testing/git-fixture-server.ts`)
 * — not github.com.
 *
 * Rather than adding a test escape hatch to PRODUCTION code (a real
 * behavior change shipped for a test-only need — out of scope for this
 * batch), this thin decorator keeps `resolve()`'s real validation
 * (delegates to the wrapped real adapter, unmodified) and ONLY rewrites the
 * `RepoRef.url` used by `head()`/`materialize()` — which still run for
 * real (real Docker, real git daemon, real Semgrep/OSV-Scanner) against
 * whatever URL this maps to.
 *
 * Usage: register a mapping BEFORE a test's `POST /analyses` call —
 *   repoSource.register("https://github.com/e2e-fixture/happy-path", `${server.baseUrl}/happy-path`);
 * — using a distinct `owner/repo` pair per scenario (per
 * `startE2eEnvironment`'s own doc comment: distinct fixture URLs per test
 * avoid `repo_scan` cache cross-contamination across tests sharing one
 * Postgres for the whole file).
 */
export class E2eRepoSource implements RepoSourcePort {
  private readonly urlMap = new Map<string, string>();

  constructor(private readonly inner: RepoSourcePort) {}

  /** Maps a `https://github.com/...`-shaped URL (what a test POSTs) to the
   * real reachable clone URL (typically a `git-fixture-server` baseUrl). */
  register(githubUrl: string, realUrl: string): void {
    this.urlMap.set(githubUrl, realUrl);
  }

  async resolve(url: string): Promise<RepoRef> {
    // Real validation, unmodified — this is exactly `parseGithubRepoUrl`
    // via the wrapped real ShallowCloneAdapter.
    return this.inner.resolve(url);
  }

  async head(ref: RepoRef): Promise<RepoMetadata> {
    return this.inner.head(this.remap(ref));
  }

  async materialize(ref: RepoRef, sha: string, limits: IngestionLimits): Promise<RepoWorkspace> {
    return this.inner.materialize(this.remap(ref), sha, limits);
  }

  private remap(ref: RepoRef): RepoRef {
    const target = this.urlMap.get(ref.url);
    return target ? { ...ref, url: target } : ref;
  }
}
