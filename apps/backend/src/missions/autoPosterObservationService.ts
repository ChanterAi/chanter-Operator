/**
 * Phase 2E-C durable Operator-owned AutoPoster observation loop.
 *
 * Removes the manual result-refresh dependence from the normal AutoPoster
 * graph lifecycle: when a schedule node durably completes with a valid
 * downstream queue binding, exactly one durable observation job is created
 * (deterministic idempotency key, replay- and restart-safe). Due jobs are
 * claimed atomically under a bounded lease, observed through the exact
 * reviewed Phase 2E-B path (Operator -> Agent Runtime strict status
 * contract -> AutoPoster strict read route; never a provider adapter, never
 * a shell), and converged deterministically:
 *
 *   non-terminal truth  -> bounded re-observation (15s/30s/60s/120s..., max 8)
 *   terminal success    -> converged (uploaded_private)
 *   human-required      -> exactly one durable escalation (open/ack/resolve)
 *   terminal failure    -> failed_terminal (identity mismatch, contract
 *                          violation, terminal provider rejection)
 *   window exhaustion   -> escalation_required (observation_window_exhausted)
 *
 * Authority boundaries stay exactly where Phases 2A-2E-B put them: the
 * Phase 2E-B projection/evidence tables remain the canonical per-node result
 * truth (this service never writes them directly), AutoPoster remains the
 * publishing/provider authority (observation is strictly read-only), and
 * Phase 2E-A graph/node execution status is never mutated — convergence here
 * is result-layer convergence (observation job state + the durable per-node
 * projection + the derived truthful graph-level batch summary).
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../db/database.js";
import {
  AUTOPOSTER_OBSERVATION_ESCALATION_STATUSES,
  AUTOPOSTER_OBSERVATION_JOB_STATUSES,
  AUTOPOSTER_OBSERVATION_OUTCOME_CLASSES,
} from "../db/schema.js";
import { OperatorError } from "../services/operatorService.js";
import type {
  AutoPosterNodeRefreshResult,
  AutoPosterResultEscalationSeverity,
  AutoPosterResultProjectionService,
  AutoPosterResultProjectionStatus,
} from "./autoPosterResultProjectionService.js";

const OBSERVATION_SCHEMA_VERSION = "chanter.autoposter.observation.v1";
const AUTOPOSTER_GRAPH_ACTION = "autoposter.post.schedule";
const DEFAULT_LEASE_OWNER = "operator-observation-runner";
const MAX_ACTOR_LENGTH = 120;
const MAX_LIST_LIMIT = 100;
const MAX_BATCH_SIZE = 16;
const MAX_BACKFILL_PER_BATCH = 32;

export type AutoPosterObservationJobStatus =
  (typeof AUTOPOSTER_OBSERVATION_JOB_STATUSES)[number];
export type AutoPosterObservationOutcomeClass =
  (typeof AUTOPOSTER_OBSERVATION_OUTCOME_CLASSES)[number];
export type AutoPosterObservationEscalationStatus =
  (typeof AUTOPOSTER_OBSERVATION_ESCALATION_STATUSES)[number];

const TERMINAL_JOB_STATUSES = new Set<AutoPosterObservationJobStatus>([
  "converged",
  "escalation_required",
  "failed_terminal",
  "cancelled",
]);

/**
 * Deterministic bounded polling policy. The P0 defaults are the reviewed
 * spec values: 15s before the first attempt, then 30s/60s/120s (the final
 * delay repeats), at most 8 attempts — a hard observation window of
 * 15+30+60+120*5 = 705 seconds plus processing time. Every value is
 * validated against closed bounds, so no configuration can produce an
 * unbounded or tight loop.
 */
export interface AutoPosterObservationPolicy {
  retryDelaysSeconds: number[];
  maxAttempts: number;
  leaseSeconds: number;
  batchSize: number;
}

export const DEFAULT_OBSERVATION_POLICY: AutoPosterObservationPolicy = {
  retryDelaysSeconds: [15, 30, 60, 120],
  maxAttempts: 8,
  leaseSeconds: 60,
  batchSize: 8,
};

function validatePolicy(policy: AutoPosterObservationPolicy): AutoPosterObservationPolicy {
  const { retryDelaysSeconds, maxAttempts, leaseSeconds, batchSize } = policy;
  if (
    !Array.isArray(retryDelaysSeconds)
    || retryDelaysSeconds.length < 1
    || retryDelaysSeconds.length > 8
    || retryDelaysSeconds.some(
      (delay) => !Number.isInteger(delay) || delay < 1 || delay > 600,
    )
  ) {
    throw new OperatorError(
      "Observation retry delays must be 1-8 integer seconds values between 1 and 600.",
      500,
      "OPERATOR_OBSERVATION_POLICY_INVALID",
    );
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 12) {
    throw new OperatorError(
      "Observation max attempts must be an integer between 1 and 12.",
      500,
      "OPERATOR_OBSERVATION_POLICY_INVALID",
    );
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 600) {
    throw new OperatorError(
      "Observation lease seconds must be an integer between 5 and 600.",
      500,
      "OPERATOR_OBSERVATION_POLICY_INVALID",
    );
  }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH_SIZE) {
    throw new OperatorError(
      `Observation batch size must be an integer between 1 and ${MAX_BATCH_SIZE}.`,
      500,
      "OPERATOR_OBSERVATION_POLICY_INVALID",
    );
  }
  return {
    retryDelaysSeconds: [...retryDelaysSeconds],
    maxAttempts,
    leaseSeconds,
    batchSize,
  };
}

/** Escalation reason codes this loop can durably record (closed world). */
export type AutoPosterObservationEscalationReason =
  | "publish_approval_required"
  | "publish_approval_revoked"
  | "provider_reauthorization_required"
  | "provider_accepted_unverified"
  | "manually_reconciled"
  | "manual_review_required"
  | "outcome_unknown"
  | "observation_contradiction"
  | "result_identity_mismatch"
  | "observation_window_exhausted";

const ESCALATION_SEVERITY: Record<
  AutoPosterObservationEscalationReason,
  AutoPosterResultEscalationSeverity
> = {
  publish_approval_required: "info",
  publish_approval_revoked: "warning",
  provider_reauthorization_required: "high",
  provider_accepted_unverified: "warning",
  manually_reconciled: "info",
  manual_review_required: "high",
  outcome_unknown: "critical",
  observation_contradiction: "critical",
  result_identity_mismatch: "high",
  observation_window_exhausted: "warning",
};

