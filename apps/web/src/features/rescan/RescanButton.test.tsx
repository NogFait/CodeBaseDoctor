import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RescanButton } from "./RescanButton";
// Wraps in <I18nProvider> forced to `en` — English assertions unchanged.
import { renderWithI18n as render } from "../../i18n/test-utils";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("RescanButton", () => {
  it("re-submits the given repoUrl with forceRescan:true, bypassing cache", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-2",
        status: "queued",
        commitSha: "def456",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 1, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onSubmitted = vi.fn();
    const user = userEvent.setup();

    render(<RescanButton repoUrl="https://github.com/owner/repo" onSubmitted={onSubmitted} />);
    await user.click(screen.getByRole("button"));

    await waitFor(() => expect(onSubmitted).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/analyses$/);
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/owner/repo",
      forceRescan: true,
    });
    expect(onSubmitted).toHaveBeenCalledWith(
      "https://github.com/owner/repo",
      expect.objectContaining({ jobId: "job-2" }),
    );
  });

  it("renders the given label text on the button", () => {
    render(<RescanButton repoUrl="https://github.com/owner/repo" onSubmitted={vi.fn()} label="Try again" />);
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
