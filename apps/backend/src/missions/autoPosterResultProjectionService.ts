/**
 * Phase 2E-B durable AutoPoster result projection.
 *
 * Manual, founder-triggered collection of publishing lifecycle truth for one
 * completed AutoPoster schedule graph. This service is a read-model over
 * AutoPoster's canonical job state — never a second publishing database:
 *
 *   - it reads at most eight exact persisted queue job IDs through the
 *     strict Agent Runtime status contract (one bounded read each, no retry,
 *     no provider call, no AutoPoster write);
 *   - it validates every response against the durable graph/node/child/job
 *     identity binding and fails closed on any contradiction;
 *   - it persists one projection row per (graph_id, node_id) plus
 *     append-only observation events, keyed by source `updatedAt` and a
 *     canonical allowlisted snapshot hash (exact replay appends nothing,
 *     older revisions never overwrite newer ones, and a same-revision
 *     different-hash contradiction escalates instead of choosing silently);
 *   - it never mutates Phase 2E-A graph or node execution status, never
 *     approves/publishes/retries anything, and never claims public
 *     visibility that no provider proves.
 */
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AutoPosterPortFailure,
  AutoPosterPostStatusView,
} from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { AUTOPOSTER_RESULT_PROJECTION_STATUSES } from "../db/schema.js";
import { OperatorError } from "../services/operatorService.js";
import {
  findForbiddenProviderMaterial,
  OPERATOR_PROVIDER_MATERIAL_MESSAGE,
} from "../security/providerSafety.js";
import type { AutoPosterRuntimeMissionExecutor } from "../runtimeMissions/autoPosterRuntime.js";
import { isExactPrivateProviderProof } from "./autoPosterProviderPredicates.js";

const AUTOPOSTER_GRAPH_ACTION = "autoposter.post.schedule";
const MAX_RESULT_READS_PER_REFRESH = 8;
const TERMINAL_YOUTUBE_PROVIDER_OPERATION_STATES = new Set([
  "completed_private",
  "contradictory_public",
  "provider_missing",
  "terminal_failure",
]);
const ESCALATION_SCHEMA_VERSION = "chanter.autoposter.result-escalation.v1";
// Known stable AutoPoster admin surfaces. There is no reviewed per-job
// deep-link contract, so escalations return these routes plus the opaque
// queue job ID and never fabricate URLs.
const AUTOPOSTER_ADMIN_ROUTES = ["/private/autoposter", "/private/autoposter/dashboard"] as const;

export type AutoPosterResultProjectionStatus =
  (typeof AUTOPOSTER_RESULT_PROJECTION_STATUSES)[number];

export type AutoPosterResultEscalationReason =
  | "publish_failed"
  | "outcome_unknown"
  | "provider_reauthorization_required"
  | "media_unavailable"
  | "publish_approval_required"
  | "publish_approval_revoked"
  | "processing_unresolved"
  | "partial_batch"
  | "result_identity_mismatch"
  | "result_collection_unavailable"
  | "provider_missing"
  | "provider_visibility_contradiction"
  | "provider_operation_ambiguous"
  | "legacy_unproven"
  | "observation_contradiction";

export type AutoPosterResultEscalationSeverity = "info" | "warning" | "high" | "critical";

/** Bounded deterministic founder escalation payload (advisory only; never an action). */
export interface AutoPosterResultEscalation {
  schemaVersion: typeof ESCALATION_SCHEMA_VERSION;
  escalationId: string;
  graphId: string;
  graphHash: string;
  nodeId: string | null;
  childMissionId: string | null;
  childTraceId: string | null;
  queueJobId: string | null;
  workspaceId: string | null;
  provider: string | null;
  connectedAccountId: string | null;
  accountId: string | null;
  sourceStatus: string | null;
  providerStatus: string | null;
  projectionStatus: AutoPosterResultProjectionStatus | null;
  approved: boolean | null;
  approvedAt: string | null;
  approvedBy: string | null;
  scheduledAt: string | null;
  sourceUpdatedAt: string | null;
  postedAt: string | null;
  lockedAt: string | null;
  observedAt: string;
  claimAttempts: number | null;
  publishAttemptBudget: number | null;
  attemptBudgetExhausted: boolean | null;
  history: Array<{ at: string | null; event: string; detail: string }>;
  publishId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  reasonCode: AutoPosterResultEscalationReason;
  severity: AutoPosterResultEscalationSeverity;
  recommendedHumanAction: string;
  canonicalInspection: { adminRoutes: string[]; queueJobId: string | null };
  evidenceReferences: string[];
  snapshotHash: string | null;
}

