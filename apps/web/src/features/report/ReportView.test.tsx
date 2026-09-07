import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ReportView } from "./ReportView";
import type { CategoryScore, RepoScan } from "../../api/types";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

function category(overrides: Partial<CategoryScore>): CategoryScore {
  return {
    category: "security",
    status: "scored",
    score: 78,
    confidence: "measured",
    weightCap: 1,
    rationale: "No critical findings.",
    findings: [],
    durationMs: 100,
    ...overrides,
  };
}

function scan(overrides: Partial<RepoScan> = {}): RepoScan {
  return {
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
      category({ category: "architecture", confidence: "judged", rationale: "Clean layering." }),
      category({ category: "security", confidence: "measured", rationale: "No critical findings." }),
      category({ category: "testing", confidence: "estimated", rationale: "Good coverage heuristics." }),
      category({ category: "maintainability", confidence: "measured", rationale: "Low complexity." }),
      category({ category: "performance", confidence: "estimated", weightCap: 0.5, rationale: "Static estimate only." }),
      category({ category: "documentation", confidence: "judged", rationale: "README present." }),
    ],
    createdAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

describe("ReportView — completed", () => {
  it("renders all 6 category cards with score, rationale, and the right confidence badge", () => {
    render(
      <ReportView repoUrl="https://github.com/owner/repo" status="completed" result={scan()} onRescanSubmitted={vi.fn()} />,
    );

    const testingCard = screen.getByRole("heading", { name: "testing" }).closest("li")!;
    expect(within(testingCard).getByText("Estimated")).toBeInTheDocument();
    expect(within(testingCard).getByText(/78/)).toBeInTheDocument();

    const performanceCard = screen.getByRole("heading", { name: "performance" }).closest("li")!;
    expect(within(performanceCard).getByText("Low confidence — static estimate")).toBeInTheDocument();

    const securityCard = screen.getByRole("heading", { name: "security" }).closest("li")!;
    expect(within(securityCard).getByText("Measured")).toBeInTheDocument();
    expect(within(securityCard).getByText("No critical findings.")).toBeInTheDocument();

    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(6);
  });
});

describe("ReportView — completed_partial", () => {
  it("renders scored cards normally and a 'Could not be scored' retry affordance for the failed one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(202, {
        jobId: "job-2",
        status: "queued",
        commitSha: "def456",
        pollAfterMs: 2000,
        quota: { tier: "free", limit: 5, remaining: 2, resetsAt: "2026-09-07T00:00:00.000Z" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onRescanSubmitted = vi.fn();
    const user = userEvent.setup();

    const partialScan = scan({
      status: "partial",
      categories: [
        category({ category: "architecture" }),
        category({ category: "security" }),
        category({ category: "testing" }),
        category({ category: "maintainability" }),
        category({ category: "performance", weightCap: 0.5 }),
        category({
          category: "documentation",
          status: "failed",
          score: null,
          rationale: "LLM judge timed out.",
          error: { code: "llm_timeout", message: "timed out" },
        }),
      ],
    });

    render(
      <ReportView
        repoUrl="https://github.com/owner/repo"
        status="completed_partial"
        result={partialScan}
        onRescanSubmitted={onRescanSubmitted}
      />,
    );

    const docCard = screen.getByRole("heading", { name: "documentation" }).closest("li")!;
    expect(within(docCard).getByText("Could not be scored")).toBeInTheDocument();
    const securityCard = screen.getByRole("heading", { name: "security" }).closest("li")!;
    expect(within(securityCard).getByText(/78/)).toBeInTheDocument();

    await user.click(within(docCard).getByRole("button", { name: /retry/i }));

    await waitFor(() => expect(onRescanSubmitted).toHaveBeenCalledTimes(1));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      repoUrl: "https://github.com/owner/repo",
      forceRescan: true,
    });
  });
});

describe("ReportView — failed", () => {
  it("shows a failure message and explicitly informs the user their quota was refunded", () => {
    render(
      <ReportView repoUrl="https://github.com/owner/repo" status="failed" result={null} onRescanSubmitted={vi.fn()} />,
    );

    expect(screen.getByText(/scan failed/i)).toBeInTheDocument();
    expect(screen.getByText(/quota.*refunded/i)).toBeInTheDocument();
    expect(screen.getByRole("button")).toBeInTheDocument();
  });

  it("renders the problem's formatted message instead of only the generic failure copy when a problem is present", () => {
    render(
      <ReportView
        repoUrl="https://github.com/owner/repo"
        status="failed"
        result={null}
        problem={{ type: "/errors/scan-timeout", title: "Scan timed out" }}
        onRescanSubmitted={vi.fn()}
      />,
    );

    expect(screen.getByText("The scan timed out. Please try again.")).toBeInTheDocument();
    expect(screen.getByText(/quota.*refunded/i)).toBeInTheDocument();
  });
});

describe("ReportView — analyze another repo", () => {
  it("calls onStartOver when 'Analyze another repo' is clicked on a completed report", async () => {
    const onStartOver = vi.fn();
    const user = userEvent.setup();

    render(
      <ReportView
        repoUrl="https://github.com/owner/repo"
        status="completed"
        result={scan()}
        onRescanSubmitted={vi.fn()}
        onStartOver={onStartOver}
      />,
    );

    await user.click(screen.getByRole("button", { name: /analyze another repo/i }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });

  it("calls onStartOver when 'Analyze another repo' is clicked on the failed screen", async () => {
    const onStartOver = vi.fn();
    const user = userEvent.setup();

    render(
      <ReportView
        repoUrl="https://github.com/owner/repo"
        status="failed"
        result={null}
        onRescanSubmitted={vi.fn()}
        onStartOver={onStartOver}
      />,
    );

    await user.click(screen.getByRole("button", { name: /analyze another repo/i }));
    expect(onStartOver).toHaveBeenCalledTimes(1);
  });
});
