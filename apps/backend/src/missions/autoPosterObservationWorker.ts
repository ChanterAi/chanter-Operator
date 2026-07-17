/**
 * Phase 2F-B autonomous AutoPoster observation worker.
 *
 * A thin interval-driven wrapper around the existing, unmodified
 * AutoPosterObservationService.runObservationBatch — the exact same bounded
 * backfill/claim/observe/converge/reschedule/escalate path the manual
 * POST /api/autoposter-observations/run endpoint already uses. This worker
 * adds no second scheduler, no second observation store, and no parallel
 * retry engine: it only decides *when* to call that existing entrypoint, on
 * a bounded interval, without overlapping itself in-process, failing closed
 * on any error. Cross-process safety (including against the manual
 * endpoint) is inherited entirely from the service's own atomic
 * BEGIN IMMEDIATE due-job claim — this worker never touches durable state
 * directly.
 */
import type { AutoPosterObservationService } from "./autoPosterObservationService.js";
import { OperatorError } from "../services/operatorService.js";

export const OBSERVATION_WORKER_MIN_POLL_INTERVAL_MS = 1_000;
export const OBSERVATION_WORKER_MAX_POLL_INTERVAL_MS = 3_600_000;
export const OBSERVATION_WORKER_MAX_BATCH_SIZE = 16;
const DEFAULT_LEASE_OWNER = "operator-observation-worker";

export type AutoPosterObservationWorkerEvent =
  | { type: "worker_disabled" }
  | { type: "worker_started"; pollIntervalMs: number; batchSize: number | null }
  | { type: "worker_stopped" }
  | { type: "run_skipped_overlap" }
  | { type: "run_started"; leaseOwner: string }
  | {
      type: "run_completed";
      leaseOwner: string;
      backfilledJobs: number;
      claimed: number;
      processed: number;
      converged: number;
      rescheduled: number;
      escalated: number;
      failedTerminal: number;
      durationMs: number;
    }
  | { type: "run_failed"; leaseOwner: string; error: string; durationMs: number };

export interface AutoPosterObservationWorkerOptions {
  enabled: boolean;
  pollIntervalMs: number;
  batchSize?: number;
  leaseOwner?: string;
  onEvent?: (event: AutoPosterObservationWorkerEvent) => void;
  /** Test seam: inject fake timers instead of the real Node interval. */
  setIntervalFn?: (handler: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (handle: NodeJS.Timeout) => void;
}

function defaultLogger(event: AutoPosterObservationWorkerEvent): void {
  console.log(`AUTOPOSTER_OBSERVATION_WORKER ${JSON.stringify(event)}`);
}

/** Only what the worker needs from the real service — easy to stub in tests. */
type ObservationBatchRunner = Pick<AutoPosterObservationService, "runObservationBatch">;

export class AutoPosterObservationWorker {
  private readonly enabled: boolean;
  private readonly pollIntervalMs: number;
  private readonly batchSize?: number;
  private readonly leaseOwner: string;
  private readonly onEvent: (event: AutoPosterObservationWorkerEvent) => void;
  private readonly setIntervalFn: (handler: () => void, ms: number) => NodeJS.Timeout;
  private readonly clearIntervalFn: (handle: NodeJS.Timeout) => void;

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private stopped = true;
  private currentRun: Promise<void> | null = null;

  constructor(
    private readonly observationService: ObservationBatchRunner,
    options: AutoPosterObservationWorkerOptions,
  ) {
    this.enabled = options.enabled;
    if (options.enabled) {
      if (
        !Number.isInteger(options.pollIntervalMs)
        || options.pollIntervalMs < OBSERVATION_WORKER_MIN_POLL_INTERVAL_MS
        || options.pollIntervalMs > OBSERVATION_WORKER_MAX_POLL_INTERVAL_MS
      ) {
        throw new OperatorError(
          `Observation worker poll interval must be an integer between ${OBSERVATION_WORKER_MIN_POLL_INTERVAL_MS} and ${OBSERVATION_WORKER_MAX_POLL_INTERVAL_MS} ms.`,
          500,
          "OPERATOR_OBSERVATION_WORKER_CONFIG_INVALID",
        );
      }
      if (
        options.batchSize !== undefined
        && (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > OBSERVATION_WORKER_MAX_BATCH_SIZE)
      ) {
        throw new OperatorError(
          `Observation worker batch size must be an integer between 1 and ${OBSERVATION_WORKER_MAX_BATCH_SIZE}.`,
          500,
          "OPERATOR_OBSERVATION_WORKER_CONFIG_INVALID",
        );
      }
    }
    this.pollIntervalMs = options.pollIntervalMs;
    this.batchSize = options.batchSize;
    this.leaseOwner = options.leaseOwner?.trim() || DEFAULT_LEASE_OWNER;
    this.onEvent = options.onEvent ?? defaultLogger;
    this.setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle));
  }

  /** Idempotent: a second call while already running (or disabled) is a no-op. */
  start(): void {
    if (!this.enabled) {
      this.onEvent({ type: "worker_disabled" });
      return;
    }
    if (this.timer) return;
    this.stopped = false;
    this.onEvent({
      type: "worker_started",
      pollIntervalMs: this.pollIntervalMs,
      batchSize: this.batchSize ?? null,
    });
    this.timer = this.setIntervalFn(() => this.tick(), this.pollIntervalMs);
  }

  /**
   * Stops accepting new ticks immediately, then waits for any in-flight
   * bounded run to finish before resolving — callers (Operator shutdown)
   * must await this before closing the database out from under a run.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    if (this.currentRun) {
      await this.currentRun;
    }
    this.onEvent({ type: "worker_stopped" });
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.ticking) {
      this.onEvent({ type: "run_skipped_overlap" });
      return;
    }
    this.ticking = true;
    this.currentRun = this.runOnce().finally(() => {
      this.ticking = false;
      this.currentRun = null;
    });
  }

  /** Never rejects: every failure is reported as a run_failed event instead. */
  private async runOnce(): Promise<void> {
    const startedAt = Date.now();
    this.onEvent({ type: "run_started", leaseOwner: this.leaseOwner });
    try {
      const result = await this.observationService.runObservationBatch({
        leaseOwner: this.leaseOwner,
        ...(this.batchSize !== undefined ? { batchSize: this.batchSize } : {}),
      });
      let converged = 0;
      let rescheduled = 0;
      let escalated = 0;
      let failedTerminal = 0;
      for (const job of result.results) {
        if (job.outcomeClass === "converged") converged += 1;
        else if (job.outcomeClass === "continue_observing" || job.outcomeClass === "transport_retry") rescheduled += 1;
        else if (job.outcomeClass === "failed_terminal") failedTerminal += 1;
        if (job.escalationId !== null) escalated += 1;
      }
      this.onEvent({
        type: "run_completed",
        leaseOwner: this.leaseOwner,
        backfilledJobs: result.backfilledJobs,
        claimed: result.claimed,
        processed: result.results.length,
        converged,
        rescheduled,
        escalated,
        failedTerminal,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      this.onEvent({
        type: "run_failed",
        leaseOwner: this.leaseOwner,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
    }
  }
}
