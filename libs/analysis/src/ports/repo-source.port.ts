import type { RepoContext } from "../domain";

export interface RepoRef {
  host: "github";
  owner: string;
  repo: string;
  url: string;
  ref?: string;
}

export interface RepoMetadata {
  defaultBranch: string;
  headSha: string;
  sizeKb: number;
  visibility: "public" | "private";
}

export interface IngestionLimits {
  maxVolumeBytes: number;
  maxFiles: number;
  cloneTimeoutMs: number;
}

export interface RepoWorkspace {
  readonly context: RepoContext;
  dispose(): Promise<void>;
}

/**
 * Port 2 — repo ingestion. Concrete adapter (Phase 3) is the two-container
 * fetcher/scanner pipeline; this port hides that entirely.
 * See design: "The five ports".
 */
export interface RepoSourcePort {
  /** Throws InvalidRepoUrlError. */
  resolve(url: string): Promise<RepoRef>;
  /** Throws RepoNotAccessibleError | RepoTooLargeError (pre-flight). */
  head(ref: RepoRef): Promise<RepoMetadata>;
  /** Throws RepoTooLargeError | TooManyFilesError | CloneTimeoutError. */
  materialize(ref: RepoRef, sha: string, limits: IngestionLimits): Promise<RepoWorkspace>;
}
