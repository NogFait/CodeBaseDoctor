import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { App } from "./App";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("navigates entry -> progress (by jobId) -> report on a 202 queued submission that later completes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(202, {
          jobId: "job-1",
          status: "queued",
          commitSha: "abc123",
          pollAfterMs: 2000,
          quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          jobId: "job-1",
          status: "completed",
          cached: false,
          result: {
            id: "scan-1",
            repoUrl: "https://github.com/owner/repo",
            commitSha: "abc123",
            engineVersion: "1.0.0",
            status: "complete",
            compositeScore: 71.4,
            completeness: 1,
            dominantLanguage: "TypeScript",
            languageMix: [],
            categories: [
              {
                category: "security",
                status: "scored",
                score: 78,
                confidence: "measured",
                weightCap: 1,
                rationale: "No critical findings.",
                findings: [],
                durationMs: 100,
              },
            ],
            createdAt: "2026-09-07T00:00:00.000Z",
          },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<App />);
    await user.type(screen.getByLabelText(/repo url/i), "https://github.com/owner/repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() => expect(screen.getByRole("heading", { name: /scanning repository/i })).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    await waitFor(() => expect(screen.getByText("No critical findings.")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [pollUrl] = fetchMock.mock.calls[1] as [string];
    expect(pollUrl).toMatch(/\/analyses\/job-1$/);
  });

  it("shows the remaining daily quota after a submit", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-1",
        status: "queued",
        commitSha: "abc123",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 4, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<App />);
    await user.type(screen.getByLabelText(/repo url/i), "https://github.com/owner/repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() => expect(screen.getByText(/4 analyses left today/i)).toBeInTheDocument());
  });

  it("skips polling and goes straight to the report view on a 200 cache-hit submission", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        jobId: null,
        status: "completed",
        cached: true,
        scanId: "scan-1",
        quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
        result: {
          id: "scan-1",
          repoUrl: "https://github.com/owner/repo",
          commitSha: "abc123",
          engineVersion: "1.0.0",
          status: "complete",
          compositeScore: 90,
          completeness: 1,
          dominantLanguage: "TypeScript",
          languageMix: [],
          categories: [
            {
              category: "security",
              status: "scored",
              score: 90,
              confidence: "measured",
              weightCap: 1,
              rationale: "Cached result rationale.",
              findings: [],
              durationMs: 50,
            },
          ],
          createdAt: "2026-09-07T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<App />);
    await user.type(screen.getByLabelText(/repo url/i), "https://github.com/owner/repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() => expect(screen.getByText("Cached result rationale.")).toBeInTheDocument());
    expect(screen.queryByRole("heading", { name: /scanning repository/i })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns to the URL entry form when 'Analyze another repo' is clicked from the report", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        jobId: null,
        status: "completed",
        cached: true,
        scanId: "scan-1",
        quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
        result: {
          id: "scan-1",
          repoUrl: "https://github.com/owner/repo",
          commitSha: "abc123",
          engineVersion: "1.0.0",
          status: "complete",
          compositeScore: 90,
          completeness: 1,
          dominantLanguage: "TypeScript",
          languageMix: [],
          categories: [
            {
              category: "security",
              status: "scored",
              score: 90,
              confidence: "measured",
              weightCap: 1,
              rationale: "Cached result rationale.",
              findings: [],
              durationMs: 50,
            },
          ],
          createdAt: "2026-09-07T00:00:00.000Z",
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    render(<App />);
    await user.type(screen.getByLabelText(/repo url/i), "https://github.com/owner/repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() => expect(screen.getByText("Cached result rationale.")).toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: /analyze another repo/i }));

    expect(screen.getByLabelText(/repo url/i)).toBeInTheDocument();
    expect(screen.queryByText("Cached result rationale.")).not.toBeInTheDocument();
  });
});
