import { describe, expect, it } from "vitest";
import { FileTooLargeError } from "./errors";
import { MAX_READABLE_FILE_BYTES } from "./types";

describe("FileTooLargeError", () => {
  it("carries the offending path, size, and limit", () => {
    const err = new FileTooLargeError("src/big-file.ts", 600_000, MAX_READABLE_FILE_BYTES);

    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("FileTooLargeError");
    expect(err.path).toBe("src/big-file.ts");
    expect(err.sizeBytes).toBe(600_000);
    expect(err.maxBytes).toBe(MAX_READABLE_FILE_BYTES);
    expect(err.message).toContain("src/big-file.ts");
    expect(err.message).toContain("600000");
  });

  it("triangulates with different path/size inputs to prove the message is derived, not hardcoded", () => {
    const err = new FileTooLargeError("data/dump.json", 1_048_576, MAX_READABLE_FILE_BYTES);

    expect(err.path).toBe("data/dump.json");
    expect(err.sizeBytes).toBe(1_048_576);
    expect(err.message).toContain("data/dump.json");
    expect(err.message).toContain("1048576");
  });
});

describe("MAX_READABLE_FILE_BYTES", () => {
  it("is exactly 512KB per the design's RepoContext.readFile contract", () => {
    expect(MAX_READABLE_FILE_BYTES).toBe(512 * 1024);
  });
});