const ESCALATION_HUMAN_ACTION: Record<AutoPosterObservationEscalationReason, string> = {
  publish_approval_required:
    "Review and approve (or discard) the canonical draft in AutoPoster; publish approval remains an AutoPoster human action.",
  publish_approval_revoked:
    "Approval was revoked in AutoPoster; review the canonical draft before any publishing decision.",
  provider_reauthorization_required:
    "Reauthorize the exact connected account in AutoPoster, then refresh the Operator projection.",
  provider_accepted_unverified:
    "The provider accepted the publish without visibility proof; verify the post manually before treating it as published.",
  manually_reconciled:
    "A human marked this job posted manually in AutoPoster; verify the manual reconciliation is correct.",
  manual_review_required:
    "Inspect the canonical AutoPoster job; the strict evidence contradicts required terminal proof.",
  outcome_unknown:
    "Reconcile this job manually against the provider and AutoPoster; never approve or retry it automatically.",
  observation_contradiction:
    "AutoPoster evidence contradicts itself for one source revision; inspect the canonical job before trusting either snapshot.",
  result_identity_mismatch:
    "Stop collection for this node and inspect the graph child, queue job ID, workspace, provider, and account bindings.",
  observation_window_exhausted:
    "The bounded automatic observation window ended without terminal evidence; inspect the job in AutoPoster or run a manual result refresh later.",
};

