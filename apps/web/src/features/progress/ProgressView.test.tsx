import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { act } from "react";
import { ProgressView } from "./ProgressView";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ProgressView", () => {
  it("polls GET /analyses/:id after pollAfterMs and renders per-category status", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-1",
        status: "analyzing",
        cached: false,
        pollAfterMs: 2500,
        progress: {
          completed: 1,
          total: 6,
          categories: [
            { category: "security", status: "running", score: null },
            { category: "testing", status: "pending", score: null },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(<ProgressView jobId="job-1" pollAfterMs={2000} onTerminal={vi.fn()} />);

    expect(fetchMock).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toMatch(/\/analyses\/job-1$/);
    expect(screen.getByText("security: running")).toBeInTheDocument();
    expect(screen.getByText("testing: pending")).toBeInTheDocument();
  });

  it("keeps polling at the server-provided pollAfterMs and calls onTerminal on a terminal status", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          jobId: "job-1",
          status: "analyzing",
          cached: false,
          pollAfterMs: 2500,
          progress: { completed: 0, total: 6, categories: [] },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          jobId: "job-1",
          status: "completed",
          cached: false,
          result: { id: "scan-1", categories: [] },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const onTerminal = vi.fn();

    render(<ProgressView jobId="job-1" pollAfterMs={2000} onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTerminal).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(expect.objectContaining({ status: "completed" }));
  });

  it("treats a non-2xx poll response (e.g. 504 scan-timeout) as terminal failure instead of hanging forever", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(504, {
        type: "/errors/scan-timeout",
        title: "The scan timed out.",
        status: 504,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onTerminal = vi.fn();

    render(<ProgressView jobId="job-1" pollAfterMs={2000} onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", status: "failed", cached: false }),
    );

    // No further poll is scheduled once terminal — advancing time again must
    // not trigger a second fetch (would indicate the loop kept retrying).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces an ApiError's problem+json on the terminal failed response so mid-poll problem copy can be shown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(504, {
        type: "/errors/scan-timeout",
        title: "Scan timed out",
        status: 504,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onTerminal = vi.fn();

    render(<ProgressView jobId="job-9" pollAfterMs={2000} onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-9",
        status: "failed",
        problem: expect.objectContaining({ type: "/errors/scan-timeout" }),
      }),
    );
  });

  it("leaves problem undefined on the terminal failed response for a raw network failure (no problem+json)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const onTerminal = vi.fn();

    render(<ProgressView jobId="job-10" pollAfterMs={2000} onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    const [terminalResponse] = onTerminal.mock.calls[0] as [{ problem?: unknown }];
    expect(terminalResponse.problem).toBeUndefined();
  });

  it("treats a raw network failure (fetch rejects, not just a non-2xx response) as terminal failure too", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchMock);
    const onTerminal = vi.fn();

    render(<ProgressView jobId="job-2" pollAfterMs={2000} onTerminal={onTerminal} />);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledTimes(1);
    expect(onTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-2", status: "failed", cached: false }),
    );
  });
});
