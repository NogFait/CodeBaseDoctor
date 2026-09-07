import { Body, Controller, Get, Inject, NotFoundException, Param, Post, Req, Res } from "@nestjs/common";
import type { Request, Response } from "express";
import { SCORE_REPOSITORY_PORT, type RepoScan, type ScoreRepositoryPort } from "@cbd/analysis";
import { AnalysisJobRepository, type AnalysisJobRecord } from "@cbd/persistence";
import { actorIdForRequest } from "../actor-id";
import { parseCreateAnalysisDto } from "./create-analysis.dto";
import { mapAnalysisJobToResponse } from "./get-analysis-response";
import { SubmitAnalysisUseCase } from "./submit-analysis.use-case";

/** Narrow interface `AnalysisJobRepository` satisfies structurally — same
 * "hand-rolled port for a non-port collaborator" pattern as
 * submit-analysis.use-case.ts's `JobRepositoryPort`, here for the GET
 * lookup only. */
interface JobLookupPort {
  findById(id: string): Promise<AnalysisJobRecord | null>;
}

function getClientIp(req: Request): string {
  // No proxy-trust config exists anywhere in this app (checked: no
  // `app.set('trust proxy', ...)`, no @nestjs/config, nothing) so `req.ip`
  // is Express's direct socket address — X-Forwarded-For is deliberately
  // NOT honored here; trusting it without an actual reverse-proxy trust
  // boundary would let a client spoof its own actorId trivially.
  return req.ip ?? req.socket.remoteAddress ?? "unknown";
}

@Controller("analyses")
export class AnalysesController {
  constructor(
    // Explicit @Inject() for all three params — not just the two
    // interface-typed ones — mirrors RepoAnalysisService's convention
    // (repo-analysis.service.ts) rather than relying on ambient
    // constructor-parameter reflection, which proved unreliable for a
    // concrete-class param under this repo's Vitest/esbuild transform.
    @Inject(SubmitAnalysisUseCase) private readonly submitAnalysis: SubmitAnalysisUseCase,
    @Inject(AnalysisJobRepository) private readonly jobs: JobLookupPort,
    @Inject(SCORE_REPOSITORY_PORT) private readonly scores: ScoreRepositoryPort,
  ) {}

  /**
   * Task 5.1. Status code is dynamic (202 queued vs 200 cache-hit per
   * design flow (a)/(b)) so it's set via `@Res({ passthrough: true })`
   * rather than a static `@HttpCode()`. Every typed domain error from the
   * use case (InvalidRepoUrlError, RepoNotAccessibleError,
   * RepoTooLargeError, QuotaExceededError) is left to propagate uncaught —
   * the global `ProblemDetailsFilter` (task 5.3) maps it to the right RFC
   * 9457 response.
   */
  @Post()
  async create(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const dto = parseCreateAnalysisDto(body);
    const actorId = actorIdForRequest(getClientIp(req));

    const result = await this.submitAnalysis.submit({
      repoUrl: dto.repoUrl,
      actorId,
      forceRescan: dto.forceRescan,
    });

    if (result.outcome === "cached") {
      res.status(200);
      return {
        jobId: null,
        status: "completed",
        cached: true,
        scanId: result.scanId,
        quota: result.quota,
        result: result.result,
      };
    }

    res.status(202);
    return {
      jobId: result.jobId,
      status: "queued",
      commitSha: result.commitSha,
      pollAfterMs: result.pollAfterMs,
      quota: result.quota,
    };
  }

  /**
   * Task 5.2. 404 for an unknown id; 202 while a job is still in progress
   * (any of queued/resolving/cloning/analyzing/aggregating collapse to
   * response status "analyzing" — see get-analysis-response.ts); 200 once
   * terminal (completed / completed_partial / failed).
   */
  @Get(":id")
  async getById(@Param("id") id: string, @Res({ passthrough: true }) res: Response) {
    const job = await this.jobs.findById(id);
    if (!job) {
      throw new NotFoundException();
    }

    let scan: RepoScan | null = null;
    if ((job.status === "completed" || job.status === "completed_partial") && job.repoScanId) {
      scan = await this.scores.findById(job.repoScanId);
    }

    const response = mapAnalysisJobToResponse(job, scan);

    // A job that failed because of a clone/scan timeout carries a
    // reconstructed RFC 9457 `problem` (see get-analysis-response.ts /
    // mapFailedJobToProblem in problem-details.ts) — surface it as a real
    // 504 application/problem+json response instead of the bare 200
    // `{jobId, status:'failed', cached:false}` fallback used for every
    // other failure cause. This bypasses `ProblemDetailsFilter` on
    // purpose: nothing is THROWN here (the job already finished, terminally,
    // in the past), there's just a status/body to build from data already
    // in hand.
    if (response.status === "failed" && response.problem) {
      const { problem } = response;
      res.status(problem.status).contentType("application/problem+json");
      return { type: problem.type, title: problem.title, status: problem.status, jobId: response.jobId, ...problem.extra };
    }

    res.status(response.status === "analyzing" ? 202 : 200);
    return response;
  }
}
