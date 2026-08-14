import { describe, expect, it } from "vitest";
import { InvalidRepoUrlError } from "@cbd/analysis";
import { ShallowCloneAdapter } from "./shallow-clone-adapter";

// Fast, no-Docker path: resolve() is pure URL parsing (delegates to
// parseGithubRepoUrl, already unit-tested on its own). This spec exists to
// prove the ADAPTER's public resolve() method rejects a malformed URL
// without ever touching a Dockerode instance — the adapter is constructed
// with no `docker` option at all, so if resolve() tried to reach Docker it
// would throw a completely different error (dockerode auto-connects lazily
// to /var/run/docker.sock only on first real call).
describe("ShallowCloneAdapter.resolve() — fast path, zero Docker", () => {
  it("resolves a well-formed public GitHub URL", async () => {
    const adapter = new ShallowCloneAdapter();

    const ref = await adapter.resolve("https://github.com/nestjs/nest");

    expect(ref).toEqual({
      host: "github",
      owner: "nestjs",
      repo: "nest",
      url: "https://github.com/nestjs/nest",
    });
  });

  it("rejects a malformed URL with InvalidRepoUrlError, synchronously cheap (no Docker call)", async () => {
    const adapter = new ShallowCloneAdapter();

    await expect(adapter.resolve("not-a-url")).rejects.toThrow(InvalidRepoUrlError);
  });

  it("rejects a non-GitHub host with InvalidRepoUrlError", async () => {
    const adapter = new ShallowCloneAdapter();

    await expect(adapter.resolve("https://gitlab.com/nestjs/nest")).rejects.toThrow(InvalidRepoUrlError);
  });
});
