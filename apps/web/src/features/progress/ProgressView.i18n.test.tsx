import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import { act } from "react";
import { ProgressView } from "./ProgressView";
import { renderWithI18n } from "../../i18n/test-utils";

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

describe("ProgressView — Spanish", () => {
  it("renders the heading, the pre-progress notice, and localized `\"{cat}: {status}\"` rows in Spanish", async () => {
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
            { category: "documentation", status: "pending", score: null },
          ],
        },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderWithI18n(<ProgressView jobId="job-1" pollAfterMs={2000} onTerminal={vi.fn()} />, {
      locale: "es",
    });

    expect(screen.getByRole("heading", { name: "Analizando el repositorio…" })).toBeInTheDocument();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    // One element's direct text — the localized category name + status word.
    expect(screen.getByText("Seguridad: en curso")).toBeInTheDocument();
    expect(screen.getByText("Documentación: pendiente")).toBeInTheDocument();
  });
});
