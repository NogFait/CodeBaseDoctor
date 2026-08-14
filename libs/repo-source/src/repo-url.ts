import { InvalidRepoUrlError } from "@cbd/analysis";
import type { RepoRef } from "@cbd/analysis";

/**
 * Parses a repo URL string into a RepoRef. GitHub-only for MVP — design's
 * "Non-GitHub hosts" deferred risk: RepoRef.host is a literal union with one
 * member today; widening it (GitLab etc.) is a second adapter behind the
 * same port, not a change here.
 */
export function parseGithubRepoUrl(url: string): RepoRef {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidRepoUrlError(url);
  }

  if (parsed.hostname.toLowerCase() !== "github.com") {
    throw new InvalidRepoUrlError(url);
  }

  const segments = parsed.pathname.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw new InvalidRepoUrlError(url);
  }

  const [owner, rawRepo] = segments;
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;
  if (owner.length === 0 || repo.length === 0) {
    throw new InvalidRepoUrlError(url);
  }

  return { host: "github", owner, repo, url };
}
