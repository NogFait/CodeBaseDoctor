import { describe, expect, it } from "vitest";
import { demuxDockerLog } from "./docker-log";

// Docker's non-TTY log/attach stream multiplexes stdout and stderr into one
// buffer using an 8-byte frame header: [streamType, 0, 0, 0, sizeBE(4 bytes)]
// followed by `size` bytes of payload. streamType 1 = stdout, 2 = stderr.
function frame(streamType: 1 | 2, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("demuxDockerLog", () => {
  it("separates a single stdout frame from a single stderr frame", () => {
    const buf = Buffer.concat([frame(1, "hello stdout\n"), frame(2, "oops stderr\n")]);

    const result = demuxDockerLog(buf);

    expect(result).toEqual({ stdout: "hello stdout\n", stderr: "oops stderr\n" });
  });

  it("concatenates multiple frames of the same stream type in order", () => {
    const buf = Buffer.concat([frame(1, "line1\n"), frame(1, "line2\n"), frame(2, "err1\n")]);

    const result = demuxDockerLog(buf);

    expect(result.stdout).toBe("line1\nline2\n");
    expect(result.stderr).toBe("err1\n");
  });

  it("returns empty strings for an empty buffer", () => {
    expect(demuxDockerLog(Buffer.alloc(0))).toEqual({ stdout: "", stderr: "" });
  });
});
