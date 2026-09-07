import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { UrlEntryForm } from "./UrlEntryForm";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UrlEntryForm", () => {
  it("submits the typed repo URL as a POST and hands the queued response to onSubmitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-1",
        status: "queued",
        commitSha: "abc123",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 3, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(<UrlEntryForm onSubmitted={onSubmitted} />);
    await user.type(screen.getByLabelText(/repo url/i), "https://github.com/owner/repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/analyses$/);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/owner/repo",
      forceRescan: false,
    });
    expect(onSubmitted).toHaveBeenCalledWith(
      "https://github.com/owner/repo",
      expect.objectContaining({ jobId: "job-1", status: "queued" }),
    );
  });

  it("shows an error message and does not call onSubmitted when the API rejects the URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(400, {
        type: "/errors/invalid-repo-url",
        title: "Invalid or unsupported repo URL",
        repoUrl: "not-a-repo",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(<UrlEntryForm onSubmitted={onSubmitted} />);
    await user.type(screen.getByLabelText(/repo url/i), "not-a-repo");
    await user.click(screen.getByRole("button", { name: /scan repo/i }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent('That doesn\'t look like a valid GitHub repo URL: "not-a-repo".'),
    );
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