export interface AutoPosterObservationJobView {
  observationJobId: string;
  graphId: string;
  nodeId: string;
  missionId: string;
  workspaceId: string;
  connectedAccountId: string;
  accountId: string;
  provider: string;
  queueJobId: string;
  sourceBinding: unknown;
  sourceBindingHash: string;
  status: AutoPosterObservationJobStatus;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  convergenceReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoPosterObservationAttemptView {
  attemptId: string;
  observationJobId: string;
  graphId: string;
  nodeId: string;
  attemptNumber: number;
  provider: string;
  leaseOwner: string;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  outcomeClass: AutoPosterObservationOutcomeClass;
  refreshOutcome: string;
  projectionStatus: string | null;
  reasonCode: string | null;
  retryDelaySeconds: number | null;
  nextAttemptAt: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

export interface AutoPosterObservationEscalationView {
  escalationId: string;
  observationJobId: string;
  graphId: string;
  nodeId: string;
  reasonCode: string;
  severity: string;
  humanActionRequired: boolean;
  recommendedHumanAction: string;
  summary: string;
  evidenceReferences: string[];
  status: AutoPosterObservationEscalationStatus;
  acknowledgedBy: string | null;
  acknowledgedAt: string | null;
  resolvedBy: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutoPosterObservationScheduleOutcome {
  created: boolean;
  skippedReason:
    | "node_not_completed"
    | "downstream_binding_missing"
    | null;
  job: AutoPosterObservationJobView | null;
}

export interface AutoPosterObservationJobRunView {
  observationJobId: string;
  graphId: string;
  nodeId: string;
  attemptNumber: number;
  outcomeClass: AutoPosterObservationOutcomeClass;
  jobStatus: AutoPosterObservationJobStatus;
  projectionStatus: AutoPosterResultProjectionStatus | null;
  reasonCode: string | null;
  retryDelaySeconds: number | null;
  nextAttemptAt: string | null;
  escalationId: string | null;
}

export interface AutoPosterObservationBatchResult {
  ranAt: string;
  leaseOwner: string;
  backfilledJobs: number;
  claimed: number;
  results: AutoPosterObservationJobRunView[];
}

/** Minimal hook contract the mission graph authority uses to schedule observation. */
export interface AutoPosterObservationScheduler {
  onAutoPosterNodeCompleted(graphId: string, nodeId: string): void;
}

interface ObservationJobRow {
  observation_job_id: string;
  graph_id: string;
  node_id: string;
  mission_id: string;
  workspace_id: string;
  connected_account_id: string;
  account_id: string;
  provider: string;
  queue_job_id: string;
  source_binding_json: string;
  source_binding_hash: string;
  status: AutoPosterObservationJobStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  convergence_reason: string | null;
  created_at: string;
  updated_at: string;
}

interface ObservationEscalationRow {
  escalation_id: string;
  observation_job_id: string;
  graph_id: string;
  node_id: string;
  reason_code: string;
  severity: string;
  human_action_required: number;
  recommended_human_action: string;
  summary: string;
  evidence_refs_json: string;
  status: AutoPosterObservationEscalationStatus;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution_note: string | null;
  created_at: string;
  updated_at: string;
}

interface GraphNodeRow {
  graph_id: string;
  node_id: string;
  status: string;
  child_mission_id: string;
  child_trace_id: string;
  child_idempotency_key: string;
  result_summary_json: string | null;
}

interface Convergence {
  outcomeClass: AutoPosterObservationOutcomeClass;
  reasonCode: string | null;
  errorCode: string | null;
  errorMessage: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requireActor(value: unknown, field: string): string {
  const actor = typeof value === "string" ? value.trim() : "";
  if (!actor || actor.length > MAX_ACTOR_LENGTH) {
    throw new OperatorError(
      `${field} is required and must be at most ${MAX_ACTOR_LENGTH} characters.`,
      400,
    );
  }
  return actor;
}

/**
 * Deterministic Phase 2E-C convergence classification over the exact Phase
 * 2E-B refresh result. No provider state is invented: the strict projection
 * statuses are mapped onto the four reviewed outcome classes, and every
 * unknown or malformed combination fails closed to terminal failure.
 *
 *   A continue_observing : approved_for_publish, processing, retry_scheduled
 *   B converged          : uploaded_private
 *   C escalation_required: awaiting_publish_approval,
 *                          provider_accepted_unverified, manually_reconciled,
 *                          manual_review_required, outcome_unknown,
 *                          failed + provider_reauthorization_required
 *   D failed_terminal    : identity/binding mismatch, evidence contradiction,
 *                          missing schedule evidence, terminal provider
 *                          rejection (failed), anything unknown (fail closed)
 *   transport_retry      : result_collection_unavailable (typed transport or
 *                          contract read failure; bounded re-observation)
 */
export function classifyObservationConvergence(
  result: AutoPosterNodeRefreshResult,
): Convergence {
  if (result.outcome === "failed") {
    switch (result.reasonCode) {
      case "result_collection_unavailable":
        return {
          outcomeClass: "transport_retry",
          reasonCode: "result_collection_unavailable",
          errorCode: "result_collection_unavailable",
          errorMessage: "The strict AutoPoster status read was unavailable; the bounded observation will retry.",
        };
      case "result_identity_mismatch":
      case "observation_contradiction":
      case "schedule_evidence_missing":
        return {
          outcomeClass: "failed_terminal",
          reasonCode: result.reasonCode,
          errorCode: result.reasonCode,
          errorMessage: "The observation produced deterministic terminal evidence that cannot be reconciled automatically.",
        };
      default:
        return {
          outcomeClass: "failed_terminal",
          reasonCode: result.reasonCode ?? "observation_failed_unclassified",
          errorCode: result.reasonCode ?? "observation_failed_unclassified",
          errorMessage: "The observation failed without a reviewed classification; failing closed.",
        };
    }
  }

  const projection = result.projection;
  const escalationReason = projection?.escalationReason ?? null;
  switch (result.projectionStatus) {
    case "approved_for_publish":
    case "processing":
    case "retry_scheduled":
      return { outcomeClass: "continue_observing", reasonCode: null, errorCode: null, errorMessage: null };
    case "uploaded_private":
      return { outcomeClass: "converged", reasonCode: "uploaded_private", errorCode: null, errorMessage: null };
    case "awaiting_publish_approval":
      return {
        outcomeClass: "escalation_required",
        reasonCode: escalationReason ?? "publish_approval_required",
        errorCode: null,
        errorMessage: null,
      };
    case "provider_accepted_unverified":
      return {
        outcomeClass: "escalation_required",
        reasonCode: "provider_accepted_unverified",
        errorCode: null,
        errorMessage: null,
      };
    case "manually_reconciled":
      return {
        outcomeClass: "escalation_required",
        reasonCode: "manually_reconciled",
        errorCode: null,
        errorMessage: null,
      };
    case "manual_review_required":
      return {
        outcomeClass: "escalation_required",
        reasonCode: escalationReason ?? "manual_review_required",
        errorCode: null,
        errorMessage: null,
      };
    case "outcome_unknown":
      return {
        outcomeClass: "escalation_required",
        reasonCode: "outcome_unknown",
        errorCode: null,
        errorMessage: null,
      };
    case "failed":
      if (escalationReason === "provider_reauthorization_required") {
        return {
          outcomeClass: "escalation_required",
          reasonCode: "provider_reauthorization_required",
          errorCode: null,
          errorMessage: null,
        };
      }
      return {
        outcomeClass: "failed_terminal",
        reasonCode: escalationReason ?? "publish_failed",
        errorCode: escalationReason ?? "publish_failed",
        errorMessage: "AutoPoster reported a deterministic terminal publish failure.",
      };
    default:
      return {
        outcomeClass: "failed_terminal",
        reasonCode: "observation_unclassified_status",
        errorCode: "observation_unclassified_status",
        errorMessage: "The observation produced an unreviewed projection status; failing closed.",
      };
  }
}

export class AutoPosterObservationService implements AutoPosterObservationScheduler {
  private readonly now: () => Date;
  private readonly policy: AutoPosterObservationPolicy;
  private readonly failureInjector?: (
    boundary: "after_projection_before_job_convergence",
    observationJobId: string,
  ) => void;

  constructor(
    private readonly database: DatabaseSync,
    private readonly projections: Pick<AutoPosterResultProjectionService, "observeNodeResult">,
    options: {
      now?: () => Date;
      policy?: Partial<AutoPosterObservationPolicy>;
      failureInjector?: (
        boundary: "after_projection_before_job_convergence",
        observationJobId: string,
      ) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.policy = validatePolicy({ ...DEFAULT_OBSERVATION_POLICY, ...(options.policy ?? {}) });
    this.failureInjector = options.failureInjector;
  }

  getPolicy(): AutoPosterObservationPolicy {
    return {
      ...this.policy,
      retryDelaysSeconds: [...this.policy.retryDelaysSeconds],
    };
  }

  // ---------------------------------------------------------------------
  // Automatic scheduling (deterministic idempotency, replay-safe)
  // ---------------------------------------------------------------------

  /**
   * Mission graph completion hook. Never throws back into the graph
   * scheduler: the durable node completion is already committed, and the
   * bounded backfill inside every observation batch deterministically
   * recreates any job this hook fails to create.
   */
  onAutoPosterNodeCompleted(graphId: string, nodeId: string): void {
    try {
      this.scheduleObservationForNode(graphId, nodeId);
    } catch (error) {
      console.error(
        `Observation job scheduling deferred for graph ${graphId} node ${nodeId}; the next observation batch backfills it.`,
        error,
      );
    }
  }

  /**
   * Creates exactly one durable observation job for one completed AutoPoster
   * schedule node with a valid downstream queue binding. The job id is a
   * pure function of (graph, node); replay returns the existing job, and a
   * replay whose immutable source binding differs fails closed.
   */
  scheduleObservationForNode(
    graphId: string,
    nodeId: string,
  ): AutoPosterObservationScheduleOutcome {
    const node = this.readAutoPosterNode(graphId, nodeId);
    if (node.status !== "completed") {
      return { created: false, skippedReason: "node_not_completed", job: null };
    }
    const binding = this.readDownstreamBinding(node);
    if (!binding) {
      return { created: false, skippedReason: "downstream_binding_missing", job: null };
    }

    const observationJobId = sha256(
      `${OBSERVATION_SCHEMA_VERSION}|job|${node.graph_id}|${node.node_id}`,
    );
    const sourceBinding = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      graphId: node.graph_id,
      nodeId: node.node_id,
      childMissionId: node.child_mission_id,
      childTraceId: node.child_trace_id,
      childIdempotencyKey: node.child_idempotency_key,
      queueJobId: binding.queueJobId,
      workspaceId: binding.workspaceId,
      provider: binding.provider,
      connectedAccountId: binding.connectedAccountId,
      accountId: binding.accountId,
    };
    const sourceBindingJson = JSON.stringify(sourceBinding);
    const sourceBindingHash = sha256(sourceBindingJson);
    const timestamp = this.now().toISOString();
    const firstAttemptAt = this.delayedTimestamp(this.policy.retryDelaysSeconds[0]!);

    const job = this.withSavepoint(() => {
      const existing = this.readJob(observationJobId);
      if (existing) {
        if (existing.source_binding_hash !== sourceBindingHash) {
          throw new OperatorError(
            "The durable observation job is bound to a different immutable source binding.",
            409,
            "OPERATOR_OBSERVATION_BINDING_MISMATCH",
          );
        }
        return { row: existing, created: false };
      }
      this.database.prepare(`
        INSERT INTO operator_autoposter_observation_jobs (
          observation_job_id, graph_id, node_id, mission_id, workspace_id,
          connected_account_id, account_id, provider, queue_job_id,
          source_binding_json, source_binding_hash, status, attempt_count,
          max_attempts, next_attempt_at, lease_owner, lease_expires_at,
          last_attempt_at, last_success_at, last_error_code,
          last_error_message, convergence_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?,
          NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)
      `).run(
        observationJobId,
        node.graph_id,
        node.node_id,
        node.child_mission_id,
        binding.workspaceId,
        binding.connectedAccountId,
        binding.accountId,
        binding.provider,
        binding.queueJobId,
        sourceBindingJson,
        sourceBindingHash,
        this.policy.maxAttempts,
        firstAttemptAt,
        timestamp,
        timestamp,
      );
      return { row: this.requireJob(observationJobId), created: true };
    });

    return {
      created: job.created,
      skippedReason: null,
      job: this.jobView(job.row),
    };
  }

  /**
   * Bounded deterministic backfill: recreates observation jobs for completed
   * AutoPoster schedule nodes whose inline scheduling was interrupted (crash
   * between node completion and job creation). Idempotent by construction.
   */
  backfillObservationJobs(limit = MAX_BACKFILL_PER_BATCH): number {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), MAX_BACKFILL_PER_BATCH));
    const rows = this.database.prepare(`
      SELECT n.graph_id, n.node_id
        FROM operator_mission_graph_nodes n
        JOIN autoposter_mission_executions e ON e.mission_id = n.child_mission_id
        LEFT JOIN operator_autoposter_observation_jobs j
          ON j.graph_id = n.graph_id AND j.node_id = n.node_id
       WHERE n.product = 'auto_poster' AND n.action = ?
         AND n.status = 'completed'
         AND e.downstream_queue_id IS NOT NULL AND e.downstream_queue_id <> ''
         AND j.observation_job_id IS NULL
       ORDER BY n.graph_id ASC, n.node_id ASC
       LIMIT ?
    `).all(AUTOPOSTER_GRAPH_ACTION, boundedLimit) as unknown as Array<{
      graph_id: string;
      node_id: string;
    }>;
    let created = 0;
    for (const row of rows) {
      const outcome = this.scheduleObservationForNode(row.graph_id, row.node_id);
      if (outcome.created) created += 1;
    }
    return created;
  }

  // ---------------------------------------------------------------------
  // Atomic due-job claiming under bounded leases
  // ---------------------------------------------------------------------

  /**
   * Claims due jobs atomically: pending/waiting jobs whose next attempt is
   * due, plus leased/observing jobs whose lease expired (safe recovery after
   * process death). One BEGIN IMMEDIATE transaction serializes concurrent
   * claimers (in-process and cross-process), so no job is ever double
   * claimed; ordering is deterministic (next_attempt_at, then job id).
   */
  claimDueJobs(input: { leaseOwner: string; batchSize?: number }): AutoPosterObservationJobView[] {
    const leaseOwner = requireActor(input.leaseOwner, "leaseOwner");
    const batchSize = Math.max(
      1,
      Math.min(Math.trunc(input.batchSize ?? this.policy.batchSize), MAX_BATCH_SIZE),
    );
    const nowIso = this.now().toISOString();
    const leaseExpiresAt = this.delayedTimestamp(this.policy.leaseSeconds);

    const claimed = withTransaction(this.database, () => {
      const due = this.database.prepare(`
        SELECT observation_job_id
          FROM operator_autoposter_observation_jobs
         WHERE (status IN ('pending', 'waiting')
                AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
            OR (status IN ('leased', 'observing')
                AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
         ORDER BY next_attempt_at ASC, observation_job_id ASC
         LIMIT ?
      `).all(nowIso, nowIso, batchSize) as unknown as Array<{ observation_job_id: string }>;

      const rows: ObservationJobRow[] = [];
      for (const candidate of due) {
        const update = this.database.prepare(`
          UPDATE operator_autoposter_observation_jobs
             SET status = 'leased', lease_owner = ?, lease_expires_at = ?, updated_at = ?
           WHERE observation_job_id = ?
             AND ((status IN ('pending', 'waiting')
                   AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
               OR (status IN ('leased', 'observing')
                   AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
        `).run(
          leaseOwner,
          leaseExpiresAt,
          nowIso,
          candidate.observation_job_id,
          nowIso,
          nowIso,
        );
        if (Number(update.changes) === 1) {
          rows.push(this.requireJob(candidate.observation_job_id));
        }
      }
      return rows;
    });
    return claimed.map((row) => this.jobView(row));
  }

  // ---------------------------------------------------------------------
  // One bounded observation batch (the P0 operational surface)
  // ---------------------------------------------------------------------

  async runObservationBatch(
    input: { leaseOwner?: unknown; batchSize?: unknown } = {},
  ): Promise<AutoPosterObservationBatchResult> {
    const leaseOwner = input.leaseOwner === undefined
      ? DEFAULT_LEASE_OWNER
      : requireActor(input.leaseOwner, "leaseOwner");
    const parsedBatchSize = Number(input.batchSize ?? this.policy.batchSize);
    if (
      input.batchSize !== undefined
      && (!Number.isInteger(parsedBatchSize) || parsedBatchSize < 1 || parsedBatchSize > MAX_BATCH_SIZE)
    ) {
      throw new OperatorError(
        `batchSize must be an integer between 1 and ${MAX_BATCH_SIZE}.`,
        400,
      );
    }

    const ranAt = this.now().toISOString();
    const backfilledJobs = this.backfillObservationJobs();
    const claimed = this.claimDueJobs({ leaseOwner, batchSize: parsedBatchSize });
    const results: AutoPosterObservationJobRunView[] = [];
    for (const job of claimed) {
      results.push(await this.observeClaimedJob(job.observationJobId, leaseOwner));
    }
    return { ranAt, leaseOwner, backfilledJobs, claimed: claimed.length, results };
  }

  /**
   * One claimed attempt: durably enter `observing` (the attempt is counted
   * before the provider read, so crashes always consume bounded budget),
   * observe through the exact Phase 2E-B path, then converge the job in one
   * transaction together with its append-only attempt telemetry row.
   * Non-OperatorError exceptions propagate (crash semantics): the job stays
   * lease-protected and recovers deterministically after lease expiry.
   */
  private async observeClaimedJob(
    observationJobId: string,
    leaseOwner: string,
  ): Promise<AutoPosterObservationJobRunView> {
    const startedAtMs = this.now().getTime();
    const startedAt = new Date(startedAtMs).toISOString();
    const attemptNumber = this.withSavepoint(() => {
      const update = this.database.prepare(`
        UPDATE operator_autoposter_observation_jobs
           SET status = 'observing', attempt_count = attempt_count + 1,
               last_attempt_at = ?, updated_at = ?
         WHERE observation_job_id = ? AND status = 'leased' AND lease_owner = ?
      `).run(startedAt, startedAt, observationJobId, leaseOwner);
      if (Number(update.changes) !== 1) {
        throw new OperatorError(
          "The claimed observation job lease is no longer held by this worker.",
          409,
          "OPERATOR_OBSERVATION_LEASE_LOST",
        );
      }
      return this.requireJob(observationJobId).attempt_count;
    });

    const job = this.requireJob(observationJobId);
    let refresh: AutoPosterNodeRefreshResult;
    try {
      const observed = await this.projections.observeNodeResult(job.graph_id, job.node_id);
      refresh = observed.result;
    } catch (error) {
      if (!(error instanceof OperatorError)) throw error;
      // Durable Operator truth refused the observation (e.g. the graph or
      // node binding is gone): deterministic terminal failure, never retry.
      refresh = {
        nodeId: job.node_id,
        childMissionId: job.mission_id,
        queueJobId: job.queue_job_id,
        outcome: "failed",
        reasonCode: null,
        projectionStatus: null,
        projection: null,
      };
      const finished = this.now().toISOString();
      return this.convergeJob(job, attemptNumber, leaseOwner, refresh, {
        outcomeClass: "failed_terminal",
        reasonCode: error.code ?? "observation_refused",
        errorCode: error.code ?? "observation_refused",
        errorMessage: error.message,
      }, startedAt, finished, Math.max(0, this.now().getTime() - startedAtMs));
    }

    this.failureInjector?.("after_projection_before_job_convergence", observationJobId);

    const finishedAtMs = this.now().getTime();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const convergence = classifyObservationConvergence(refresh);
    return this.convergeJob(
      job,
      attemptNumber,
      leaseOwner,
      refresh,
      convergence,
      startedAt,
      finishedAt,
      Math.max(0, finishedAtMs - startedAtMs),
    );
  }

  /**
   * Deterministic convergence: exactly one transaction appends the attempt
   * telemetry row and moves the job to its next durable state. Window
   * exhaustion of a still-non-terminal job escalates per policy instead of
   * silently failing or polling forever.
   */
  private convergeJob(
    job: ObservationJobRow,
    attemptNumber: number,
    leaseOwner: string,
    refresh: AutoPosterNodeRefreshResult,
    convergence: Convergence,
    startedAt: string,
    finishedAt: string,
    latencyMs: number,
  ): AutoPosterObservationJobRunView {
    let { outcomeClass, reasonCode, errorCode, errorMessage } = convergence;
    const exhausted = attemptNumber >= job.max_attempts;
    if ((outcomeClass === "continue_observing" || outcomeClass === "transport_retry") && exhausted) {
      outcomeClass = "escalation_required";
      reasonCode = "observation_window_exhausted";
    }

    let retryDelaySeconds: number | null = null;
    let nextAttemptAt: string | null = null;
    if (outcomeClass === "continue_observing" || outcomeClass === "transport_retry") {
      const delays = this.policy.retryDelaysSeconds;
      retryDelaySeconds = delays[Math.min(attemptNumber, delays.length - 1)]!;
      nextAttemptAt = new Date(
        Date.parse(finishedAt) + retryDelaySeconds * 1000,
      ).toISOString();
    }

    const observationSucceeded = refresh.outcome !== "failed";
    let escalationId: string | null = null;

    withTransaction(this.database, () => {
      this.database.prepare(`
        INSERT INTO operator_autoposter_observation_attempts (
          attempt_id, observation_job_id, graph_id, node_id, attempt_number,
          provider, lease_owner, started_at, finished_at, latency_ms,
          outcome_class, refresh_outcome, projection_status, reason_code,
          retry_delay_seconds, next_attempt_at, error_code, error_message
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        sha256(`${OBSERVATION_SCHEMA_VERSION}|attempt|${job.observation_job_id}|${attemptNumber}`),
        job.observation_job_id,
        job.graph_id,
        job.node_id,
        attemptNumber,
        job.provider,
        leaseOwner,
        startedAt,
        finishedAt,
        latencyMs,
        outcomeClass,
        refresh.outcome,
        refresh.projectionStatus,
        reasonCode,
        retryDelaySeconds,
        nextAttemptAt,
        errorCode,
        errorMessage,
      );

      switch (outcomeClass) {
        case "continue_observing":
        case "transport_retry": {
          this.database.prepare(`
            UPDATE operator_autoposter_observation_jobs
               SET status = 'waiting', next_attempt_at = ?, lease_owner = NULL,
                   lease_expires_at = NULL, last_success_at = ?,
                   last_error_code = ?, last_error_message = ?, updated_at = ?
             WHERE observation_job_id = ?
          `).run(
            nextAttemptAt,
            observationSucceeded ? finishedAt : job.last_success_at,
            outcomeClass === "transport_retry" ? errorCode : null,
            outcomeClass === "transport_retry" ? errorMessage : null,
            finishedAt,
            job.observation_job_id,
          );
          break;
        }
        case "converged": {
          this.database.prepare(`
            UPDATE operator_autoposter_observation_jobs
               SET status = 'converged', next_attempt_at = NULL,
                   lease_owner = NULL, lease_expires_at = NULL,
                   last_success_at = ?, last_error_code = NULL,
                   last_error_message = NULL, convergence_reason = ?, updated_at = ?
             WHERE observation_job_id = ?
          `).run(finishedAt, reasonCode, finishedAt, job.observation_job_id);
          break;
        }
        case "failed_terminal": {
          this.database.prepare(`
            UPDATE operator_autoposter_observation_jobs
               SET status = 'failed_terminal', next_attempt_at = NULL,
                   lease_owner = NULL, lease_expires_at = NULL,
                   last_success_at = ?, last_error_code = ?,
                   last_error_message = ?, convergence_reason = ?, updated_at = ?
             WHERE observation_job_id = ?
          `).run(
            observationSucceeded ? finishedAt : job.last_success_at,
            errorCode ?? reasonCode,
            errorMessage,
            reasonCode,
            finishedAt,
            job.observation_job_id,
          );
          break;
        }
        case "escalation_required": {
          escalationId = this.upsertEscalation(job, reasonCode ?? "manual_review_required", finishedAt);
          this.database.prepare(`
            UPDATE operator_autoposter_observation_jobs
               SET status = 'escalation_required', next_attempt_at = NULL,
                   lease_owner = NULL, lease_expires_at = NULL,
                   last_success_at = ?, convergence_reason = ?, updated_at = ?
             WHERE observation_job_id = ?
          `).run(
            observationSucceeded ? finishedAt : job.last_success_at,
            reasonCode,
            finishedAt,
            job.observation_job_id,
          );
          break;
        }
      }
    });

    const converged = this.requireJob(job.observation_job_id);
    return {
      observationJobId: job.observation_job_id,
      graphId: job.graph_id,
      nodeId: job.node_id,
      attemptNumber,
      outcomeClass,
      jobStatus: converged.status,
      projectionStatus: refresh.projectionStatus,
      reasonCode,
      retryDelaySeconds,
      nextAttemptAt,
      escalationId,
    };
  }

  /**
   * Exactly one durable escalation may ever exist per observation job:
   * creation is deterministic and replay returns the existing record.
   */
  private upsertEscalation(
    job: ObservationJobRow,
    reasonCode: string,
    timestamp: string,
  ): string {
    const existing = this.database.prepare(
      "SELECT escalation_id FROM operator_autoposter_observation_escalations WHERE observation_job_id = ?",
    ).get(job.observation_job_id) as { escalation_id: string } | undefined;
    if (existing) return existing.escalation_id;

    const knownReason = reasonCode in ESCALATION_SEVERITY
      ? (reasonCode as AutoPosterObservationEscalationReason)
      : null;
    const severity = knownReason ? ESCALATION_SEVERITY[knownReason] : "high";
    const recommendedHumanAction = knownReason
      ? ESCALATION_HUMAN_ACTION[knownReason]
      : "Inspect the canonical AutoPoster job and the durable Operator projection before any publishing decision.";
    const escalationId = sha256(
      `${OBSERVATION_SCHEMA_VERSION}|escalation|${job.observation_job_id}`,
    );
    const summary =
      `AutoPoster observation for node ${job.node_id} of graph ${job.graph_id} `
      + `(provider ${job.provider}, queue job ${job.queue_job_id}) requires a human: ${reasonCode}.`;
    const evidenceReferences = [
      `graph:${job.graph_id}`,
      `node:${job.node_id}`,
      `child-mission:${job.mission_id}`,
      `autoposter-queue:${job.queue_job_id}`,
      `observation-job:${job.observation_job_id}`,
      `result-projection:${job.graph_id}/${job.node_id}`,
    ];
    this.database.prepare(`
      INSERT INTO operator_autoposter_observation_escalations (
        escalation_id, observation_job_id, graph_id, node_id, reason_code,
        severity, human_action_required, recommended_human_action, summary,
        evidence_refs_json, status, acknowledged_by, acknowledged_at,
        resolved_by, resolved_at, resolution_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 'open', NULL, NULL, NULL, NULL, NULL, ?, ?)
    `).run(
      escalationId,
      job.observation_job_id,
      job.graph_id,
      job.node_id,
      reasonCode,
      severity,
      recommendedHumanAction,
      summary,
      JSON.stringify(evidenceReferences),
      timestamp,
      timestamp,
    );
    return escalationId;
  }

  // ---------------------------------------------------------------------
  // Escalation control (Operator control authority only; routed with the
  // control capability token — submit/ledger capabilities can never reach it)
  // ---------------------------------------------------------------------

  acknowledgeEscalation(
    escalationId: string,
    body: { acknowledgedBy?: unknown },
  ): AutoPosterObservationEscalationView {
    const acknowledgedBy = requireActor(body.acknowledgedBy, "acknowledgedBy");
    const timestamp = this.now().toISOString();
    const row = this.withSavepoint(() => {
      const escalation = this.requireEscalation(escalationId);
      if (escalation.status === "acknowledged") return escalation; // idempotent replay
      if (escalation.status !== "open") {
        throw new OperatorError(
          `Escalation cannot be acknowledged from terminal status ${escalation.status}.`,
          409,
          "OPERATOR_ESCALATION_STATE_TERMINAL",
        );
      }
      this.database.prepare(`
        UPDATE operator_autoposter_observation_escalations
           SET status = 'acknowledged', acknowledged_by = ?, acknowledged_at = ?, updated_at = ?
         WHERE escalation_id = ? AND status = 'open'
      `).run(acknowledgedBy, timestamp, timestamp, escalationId);
      return this.requireEscalation(escalationId);
    });
    return this.escalationView(row);
  }

  resolveEscalation(
    escalationId: string,
    body: { resolvedBy?: unknown; disposition?: unknown; note?: unknown },
  ): AutoPosterObservationEscalationView {
    const resolvedBy = requireActor(body.resolvedBy, "resolvedBy");
    const disposition = body.disposition === undefined ? "resolved" : String(body.disposition);
    if (disposition !== "resolved" && disposition !== "dismissed") {
      throw new OperatorError(
        "disposition must be 'resolved' or 'dismissed'.",
        400,
      );
    }
    const note = typeof body.note === "string" && body.note.trim()
      ? body.note.trim().slice(0, 500)
      : null;
    const timestamp = this.now().toISOString();
    const row = this.withSavepoint(() => {
      const escalation = this.requireEscalation(escalationId);
      if (escalation.status === disposition) return escalation; // idempotent replay
      if (escalation.status !== "open" && escalation.status !== "acknowledged") {
        throw new OperatorError(
          `Escalation cannot be ${disposition} from terminal status ${escalation.status}.`,
          409,
          "OPERATOR_ESCALATION_STATE_TERMINAL",
        );
      }
      this.database.prepare(`
        UPDATE operator_autoposter_observation_escalations
           SET status = ?, resolved_by = ?, resolved_at = ?, resolution_note = ?, updated_at = ?
         WHERE escalation_id = ? AND status IN ('open', 'acknowledged')
      `).run(disposition, resolvedBy, timestamp, note, timestamp, escalationId);
      return this.requireEscalation(escalationId);
    });
    return this.escalationView(row);
  }

  // ---------------------------------------------------------------------
  // Bounded reads
  // ---------------------------------------------------------------------

  getJobDetail(observationJobId: string): {
    job: AutoPosterObservationJobView;
    attempts: AutoPosterObservationAttemptView[];
    escalation: AutoPosterObservationEscalationView | null;
  } {
    const job = this.requireJob(String(observationJobId || "").trim());
    const attempts = this.database.prepare(`
      SELECT * FROM operator_autoposter_observation_attempts
       WHERE observation_job_id = ?
       ORDER BY attempt_number ASC
    `).all(job.observation_job_id) as unknown as Array<Record<string, unknown>>;
    const escalation = this.database.prepare(
      "SELECT * FROM operator_autoposter_observation_escalations WHERE observation_job_id = ?",
    ).get(job.observation_job_id) as ObservationEscalationRow | undefined;
    return {
      job: this.jobView(job),
      attempts: attempts.map((row) => this.attemptView(row)),
      escalation: escalation ? this.escalationView(escalation) : null,
    };
  }

  listJobs(query: {
    status?: unknown;
    graphId?: unknown;
    due?: unknown;
    limit?: unknown;
    offset?: unknown;
  } = {}): { jobs: AutoPosterObservationJobView[]; limit: number; offset: number } {
    const limit = this.boundedLimit(query.limit);
    const offset = this.boundedOffset(query.offset);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (typeof query.status === "string" && query.status.trim()) {
      const status = query.status.trim();
      if (!(AUTOPOSTER_OBSERVATION_JOB_STATUSES as readonly string[]).includes(status)) {
        throw new OperatorError("Unknown observation job status filter.", 400);
      }
      clauses.push("status = ?");
      parameters.push(status);
    }
    if (typeof query.graphId === "string" && query.graphId.trim()) {
      clauses.push("graph_id = ?");
      parameters.push(query.graphId.trim());
    }
    if (query.due === true || query.due === "true") {
      const nowIso = this.now().toISOString();
      clauses.push(`((status IN ('pending', 'waiting')
        AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?)
        OR (status IN ('leased', 'observing')
        AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`);
      parameters.push(nowIso, nowIso);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT * FROM operator_autoposter_observation_jobs
      ${where}
      ORDER BY created_at ASC, observation_job_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as unknown as ObservationJobRow[];
    return { jobs: rows.map((row) => this.jobView(row)), limit, offset };
  }

  getEscalation(escalationId: string): AutoPosterObservationEscalationView {
    return this.escalationView(this.requireEscalation(String(escalationId || "").trim()));
  }

  listEscalations(query: {
    status?: unknown;
    graphId?: unknown;
    limit?: unknown;
    offset?: unknown;
  } = {}): {
    escalations: AutoPosterObservationEscalationView[];
    limit: number;
    offset: number;
  } {
    const limit = this.boundedLimit(query.limit);
    const offset = this.boundedOffset(query.offset);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (typeof query.status === "string" && query.status.trim()) {
      const status = query.status.trim();
      if (!(AUTOPOSTER_OBSERVATION_ESCALATION_STATUSES as readonly string[]).includes(status)) {
        throw new OperatorError("Unknown escalation status filter.", 400);
      }
      clauses.push("status = ?");
      parameters.push(status);
    }
    if (typeof query.graphId === "string" && query.graphId.trim()) {
      clauses.push("graph_id = ?");
      parameters.push(query.graphId.trim());
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.database.prepare(`
      SELECT * FROM operator_autoposter_observation_escalations
      ${where}
      ORDER BY created_at ASC, escalation_id ASC
      LIMIT ? OFFSET ?
    `).all(...parameters, limit, offset) as unknown as ObservationEscalationRow[];
    return { escalations: rows.map((row) => this.escalationView(row)), limit, offset };
  }

  /**
   * Internal terminal cancellation (not routed in P0): parks one
   * non-terminal job as cancelled so it can never be claimed again.
   */
  cancelJob(
    observationJobId: string,
    body: { cancelledBy?: unknown; reason?: unknown },
  ): AutoPosterObservationJobView {
    const cancelledBy = requireActor(body.cancelledBy, "cancelledBy");
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : "A human cancelled the observation job before convergence.";
    const timestamp = this.now().toISOString();
    const row = this.withSavepoint(() => {
      const job = this.requireJob(String(observationJobId || "").trim());
      if (job.status === "cancelled") return job; // idempotent replay
      if (TERMINAL_JOB_STATUSES.has(job.status)) {
        throw new OperatorError(
          `Observation job cannot be cancelled from terminal status ${job.status}.`,
          409,
          "OPERATOR_OBSERVATION_STATE_TERMINAL",
        );
      }
      this.database.prepare(`
        UPDATE operator_autoposter_observation_jobs
           SET status = 'cancelled', next_attempt_at = NULL, lease_owner = NULL,
               lease_expires_at = NULL, last_error_code = 'cancelled',
               last_error_message = ?, convergence_reason = 'cancelled', updated_at = ?
         WHERE observation_job_id = ? AND status NOT IN (
           'converged', 'escalation_required', 'failed_terminal', 'cancelled'
         )
      `).run(`${reason} (by ${cancelledBy})`, timestamp, job.observation_job_id);
      return this.requireJob(job.observation_job_id);
    });
    return this.jobView(row);
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private readAutoPosterNode(graphId: string, nodeId: string): GraphNodeRow {
    const row = this.database.prepare(`
      SELECT graph_id, node_id, status, child_mission_id, child_trace_id,
             child_idempotency_key, result_summary_json
        FROM operator_mission_graph_nodes
       WHERE graph_id = ? AND node_id = ? AND product = 'auto_poster' AND action = ?
    `).get(
      String(graphId || "").trim(),
      String(nodeId || "").trim(),
      AUTOPOSTER_GRAPH_ACTION,
    ) as GraphNodeRow | undefined;
    if (!row) {
      throw new OperatorError(
        "Mission graph node is not an AutoPoster schedule node.",
        404,
        "OPERATOR_OBSERVATION_NODE_NOT_FOUND",
      );
    }
    return row;
  }

  /**
   * Recovers the durable downstream binding for one completed node. Returns
   * null when the node never reached a valid downstream queue binding (such
   * nodes are never observed automatically). A summary/execution queue-id
   * contradiction still yields the canonical execution binding: the first
   * strict observation attempt detects the contradiction through the exact
   * Phase 2E-B identity validation and fails the job terminally.
   */
  private readDownstreamBinding(node: GraphNodeRow): {
    queueJobId: string;
    workspaceId: string;
    accountId: string;
    provider: string;
    connectedAccountId: string;
  } | null {
    const mission = this.database.prepare(
      "SELECT workspace_id, account_id, provider FROM autoposter_runtime_missions WHERE mission_id = ?",
    ).get(node.child_mission_id) as
      | { workspace_id: string; account_id: string; provider: string }
      | undefined;
    if (!mission) return null;
    const execution = this.database.prepare(
      "SELECT downstream_queue_id FROM autoposter_mission_executions WHERE mission_id = ?",
    ).get(node.child_mission_id) as { downstream_queue_id: string | null } | undefined;
    const executionQueueId = typeof execution?.downstream_queue_id === "string"
      && execution.downstream_queue_id.trim()
      ? execution.downstream_queue_id
      : null;
    const summary = node.result_summary_json
      ? (JSON.parse(node.result_summary_json) as Record<string, unknown>)
      : null;
    const summaryQueueId = typeof summary?.queueDraftId === "string" && summary.queueDraftId.trim()
      ? summary.queueDraftId
      : null;
    const queueJobId = executionQueueId ?? summaryQueueId;
    if (!queueJobId) return null;
    return {
      queueJobId,
      workspaceId: mission.workspace_id,
      accountId: mission.account_id,
      provider: mission.provider,
      connectedAccountId: `${mission.provider}:${mission.account_id}`,
    };
  }

  private delayedTimestamp(seconds: number): string {
    return new Date(this.now().getTime() + seconds * 1000).toISOString();
  }

  private boundedLimit(value: unknown): number {
    const parsed = Number(value ?? 25);
    if (!Number.isFinite(parsed)) return 25;
    return Math.max(1, Math.min(Math.trunc(parsed), MAX_LIST_LIMIT));
  }

  private boundedOffset(value: unknown): number {
    const parsed = Number(value ?? 0);
    if (!Number.isFinite(parsed)) return 0;
    return Math.max(0, Math.trunc(parsed));
  }

  private readJob(observationJobId: string): ObservationJobRow | null {
    const row = this.database.prepare(
      "SELECT * FROM operator_autoposter_observation_jobs WHERE observation_job_id = ?",
    ).get(observationJobId) as ObservationJobRow | undefined;
    return row ?? null;
  }

  private requireJob(observationJobId: string): ObservationJobRow {
    const row = this.readJob(observationJobId);
    if (!row) {
      throw new OperatorError("Observation job was not found.", 404);
    }
    return row;
  }

  private requireEscalation(escalationId: string): ObservationEscalationRow {
    const row = this.database.prepare(
      "SELECT * FROM operator_autoposter_observation_escalations WHERE escalation_id = ?",
    ).get(escalationId) as ObservationEscalationRow | undefined;
    if (!row) {
      throw new OperatorError("Observation escalation was not found.", 404);
    }
    return row;
  }

  private jobView(row: ObservationJobRow): AutoPosterObservationJobView {
    return {
      observationJobId: row.observation_job_id,
      graphId: row.graph_id,
      nodeId: row.node_id,
      missionId: row.mission_id,
      workspaceId: row.workspace_id,
      connectedAccountId: row.connected_account_id,
      accountId: row.account_id,
      provider: row.provider,
      queueJobId: row.queue_job_id,
      sourceBinding: JSON.parse(row.source_binding_json) as unknown,
      sourceBindingHash: row.source_binding_hash,
      status: row.status,
      attemptCount: Number(row.attempt_count),
      maxAttempts: Number(row.max_attempts),
      nextAttemptAt: row.next_attempt_at,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: row.lease_expires_at,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      lastErrorCode: row.last_error_code,
      lastErrorMessage: row.last_error_message,
      convergenceReason: row.convergence_reason,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private attemptView(row: Record<string, unknown>): AutoPosterObservationAttemptView {
    return {
      attemptId: String(row.attempt_id),
      observationJobId: String(row.observation_job_id),
      graphId: String(row.graph_id),
      nodeId: String(row.node_id),
      attemptNumber: Number(row.attempt_number),
      provider: String(row.provider),
      leaseOwner: String(row.lease_owner),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
      latencyMs: Number(row.latency_ms),
      outcomeClass: String(row.outcome_class) as AutoPosterObservationOutcomeClass,
      refreshOutcome: String(row.refresh_outcome),
      projectionStatus: row.projection_status === null ? null : String(row.projection_status),
      reasonCode: row.reason_code === null ? null : String(row.reason_code),
      retryDelaySeconds: row.retry_delay_seconds === null ? null : Number(row.retry_delay_seconds),
      nextAttemptAt: row.next_attempt_at === null ? null : String(row.next_attempt_at),
      errorCode: row.error_code === null ? null : String(row.error_code),
      errorMessage: row.error_message === null ? null : String(row.error_message),
    };
  }

  private escalationView(row: ObservationEscalationRow): AutoPosterObservationEscalationView {
    return {
      escalationId: row.escalation_id,
      observationJobId: row.observation_job_id,
      graphId: row.graph_id,
      nodeId: row.node_id,
      reasonCode: row.reason_code,
      severity: row.severity,
      humanActionRequired: row.human_action_required === 1,
      recommendedHumanAction: row.recommended_human_action,
      summary: row.summary,
      evidenceReferences: JSON.parse(row.evidence_refs_json) as string[],
      status: row.status,
      acknowledgedBy: row.acknowledged_by,
      acknowledgedAt: row.acknowledged_at,
      resolvedBy: row.resolved_by,
      resolvedAt: row.resolved_at,
      resolutionNote: row.resolution_note,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Nesting-safe atomic section (mirrors MissionGraphJournal): SAVEPOINTs
   * compose with an enclosing transaction, and outside one they still form
   * an atomic unit. Claiming keeps BEGIN IMMEDIATE via withTransaction for
   * cross-process serialization.
   */
  private withSavepoint<T>(operation: () => T): T {
    this.database.exec("SAVEPOINT autoposter_observation_atomic");
    try {
      const result = operation();
      this.database.exec("RELEASE SAVEPOINT autoposter_observation_atomic");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT autoposter_observation_atomic");
      this.database.exec("RELEASE SAVEPOINT autoposter_observation_atomic");
      throw error;
    }
  }
}