export interface AutoPosterResultProjectionView {
  graphId: string;
  nodeId: string;
  graphHash: string;
  childMissionId: string;
  childTraceId: string;
  queueJobId: string;
  provider: string;
  connectedAccountId: string;
  accountId: string;
  workspaceId: string;
  sourceStatus: string;
  providerStatus: string;
  projectionStatus: AutoPosterResultProjectionStatus;
  approved: boolean;
  sourceUpdatedAt: string;
  observedAt: string;
  snapshotHash: string;
  evidence: unknown;
  escalationReason: string | null;
  escalationSeverity: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AutoPosterNodeRefreshOutcome = "refreshed" | "replayed" | "stale" | "failed";

export interface AutoPosterNodeRefreshResult {
  nodeId: string;
  childMissionId: string;
  queueJobId: string | null;
  outcome: AutoPosterNodeRefreshOutcome;
  reasonCode: AutoPosterResultEscalationReason | "schedule_evidence_missing" | null;
  projectionStatus: AutoPosterResultProjectionStatus | null;
  projection: AutoPosterResultProjectionView | null;
}

export type AutoPosterResultBatchStatus =
  | "awaiting_results"
  | "completed_with_warning"
  | "failed"
  | "outcome_unknown";

export interface AutoPosterResultBatchSummary {
  status: AutoPosterResultBatchStatus;
  nodeCount: number;
  observedCount: number;
  totals: Record<AutoPosterResultProjectionStatus, number>;
}

export interface AutoPosterResultRefreshResponse {
  graphId: string;
  graphHash: string;
  refreshedAt: string;
  results: AutoPosterNodeRefreshResult[];
  batch: AutoPosterResultBatchSummary;
  escalations: AutoPosterResultEscalation[];
}

export interface AutoPosterResultProjectionsResponse {
  graphId: string;
  graphHash: string;
  nodes: Array<{
    nodeId: string;
    childMissionId: string;
    projection: AutoPosterResultProjectionView | null;
  }>;
  batch: AutoPosterResultBatchSummary;
}

interface GraphRow {
  graph_id: string;
  graph_hash: string;
  workspace_id: string | null;
  tenant_user_id: string;
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

interface MissionBindingRow {
  workspace_id: string;
  account_id: string;
  provider: string;
}

interface ProjectionRow {
  graph_id: string;
  node_id: string;
  graph_hash: string;
  child_mission_id: string;
  child_trace_id: string;
  queue_job_id: string;
  provider: string;
  connected_account_id: string;
  account_id: string;
  workspace_id: string;
  source_status: string;
  provider_status: string;
  projection_status: AutoPosterResultProjectionStatus;
  approved: number;
  source_updated_at: string;
  observed_at: string;
  snapshot_hash: string;
  evidence_json: string;
  escalation_reason: string | null;
  escalation_severity: string | null;
  created_at: string;
  updated_at: string;
}

interface CanonicalObservation {
  graphId: string;
  nodeId: string;
  queueJobId: string;
  sourceUpdatedAt: string;
  snapshot: {
    provider: string;
    connectedAccountId: string;
    accountId: string;
    workspaceId: string;
    sourceStatus: string;
    providerStatus: string;
    approved: boolean;
    approvalState: string;
    approvedAt: string | null;
    approvedBy: string;
    scheduledAt: string | null;
    createdAt: string | null;
    postedAt: string | null;
    lockedAt: string | null;
    claimAttempts: number;
    publishAttemptBudget: number;
    attemptBudgetExhausted: boolean;
    publishId: string;
    providerVerification: AutoPosterPostStatusView["providerVerification"];
    providerOperation: AutoPosterPostStatusView["providerOperation"];
    runtimeMissionId: string;
    runtimeIdempotencyKey: string;
    runtimeAction: string;
    runtimePayloadHash: string;
    lastResult: AutoPosterPostStatusView["lastResult"];
    history: AutoPosterPostStatusView["history"];
    lastErrorMessage: string;
  };
}

interface Classification {
  status: AutoPosterResultProjectionStatus;
  escalationReason: AutoPosterResultEscalationReason | null;
  severity: AutoPosterResultEscalationSeverity | null;
}

const NONTERMINAL_PROJECTION_STATUSES = new Set<AutoPosterResultProjectionStatus>([
  "awaiting_publish_approval",
  "approved_for_publish",
  "processing",
  "retry_scheduled",
]);

const RECOMMENDED_HUMAN_ACTIONS: Record<AutoPosterResultEscalationReason, string> = {
  publish_failed:
    "Inspect the job in the canonical AutoPoster admin surface, correct the cause there, and use the AutoPoster website retry only after confirming the failure.",
  outcome_unknown:
    "Reconcile this job manually against the provider and AutoPoster; never approve or retry it automatically.",
  provider_reauthorization_required:
    "Reauthorize the exact connected account in AutoPoster, then refresh the Operator projection.",
  media_unavailable:
    "Repair or replace the media in AutoPoster; no Operator mutation can fix it.",
  publish_approval_required:
    "Review the canonical draft in AutoPoster; publish approval remains an AutoPoster human action.",
  publish_approval_revoked:
    "Approval was revoked in AutoPoster; review the canonical draft before any publishing decision.",
  processing_unresolved:
    "Inspect AutoPoster scheduler health and the canonical job; never reclaim it from the Operator.",
  partial_batch:
    "Some nodes could not be refreshed; successful observations were preserved. Retry the manual refresh for the failed nodes.",
  result_identity_mismatch:
    "Stop collection for this node and inspect the graph child, queue job ID, workspace, provider, and account bindings.",
  result_collection_unavailable:
    "Preserve the last confirmed projection and retry the manual refresh later; do not relabel the AutoPoster job.",
  provider_missing:
    "The persisted YouTube operation could not find its provider artifact or session; inspect the exact queue job without creating another session.",
  provider_visibility_contradiction:
    "YouTube reported public or unlisted visibility against the private-only contract; inspect the exact artifact immediately.",
  provider_operation_ambiguous:
    "The persisted YouTube operation remains ambiguous after bounded same-session reconciliation; do not retry or create another session.",
  legacy_unproven:
    "This historical YouTube result has no authoritative completed-private provider operation and remains explicitly unproven.",
  observation_contradiction:
    "AutoPoster evidence contradicts itself for one source revision; inspect the canonical job before trusting either snapshot.",
};

const SEVERITY_BY_REASON: Record<AutoPosterResultEscalationReason, AutoPosterResultEscalationSeverity> = {
  publish_failed: "high",
  outcome_unknown: "critical",
  provider_reauthorization_required: "high",
  media_unavailable: "high",
  publish_approval_required: "info",
  publish_approval_revoked: "warning",
  processing_unresolved: "warning",
  partial_batch: "warning",
  result_identity_mismatch: "high",
  result_collection_unavailable: "warning",
  provider_missing: "critical",
  provider_visibility_contradiction: "critical",
  provider_operation_ambiguous: "critical",
  legacy_unproven: "warning",
  observation_contradiction: "critical",
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseTimeMs(value: string): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function classifyFailureReason(
  post: AutoPosterPostStatusView,
): AutoPosterResultEscalationReason {
  const evidence = `${post.lastResult?.code ?? ""} ${post.lastResult?.message ?? ""} ${post.lastErrorMessage}`;
  if (/auth|scope|permission|credential|reauthorize|unauthorized|forbidden/i.test(evidence)) {
    return "provider_reauthorization_required";
  }
  if (/media|download|file|asset|not[_ ]?video|unsupported[_ ]?url/i.test(evidence)) {
    return "media_unavailable";
  }
  return "publish_failed";
}

/**
 * Derives the one bounded Operator projection status from exact AutoPoster
 * evidence. Provider-specific meanings stay explicit: YouTube `posted` is a
 * private upload, TikTok `posted` is API acceptance without visibility
 * proof, and anything contradicting required terminal evidence fails closed
 * to manual review instead of being normalized.
 */
function classifyObservation(post: AutoPosterPostStatusView): Classification {
  const operation = post.provider === "youtube" ? post.providerOperation : null;
  if (operation) {
    if (operation.operationState === "completed_private") {
      if (isExactPrivateProviderProof(post)) return { status: "uploaded_private", escalationReason: null, severity: null };
      return { status: "manual_review_required", escalationReason: "observation_contradiction", severity: "critical" };
    }
    if (operation.operationState === "contradictory_public") {
      return { status: "manual_review_required", escalationReason: "provider_visibility_contradiction", severity: "critical" };
    }
    if (operation.operationState === "provider_missing") {
      return { status: "outcome_unknown", escalationReason: "provider_missing", severity: "critical" };
    }
    if (
      operation.mutationSummary.providerSessionInitiationCount > 0
      || ["session_persisted", "uploading", "resumable", "outcome_unknown"].includes(operation.operationState)
    ) {
      return { status: "outcome_unknown", escalationReason: "provider_operation_ambiguous", severity: "critical" };
    }
  }
  const latestEvent = post.history.length > 0 ? post.history[post.history.length - 1]!.event : "";
  const wasRevoked = post.history.some((entry) => entry.event === "approval_revoked");

  switch (post.status) {
    case "pending":
    case "scheduled":
    case "ready": {
      if (!post.approved) {
        return wasRevoked
          ? { status: "awaiting_publish_approval", escalationReason: "publish_approval_revoked", severity: "warning" }
          : { status: "awaiting_publish_approval", escalationReason: "publish_approval_required", severity: "info" };
      }
      if (post.lastResult?.willRetry === true || latestEvent === "retry_scheduled") {
        return { status: "retry_scheduled", escalationReason: null, severity: null };
      }
      return { status: "approved_for_publish", escalationReason: null, severity: null };
    }
    case "processing":
      return { status: "processing", escalationReason: null, severity: null };
    case "failed": {
      const reason = classifyFailureReason(post);
      return { status: "failed", escalationReason: reason, severity: SEVERITY_BY_REASON[reason] };
    }
    case "outcome_unknown":
      return { status: "outcome_unknown", escalationReason: "outcome_unknown", severity: "critical" };
    case "posted": {
      const manual = post.lastResult?.mode === "manual"
        || post.history.some((entry) => entry.event === "marked_posted");
      if (manual) {
        return { status: "manually_reconciled", escalationReason: null, severity: null };
      }
      if (!post.approved) {
        // A non-manual publish cannot have happened without approval.
        return { status: "manual_review_required", escalationReason: "observation_contradiction", severity: "critical" };
      }
      if (post.provider === "youtube") {
        return { status: "manual_review_required", escalationReason: "legacy_unproven", severity: "warning" };
      }
      return { status: "provider_accepted_unverified", escalationReason: null, severity: null };
    }
  }
}

/** Phase 2E-C crash simulation boundary: after the strict status read, before durable persistence. */
export type AutoPosterResultObservationBoundary = "after_status_read_before_persistence";

export class AutoPosterResultProjectionService {
  private readonly now: () => Date;
  private readonly failureInjector?: (
    boundary: AutoPosterResultObservationBoundary,
    graphId: string,
    nodeId: string,
  ) => void;

  constructor(
    private readonly database: DatabaseSync,
    private readonly executor: Pick<AutoPosterRuntimeMissionExecutor, "configured" | "getPostStatus" | "reconcileProviderOperation">,
    options: {
      now?: () => Date;
      failureInjector?: (
        boundary: AutoPosterResultObservationBoundary,
        graphId: string,
        nodeId: string,
      ) => void;
    } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.failureInjector = options.failureInjector;
  }

  /**
   * Phase 2E-C single-node observation: exactly the reviewed Phase 2E-B
   * per-node refresh (one bounded strict status read, identity fail-closed
   * validation, idempotent durable projection + append-only evidence) for
   * one AutoPoster schedule node. Adds no new provider semantics — the
   * observation loop converges its own job state from this result.
   */
  async observeNodeResult(
    graphId: string,
    nodeId: string,
  ): Promise<{ result: AutoPosterNodeRefreshResult; escalation?: AutoPosterResultEscalation }> {
    const graph = this.requireGraph(graphId);
    const node = this.autoPosterNodes(graph.graph_id)
      .find((candidate) => candidate.node_id === String(nodeId || "").trim());
    if (!node) {
      throw new OperatorError(
        "Mission graph node is not an AutoPoster schedule node.",
        404,
        "OPERATOR_GRAPH_RESULTS_NOT_APPLICABLE",
      );
    }
    return this.refreshNode(graph, node, this.now().toISOString());
  }

  /** Stored projections and batch summary only — never network work. */
  getProjections(graphId: string): AutoPosterResultProjectionsResponse {
    const graph = this.requireGraph(graphId);
    const nodes = this.autoPosterNodes(graph.graph_id);
    const views = nodes.map((node) => ({
      nodeId: node.node_id,
      childMissionId: node.child_mission_id,
      projection: this.projectionView(this.readProjection(graph.graph_id, node.node_id)),
    }));
    return {
      graphId: graph.graph_id,
      graphHash: graph.graph_hash,
      nodes: views,
      batch: this.batchSummary(nodes.length, views.map((view) => view.projection)),
    };
  }

  /**
   * Founder/operator-triggered refresh: one bounded exact status read per
   * completed AutoPoster node, durable idempotent projection, per-node
   * independent outcomes, and advisory escalations. YouTube records that
   * already carry a durable provider operation receive one exact Runtime
   * reconciliation call before projection; this never creates another
   * provider session, re-executes a child mission, or changes graph state.
   */
  async refreshGraphResults(graphId: string): Promise<AutoPosterResultRefreshResponse> {
    const graph = this.requireGraph(graphId);
    const nodes = this.autoPosterNodes(graph.graph_id);
    if (nodes.length === 0) {
      throw new OperatorError(
        "Mission graph has no AutoPoster schedule nodes to collect results for.",
        409,
        "OPERATOR_GRAPH_RESULTS_NOT_APPLICABLE",
      );
    }

    const observedAt = this.now().toISOString();
    const results: AutoPosterNodeRefreshResult[] = [];
    const escalations: AutoPosterResultEscalation[] = [];

    for (const node of nodes.slice(0, MAX_RESULT_READS_PER_REFRESH)) {
      const { result, escalation } = await this.refreshNode(graph, node, observedAt);
      results.push(result);
      if (escalation) escalations.push(escalation);
    }

    const projections = results.map((result) => result.projection);
    const batch = this.batchSummary(nodes.length, projections);

    const failedNodes = results.filter((result) => result.outcome === "failed");
    if (failedNodes.length > 0 && failedNodes.length < results.length) {
      escalations.push(this.escalation({
        graph,
        node: null,
        queueJobId: null,
        post: null,
        projectionStatus: null,
        reasonCode: "partial_batch",
        observedAt,
        snapshotHash: null,
        detail: `${failedNodes.length} of ${results.length} node refreshes failed; successful observations were preserved.`,
      }));
    }

    return {
      graphId: graph.graph_id,
      graphHash: graph.graph_hash,
      refreshedAt: observedAt,
      results,
      batch,
      escalations,
    };
  }

  // -------------------------------------------------------------------------
  // Per-node refresh
  // -------------------------------------------------------------------------

  private async refreshNode(
    graph: GraphRow,
    node: GraphNodeRow,
    observedAt: string,
  ): Promise<{ result: AutoPosterNodeRefreshResult; escalation?: AutoPosterResultEscalation }> {
    const nodeResult = (
      outcome: AutoPosterNodeRefreshOutcome,
      reasonCode: AutoPosterNodeRefreshResult["reasonCode"],
      queueJobId: string | null,
    ): AutoPosterNodeRefreshResult => {
      const projection = this.projectionView(this.readProjection(graph.graph_id, node.node_id));
      return {
        nodeId: node.node_id,
        childMissionId: node.child_mission_id,
        queueJobId,
        outcome,
        reasonCode,
        projectionStatus: projection?.projectionStatus ?? null,
        projection,
      };
    };

    // 1) Recover the exact persisted queue identity from Phase 2E-A evidence.
    if (node.status !== "completed") {
      return { result: nodeResult("failed", "schedule_evidence_missing", null) };
    }
    const summary = node.result_summary_json
      ? (JSON.parse(node.result_summary_json) as Record<string, unknown>)
      : null;
    const summaryQueueId = typeof summary?.queueDraftId === "string" && summary.queueDraftId.trim()
      ? summary.queueDraftId
      : null;
    const executionQueueId = this.readExecutionQueueId(node.child_mission_id);
    const binding = this.readMissionBinding(node.child_mission_id);
    if (!binding || (!summaryQueueId && !executionQueueId)) {
      return { result: nodeResult("failed", "schedule_evidence_missing", null) };
    }
    if (summaryQueueId && executionQueueId && summaryQueueId !== executionQueueId) {
      const escalation = this.persistMismatch({
        graph,
        node,
        queueJobId: executionQueueId,
        binding,
        post: null,
        observedAt,
        detail: "The graph-node result summary and the durable mission execution disagree about the exact queue job ID.",
      });
      return { result: nodeResult("failed", "result_identity_mismatch", executionQueueId), escalation };
    }
    const queueJobId = executionQueueId ?? summaryQueueId!;
    if (
      (typeof summary?.provider === "string" && summary.provider !== binding.provider)
      || (typeof summary?.accountId === "string" && summary.accountId !== binding.account_id)
    ) {
      const escalation = this.persistMismatch({
        graph,
        node,
        queueJobId,
        binding,
        post: null,
        observedAt,
        detail: "The graph-node result summary contradicts the durable mission provider/account binding.",
      });
      return { result: nodeResult("failed", "result_identity_mismatch", queueJobId), escalation };
    }

    // 2) One bounded exact read through the strict Runtime status contract.
    const status = await this.executor.getPostStatus({
      postId: queueJobId,
      workspaceId: binding.workspace_id,
      accountId: binding.account_id,
    });

    if (!status.ok) {
      return this.handleCollectionFailure({
        graph, node, queueJobId, binding, failure: status, observedAt, nodeResult,
      });
    }
    let post = status.post;
    if (findForbiddenProviderMaterial(post)) {
      return this.handleCollectionFailure({
        graph, node, queueJobId, binding,
        failure: { ok: false, code: "invalid_response", message: OPERATOR_PROVIDER_MATERIAL_MESSAGE },
        observedAt, nodeResult,
      });
    }
    if (
      post.provider === "youtube"
      && post.providerOperation
      && !TERMINAL_YOUTUBE_PROVIDER_OPERATION_STATES.has(post.providerOperation.operationState)
    ) {
      if (!this.executor.reconcileProviderOperation) {
        return this.handleCollectionFailure({
          graph, node, queueJobId, binding,
          failure: {
            ok: false,
            code: "unavailable",
            message: "Runtime provider reconciliation capability is unavailable.",
          },
          observedAt,
          nodeResult,
        });
      }
      const reconciliation = await this.executor.reconcileProviderOperation({
        postId: queueJobId,
        workspaceId: binding.workspace_id,
        accountId: binding.account_id,
      });
      if (!reconciliation.ok) {
        return this.handleCollectionFailure({
          graph, node, queueJobId, binding, failure: reconciliation, observedAt, nodeResult,
        });
      }
      post = reconciliation.post;
      if (findForbiddenProviderMaterial(post)) {
        return this.handleCollectionFailure({
          graph, node, queueJobId, binding,
          failure: { ok: false, code: "invalid_response", message: OPERATOR_PROVIDER_MATERIAL_MESSAGE },
          observedAt, nodeResult,
        });
      }
    }
    this.failureInjector?.("after_status_read_before_persistence", graph.graph_id, node.node_id);

    // 3) Validate the observation against the durable identity binding.
    const identityViolation = this.identityViolation(graph, node, binding, queueJobId, post);
    if (identityViolation) {
      const escalation = this.persistMismatch({
        graph, node, queueJobId, binding, post, observedAt, detail: identityViolation,
      });
      return { result: nodeResult("failed", "result_identity_mismatch", queueJobId), escalation };
    }

    // 4) Canonicalize, hash, and persist under the exact idempotency rules.
    const observation = this.canonicalObservation(graph, node, queueJobId, post);
    const canonicalJson = JSON.stringify(observation);
    const snapshotHash = sha256(canonicalJson);
    const classification = classifyObservation(post);

    const persisted = withTransaction(this.database, () => {
      const existing = this.readProjection(graph.graph_id, node.node_id);
      if (existing) {
        const existingMs = parseTimeMs(existing.source_updated_at);
        const observedMs = parseTimeMs(post.updatedAt);
        if (existing.source_updated_at === post.updatedAt && existing.snapshot_hash === snapshotHash) {
          return { outcome: "replayed" as const };
        }
        if (observedMs < existingMs) {
          return { outcome: "stale" as const };
        }
        if (existing.source_updated_at === post.updatedAt && existing.snapshot_hash !== snapshotHash) {
          this.recordContradiction(graph, node, queueJobId, existing, canonicalJson, snapshotHash, observedAt);
          return { outcome: "contradiction" as const };
        }
      }
      this.upsertProjection({
        graph, node, queueJobId, post, classification, canonicalJson, snapshotHash, observedAt,
        existing: existing ?? null,
      });
      this.appendEvent({
        graph,
        node,
        queueJobId,
        kind: "observation",
        projectionStatus: classification.status,
        reasonCode: classification.escalationReason ?? "result_observed",
        sourceUpdatedAt: post.updatedAt,
        snapshotHash,
        observedAt,
        evidenceJson: canonicalJson,
      });
      return { outcome: "refreshed" as const };
    });

    if (persisted.outcome === "contradiction") {
      const escalation = this.escalation({
        graph,
        node,
        queueJobId,
        post,
        projectionStatus: "manual_review_required",
        reasonCode: "observation_contradiction",
        observedAt,
        snapshotHash,
        detail: "The same source revision produced two different canonical snapshots.",
      });
      return { result: nodeResult("failed", "observation_contradiction", queueJobId), escalation };
    }

    let escalation: AutoPosterResultEscalation | undefined;
    if (persisted.outcome === "refreshed" && classification.escalationReason) {
      escalation = this.escalation({
        graph,
        node,
        queueJobId,
        post,
        projectionStatus: classification.status,
        reasonCode: classification.escalationReason,
        observedAt,
        snapshotHash,
      });
    }
    return { result: nodeResult(persisted.outcome, null, queueJobId), escalation };
  }

  private handleCollectionFailure(input: {
    graph: GraphRow;
    node: GraphNodeRow;
    queueJobId: string;
    binding: MissionBindingRow;
    failure: AutoPosterPortFailure;
    observedAt: string;
    nodeResult: (
      outcome: AutoPosterNodeRefreshOutcome,
      reasonCode: AutoPosterNodeRefreshResult["reasonCode"],
      queueJobId: string | null,
    ) => AutoPosterNodeRefreshResult;
  }): { result: AutoPosterNodeRefreshResult; escalation?: AutoPosterResultEscalation } {
    const { graph, node, queueJobId, binding, failure, observedAt, nodeResult } = input;
    const safeFailure = findForbiddenProviderMaterial(failure)
      ? { ...failure, message: OPERATOR_PROVIDER_MATERIAL_MESSAGE, details: undefined }
      : failure;
    const identityFailure = safeFailure.code === "not_found"
      || (safeFailure.code === "invalid_response" && safeFailure.reasonCode === "status_identity_mismatch");
    if (identityFailure) {
      // Durable fail-closed verdict: the exact bound job is missing or
      // AutoPoster answered for a different identity.
      const escalation = this.persistMismatch({
        graph, node, queueJobId, binding, post: null, observedAt,
        detail: safeFailure.code === "not_found"
          ? "The exact bound queue job was not found in its workspace/account scope."
          : safeFailure.message,
      });
      return { result: nodeResult("failed", "result_identity_mismatch", queueJobId), escalation };
    }
    // Transport/contract failure: preserve the last confirmed projection and
    // report the collection failure without relabeling the AutoPoster job.
    const escalation = this.escalation({
      graph,
      node,
      queueJobId,
      post: null,
      projectionStatus: null,
      reasonCode: "result_collection_unavailable",
      observedAt,
      snapshotHash: null,
      detail: safeFailure.message,
    });
    return { result: nodeResult("failed", "result_collection_unavailable", queueJobId), escalation };
  }

  private identityViolation(
    graph: GraphRow,
    node: GraphNodeRow,
    binding: MissionBindingRow,
    queueJobId: string,
    post: AutoPosterPostStatusView,
  ): string | null {
    if (post.id !== queueJobId) return "The status response identifies a different queue job.";
    if (post.provider !== binding.provider) return "The status response identifies a different provider.";
    if (post.accountId !== binding.account_id) return "The status response identifies a different account.";
    if (post.workspaceId !== binding.workspace_id) return "The status response identifies a different workspace.";
    if (post.runtimeMissionId && post.runtimeMissionId !== node.child_mission_id) {
      return "The job's Runtime mission binding does not match the deterministic graph child.";
    }
    if (post.runtimeIdempotencyKey && post.runtimeIdempotencyKey !== node.child_idempotency_key) {
      return "The job's Runtime idempotency binding does not match the deterministic graph child.";
    }
    if (post.runtimeAction && post.runtimeAction !== AUTOPOSTER_GRAPH_ACTION) {
      return "The job's Runtime action binding is not the reviewed schedule action.";
    }
    const operation = post.providerOperation;
    if (operation) {
      if (operation.queueId !== queueJobId) return "The provider operation identifies a different queue job.";
      if (operation.provider !== post.provider) return "The provider operation identifies a different provider.";
      if (operation.accountId !== binding.account_id) return "The provider operation identifies a different account.";
      if (operation.connectedAccountId !== post.connectedAccountId) return "The provider operation connected-account identity differs.";
      if (operation.workspaceId !== binding.workspace_id) return "The provider operation identifies a different workspace.";
      if (operation.userId !== graph.tenant_user_id) return "The provider operation identifies a different tenant user.";
      if (operation.graphId !== graph.graph_id) return "The provider operation identifies a different graph.";
      if (operation.approvalActorId !== post.approvedBy || operation.approvalTimestamp !== post.approvedAt) {
        return "The provider operation approval identity differs from the queue approval.";
      }
      if (operation.runtimeMissionId !== node.child_mission_id) return "The provider operation identifies a different Runtime child mission.";
      if (operation.runtimeAction !== AUTOPOSTER_GRAPH_ACTION) return "The provider operation is not bound to the reviewed schedule action.";
      if (operation.runtimePayloadHash !== post.runtimePayloadHash) return "The provider operation payload hash differs from the queue job.";
      const receipt = operation.providerStatusReceipt;
      if (receipt && (
        receipt.queueId !== queueJobId
        || receipt.providerOperationId !== operation.providerOperationId
        || receipt.providerAttemptId !== operation.providerAttemptId
        || receipt.configuredAccountId !== binding.account_id
        || receipt.connectedAccountId !== post.connectedAccountId
        || receipt.verifiedChannelId !== binding.account_id
        || receipt.externalVideoId !== post.publishId
        || receipt.mediaSha256 !== operation.mediaSha256
      )) return "The provider receipt identity does not match the durable operation binding.";
      if (operation.externalVideoId !== null && operation.externalVideoId !== post.publishId) {
        return "The provider operation artifact identity differs from the queue result.";
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Durable persistence
  // -------------------------------------------------------------------------

  private canonicalObservation(
    graph: GraphRow,
    node: GraphNodeRow,
    queueJobId: string,
    post: AutoPosterPostStatusView,
  ): CanonicalObservation {
    return {
      graphId: graph.graph_id,
      nodeId: node.node_id,
      queueJobId,
      sourceUpdatedAt: post.updatedAt,
      snapshot: {
        provider: post.provider,
        connectedAccountId: post.connectedAccountId,
        accountId: post.accountId,
        workspaceId: post.workspaceId,
        sourceStatus: post.status,
        providerStatus: post.providerStatus,
        approved: post.approved,
        approvalState: post.approvalState,
        approvedAt: post.approvedAt,
        approvedBy: post.approvedBy,
        scheduledAt: post.scheduledAt,
        createdAt: post.createdAt,
        postedAt: post.postedAt,
        lockedAt: post.lockedAt,
        claimAttempts: post.claimAttempts,
        publishAttemptBudget: post.publishAttemptBudget,
        attemptBudgetExhausted: post.attemptBudgetExhausted,
        publishId: post.publishId,
        providerVerification: post.providerVerification,
        providerOperation: post.providerOperation,
        runtimeMissionId: post.runtimeMissionId,
        runtimeIdempotencyKey: post.runtimeIdempotencyKey,
        runtimeAction: post.runtimeAction,
        runtimePayloadHash: post.runtimePayloadHash,
        lastResult: post.lastResult,
        history: post.history,
        lastErrorMessage: post.lastErrorMessage,
      },
    };
  }

  private upsertProjection(input: {
    graph: GraphRow;
    node: GraphNodeRow;
    queueJobId: string;
    post: AutoPosterPostStatusView;
    classification: Classification;
    canonicalJson: string;
    snapshotHash: string;
    observedAt: string;
    existing: ProjectionRow | null;
  }): void {
    const { graph, node, queueJobId, post, classification, canonicalJson, snapshotHash, observedAt, existing } = input;
    if (existing) {
      this.database.prepare(`
        UPDATE operator_autoposter_result_projections
           SET source_status = ?, provider_status = ?, projection_status = ?,
               approved = ?, source_updated_at = ?, observed_at = ?,
               snapshot_hash = ?, evidence_json = ?, escalation_reason = ?,
               escalation_severity = ?, updated_at = ?
         WHERE graph_id = ? AND node_id = ?
      `).run(
        post.status,
        post.providerStatus,
        classification.status,
        post.approved ? 1 : 0,
        post.updatedAt,
        observedAt,
        snapshotHash,
        canonicalJson,
        classification.escalationReason,
        classification.severity,
        observedAt,
        graph.graph_id,
        node.node_id,
      );
      return;
    }
    this.database.prepare(`
      INSERT INTO operator_autoposter_result_projections (
        graph_id, node_id, graph_hash, child_mission_id, child_trace_id,
        queue_job_id, provider, connected_account_id, account_id,
        workspace_id, source_status, provider_status, projection_status,
        approved, source_updated_at, observed_at, snapshot_hash,
        evidence_json, escalation_reason, escalation_severity, created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      graph.graph_id,
      node.node_id,
      graph.graph_hash,
      node.child_mission_id,
      node.child_trace_id,
      queueJobId,
      post.provider,
      post.connectedAccountId,
      post.accountId,
      post.workspaceId,
      post.status,
      post.providerStatus,
      classification.status,
      post.approved ? 1 : 0,
      post.updatedAt,
      observedAt,
      snapshotHash,
      canonicalJson,
      classification.escalationReason,
      classification.severity,
      observedAt,
      observedAt,
    );
  }

  /**
   * Same source revision, different canonical snapshot: retain the last
   * confirmed observation, flip only the derived status to manual review,
   * and append the contradicting evidence exactly once.
   */
  private recordContradiction(
    graph: GraphRow,
    node: GraphNodeRow,
    queueJobId: string,
    existing: ProjectionRow,
    contradictingJson: string,
    contradictingHash: string,
    observedAt: string,
  ): void {
    this.database.prepare(`
      UPDATE operator_autoposter_result_projections
         SET projection_status = 'manual_review_required',
             escalation_reason = 'observation_contradiction',
             escalation_severity = 'critical', updated_at = ?
       WHERE graph_id = ? AND node_id = ?
    `).run(observedAt, graph.graph_id, node.node_id);
    this.appendEvent({
      graph,
      node,
      queueJobId,
      kind: "contradiction",
      projectionStatus: "manual_review_required",
      reasonCode: "observation_contradiction",
      sourceUpdatedAt: existing.source_updated_at,
      snapshotHash: contradictingHash,
      observedAt,
      evidenceJson: JSON.stringify({
        confirmedSnapshotHash: existing.snapshot_hash,
        contradictingObservation: JSON.parse(contradictingJson) as unknown,
      }),
    });
  }

  private persistMismatch(input: {
    graph: GraphRow;
    node: GraphNodeRow;
    queueJobId: string;
    binding: MissionBindingRow;
    post: AutoPosterPostStatusView | null;
    observedAt: string;
    detail: string;
  }): AutoPosterResultEscalation {
    const { graph, node, queueJobId, binding, post, observedAt, detail } = input;
    const evidence = {
      mismatch: detail,
      expected: {
        queueJobId,
        childMissionId: node.child_mission_id,
        provider: binding.provider,
        accountId: binding.account_id,
        workspaceId: binding.workspace_id,
      },
      observed: post
        ? {
            id: post.id,
            provider: post.provider,
            accountId: post.accountId,
            workspaceId: post.workspaceId,
            runtimeMissionId: post.runtimeMissionId,
            runtimeAction: post.runtimeAction,
            sourceUpdatedAt: post.updatedAt,
          }
        : null,
    };
    const evidenceJson = JSON.stringify(evidence);
    const evidenceHash = sha256(evidenceJson);

    withTransaction(this.database, () => {
      const existing = this.readProjection(graph.graph_id, node.node_id);
      if (existing) {
        // Retain the last confirmed snapshot; only the derived verdict and
        // escalation evidence change.
        this.database.prepare(`
          UPDATE operator_autoposter_result_projections
             SET projection_status = 'manual_review_required',
                 escalation_reason = 'result_identity_mismatch',
                 escalation_severity = 'high', updated_at = ?
           WHERE graph_id = ? AND node_id = ?
        `).run(observedAt, graph.graph_id, node.node_id);
      } else {
        this.database.prepare(`
          INSERT INTO operator_autoposter_result_projections (
            graph_id, node_id, graph_hash, child_mission_id, child_trace_id,
            queue_job_id, provider, connected_account_id, account_id,
            workspace_id, source_status, provider_status, projection_status,
            approved, source_updated_at, observed_at, snapshot_hash,
            evidence_json, escalation_reason, escalation_severity, created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', 'manual_review_required',
            0, '', ?, ?, ?, 'result_identity_mismatch', 'high', ?, ?)
        `).run(
          graph.graph_id,
          node.node_id,
          graph.graph_hash,
          node.child_mission_id,
          node.child_trace_id,
          queueJobId,
          `${binding.provider}`,
          `${binding.provider}:${binding.account_id}`,
          binding.account_id,
          binding.workspace_id,
          observedAt,
          evidenceHash,
          evidenceJson,
          observedAt,
          observedAt,
        );
      }
      this.appendEvent({
        graph,
        node,
        queueJobId,
        kind: "identity_mismatch",
        projectionStatus: "manual_review_required",
        reasonCode: "result_identity_mismatch",
        sourceUpdatedAt: post?.updatedAt ?? "",
        snapshotHash: evidenceHash,
        observedAt,
        evidenceJson,
      });
    });

    return this.escalation({
      graph,
      node,
      queueJobId,
      post,
      projectionStatus: "manual_review_required",
      reasonCode: "result_identity_mismatch",
      observedAt,
      snapshotHash: evidenceHash,
      detail,
    });
  }

  private appendEvent(input: {
    graph: GraphRow;
    node: GraphNodeRow;
    queueJobId: string;
    kind: "observation" | "contradiction" | "identity_mismatch";
    projectionStatus: AutoPosterResultProjectionStatus;
    reasonCode: string;
    sourceUpdatedAt: string;
    snapshotHash: string;
    observedAt: string;
    evidenceJson: string;
  }): void {
    const eventId = sha256([
      input.graph.graph_id,
      input.node.node_id,
      input.queueJobId,
      input.kind,
      input.sourceUpdatedAt,
      input.snapshotHash,
      input.reasonCode,
    ].join("|"));
    const existing = this.database.prepare(
      "SELECT event_id FROM operator_autoposter_result_events WHERE event_id = ?",
    ).get(eventId) as { event_id: string } | undefined;
    if (existing) return; // deterministic replay of already-recorded evidence
    const sequenceRow = this.database.prepare(`
      SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
        FROM operator_autoposter_result_events
       WHERE graph_id = ? AND node_id = ?
    `).get(input.graph.graph_id, input.node.node_id) as { next_sequence: number };
    this.database.prepare(`
      INSERT INTO operator_autoposter_result_events (
        event_id, graph_id, node_id, queue_job_id, sequence,
        observation_kind, projection_status, reason_code, source_updated_at,
        snapshot_hash, observed_at, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      input.graph.graph_id,
      input.node.node_id,
      input.queueJobId,
      Number(sequenceRow.next_sequence),
      input.kind,
      input.projectionStatus,
      input.reasonCode,
      input.sourceUpdatedAt,
      input.snapshotHash,
      input.observedAt,
      input.evidenceJson,
    );
  }

  // -------------------------------------------------------------------------
  // Reads, views, summaries, escalations
  // -------------------------------------------------------------------------

  private requireGraph(graphId: string): GraphRow {
    const row = this.database.prepare(
      "SELECT graph_id, graph_hash, workspace_id, tenant_user_id FROM operator_mission_graphs WHERE graph_id = ?",
    ).get(String(graphId || "").trim()) as GraphRow | undefined;
    if (!row) throw new OperatorError("Mission graph was not found.", 404);
    return row;
  }

  private autoPosterNodes(graphId: string): GraphNodeRow[] {
    return this.database.prepare(`
      SELECT graph_id, node_id, status, child_mission_id, child_trace_id,
             child_idempotency_key, result_summary_json
        FROM operator_mission_graph_nodes
       WHERE graph_id = ? AND product = 'auto_poster' AND action = ?
       ORDER BY node_id ASC
    `).all(graphId, AUTOPOSTER_GRAPH_ACTION) as unknown as GraphNodeRow[];
  }

  private readMissionBinding(childMissionId: string): MissionBindingRow | null {
    const row = this.database.prepare(
      "SELECT workspace_id, account_id, provider FROM autoposter_runtime_missions WHERE mission_id = ?",
    ).get(childMissionId) as MissionBindingRow | undefined;
    return row ?? null;
  }

  private readExecutionQueueId(childMissionId: string): string | null {
    const row = this.database.prepare(
      "SELECT downstream_queue_id FROM autoposter_mission_executions WHERE mission_id = ?",
    ).get(childMissionId) as { downstream_queue_id: string | null } | undefined;
    const queueId = row?.downstream_queue_id;
    return typeof queueId === "string" && queueId.trim() ? queueId : null;
  }

  private readProjection(graphId: string, nodeId: string): ProjectionRow | null {
    const row = this.database.prepare(
      "SELECT * FROM operator_autoposter_result_projections WHERE graph_id = ? AND node_id = ?",
    ).get(graphId, nodeId) as ProjectionRow | undefined;
    return row ?? null;
  }

  private projectionView(row: ProjectionRow | null): AutoPosterResultProjectionView | null {
    if (!row) return null;
    return {
      graphId: row.graph_id,
      nodeId: row.node_id,
      graphHash: row.graph_hash,
      childMissionId: row.child_mission_id,
      childTraceId: row.child_trace_id,
      queueJobId: row.queue_job_id,
      provider: row.provider,
      connectedAccountId: row.connected_account_id,
      accountId: row.account_id,
      workspaceId: row.workspace_id,
      sourceStatus: row.source_status,
      providerStatus: row.provider_status,
      projectionStatus: row.projection_status,
      approved: row.approved === 1,
      sourceUpdatedAt: row.source_updated_at,
      observedAt: row.observed_at,
      snapshotHash: row.snapshot_hash,
      evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as unknown) : null,
      escalationReason: row.escalation_reason,
      escalationSeverity: row.escalation_severity,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Batch summary over the stored projections — derived separately from the
   * Phase 2E-A graph execution status and never an unqualified `completed`,
   * because no current provider path proves public visibility.
   */
  private batchSummary(
    nodeCount: number,
    projections: Array<AutoPosterResultProjectionView | null>,
  ): AutoPosterResultBatchSummary {
    const totals = Object.fromEntries(
      AUTOPOSTER_RESULT_PROJECTION_STATUSES.map((status) => [status, 0]),
    ) as Record<AutoPosterResultProjectionStatus, number>;
    let observedCount = 0;
    let nonterminal = 0;
    let ambiguous = 0;
    let failed = 0;
    for (const projection of projections) {
      if (!projection) {
        nonterminal += 1;
        continue;
      }
      observedCount += 1;
      totals[projection.projectionStatus] += 1;
      if (NONTERMINAL_PROJECTION_STATUSES.has(projection.projectionStatus)) nonterminal += 1;
      else if (
        projection.projectionStatus === "outcome_unknown"
        || projection.projectionStatus === "manual_review_required"
      ) ambiguous += 1;
      else if (projection.projectionStatus === "failed") failed += 1;
    }
    const status: AutoPosterResultBatchStatus = nonterminal > 0
      ? "awaiting_results"
      : ambiguous > 0
        ? "outcome_unknown"
        : failed > 0
          ? "failed"
          : "completed_with_warning";
    return { status, nodeCount, observedCount, totals };
  }

  private escalation(input: {
    graph: GraphRow;
    node: GraphNodeRow | null;
    queueJobId: string | null;
    post: AutoPosterPostStatusView | null;
    projectionStatus: AutoPosterResultProjectionStatus | null;
    reasonCode: AutoPosterResultEscalationReason;
    observedAt: string;
    snapshotHash: string | null;
    detail?: string;
  }): AutoPosterResultEscalation {
    const { graph, node, queueJobId, post, projectionStatus, reasonCode, observedAt, snapshotHash } = input;
    const escalationId = sha256([
      graph.graph_id,
      node?.node_id ?? "",
      queueJobId ?? "",
      snapshotHash ?? "",
      reasonCode,
    ].join("|"));
    return {
      schemaVersion: ESCALATION_SCHEMA_VERSION,
      escalationId,
      graphId: graph.graph_id,
      graphHash: graph.graph_hash,
      nodeId: node?.node_id ?? null,
      childMissionId: node?.child_mission_id ?? null,
      childTraceId: node?.child_trace_id ?? null,
      queueJobId,
      workspaceId: post?.workspaceId ?? graph.workspace_id,
      provider: post?.provider ?? null,
      connectedAccountId: post?.connectedAccountId ?? null,
      accountId: post?.accountId ?? null,
      sourceStatus: post?.status ?? null,
      providerStatus: post?.providerStatus ?? null,
      projectionStatus,
      approved: post?.approved ?? null,
      approvedAt: post?.approvedAt ?? null,
      approvedBy: post?.approvedBy ?? null,
      scheduledAt: post?.scheduledAt ?? null,
      sourceUpdatedAt: post?.updatedAt ?? null,
      postedAt: post?.postedAt ?? null,
      lockedAt: post?.lockedAt ?? null,
      observedAt,
      claimAttempts: post?.claimAttempts ?? null,
      publishAttemptBudget: post?.publishAttemptBudget ?? null,
      attemptBudgetExhausted: post?.attemptBudgetExhausted ?? null,
      history: post?.history ?? [],
      publishId: post?.publishId ? post.publishId : null,
      errorCode: post?.lastResult?.code ?? null,
      errorMessage: input.detail ?? post?.lastResult?.message ?? post?.lastErrorMessage ?? null,
      reasonCode,
      severity: SEVERITY_BY_REASON[reasonCode],
      recommendedHumanAction: RECOMMENDED_HUMAN_ACTIONS[reasonCode],
      canonicalInspection: {
        adminRoutes: [...AUTOPOSTER_ADMIN_ROUTES],
        queueJobId,
      },
      evidenceReferences: [
        `graph:${graph.graph_id}`,
        ...(node ? [`node:${node.node_id}`, `child-mission:${node.child_mission_id}`] : []),
        ...(queueJobId ? [`autoposter-queue:${queueJobId}`] : []),
      ],
      snapshotHash,
    };
  }
}
