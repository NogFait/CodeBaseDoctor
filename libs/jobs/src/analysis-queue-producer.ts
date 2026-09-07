import { Injectable } from "@nestjs/common";
import { InjectQueue } from "@nestjs/bullmq";
import type { Queue } from "bullmq";

export const ANALYSIS_QUEUE_NAME = "analysis";

export interface EnqueueAnalysisPayload {
  repoUrl: string;
  actorId: string;
  reservationId: string;
  /**
   * Explicit user "Re-scan". Carried onto the job so the worker's
   * `RepoAnalysisService.analyze()` skips its OWN cache lookup too —
   * otherwise a forced re-scan of an unchanged repo just returns the
   * cached scan and visibly does nothing.
   */
  forceRescan?: boolean;
}

/**
 * AnalysisQueueProducer — BullMQ producer side for the 'analysis' queue.
 * See design: "NestJS Wiring" - libs/jobs (`JobsProducerModule`). Consumed
 * by apps/api's (future, task 5.x) job-creation use case, AFTER
 * `AnalysisJobRepository.create()` has already written the `analysis_job`
 * row — `enqueue()` takes that row's id so the two writes are correlated.
 *
 * `attempts: 1` (no automatic BullMQ retry) is a deliberate choice, not the
 * bare BullMQ default left unconsidered: RepoAnalysisService already has
 * its own recovery path for a below-threshold run (UsageQuotaPort.refund()
 * on AnalysisBelowThresholdError — see repo-analysis.service.ts), and an
 * automatic BullMQ retry would blindly re-run Docker materialization + LLM
 * judge calls for the SAME job a second time, silently doubling real spend
 * (ephemeral container time, LLM tokens) for a failure class the domain
 * already handles explicitly. A retry, when warranted, should be a new job
 * row with a new reservationId (an explicit re-scan), not a transparent
 * BullMQ re-attempt of the same job.
 */
@Injectable()
export class AnalysisQueueProducer {
  constructor(@InjectQueue(ANALYSIS_QUEUE_NAME) private readonly queue: Queue) {}

  /**
   * @returns the BullMQ job's own id, so the caller can persist it via
   * `AnalysisJobRepository.attachBullJobId()`.
   */
  async enqueue(analysisJobId: string, payload: EnqueueAnalysisPayload): Promise<string> {
    const job = await this.queue.add(
      "analyze",
      { analysisJobId, ...payload },
      { attempts: 1 },
    );

    if (job.id === undefined) {
      // BullMQ always assigns an id once `add()` resolves; this is a
      // defensive narrowing, not an expected runtime path.
      throw new Error("AnalysisQueueProducer: BullMQ did not assign a job id");
    }

    return job.id;
  }
}
