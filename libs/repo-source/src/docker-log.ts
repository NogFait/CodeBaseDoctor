// Demultiplexes a non-TTY Docker log/attach buffer into stdout/stderr.
// Docker's wire format for a non-TTY container's combined log stream is a
// sequence of frames: 1-byte stream type (1=stdout, 2=stderr), 3 reserved
// zero bytes, a 4-byte big-endian payload length, then that many payload
// bytes. dockerode returns the raw multiplexed buffer from `container.logs()`
// when the container was created without a TTY (our containers always are,
// so output can be attributed to the right stream for error classification).

export interface DemuxedLog {
  stdout: string;
  stderr: string;
}

const HEADER_BYTES = 8;
const STDOUT_STREAM_TYPE = 1;
const STDERR_STREAM_TYPE = 2;

export function demuxDockerLog(buffer: Buffer): DemuxedLog {
  let stdout = "";
  let stderr = "";
  let offset = 0;

  while (offset + HEADER_BYTES <= buffer.length) {
    const streamType = buffer.readUInt8(offset);
    const payloadLength = buffer.readUInt32BE(offset + 4);
    const payloadStart = offset + HEADER_BYTES;
    const payloadEnd = payloadStart + payloadLength;
    const payload = buffer.subarray(payloadStart, Math.min(payloadEnd, buffer.length)).toString("utf8");

    if (streamType === STDOUT_STREAM_TYPE) {
      stdout += payload;
    } else if (streamType === STDERR_STREAM_TYPE) {
      stderr += payload;
    }

    offset = payloadEnd;
  }

  return { stdout, stderr };
}
