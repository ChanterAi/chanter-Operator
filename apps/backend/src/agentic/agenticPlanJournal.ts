/**
 * CHANTER OS — durable agentic plan journal.
 *
 * Owns the `operator_agentic_*` tables and nothing else: closed state machines,
 * compare-and-swap transitions, an append-only per-mission event journal
 * (`UNIQUE(mission_id, sequence)`), and the Runtime-facing worker record store.
 * Orchestration policy lives in `agenticMissionService`; this module only guards
 * durable truth, exactly as `missionGraphJournal` does for Phase 2D.
 *
 * Every state change is a guarded compare-and-swap against the state the caller
 * believed it was leaving. A transition whose `WHERE ... AND state = ?` matches
 * zero rows means durable truth moved underneath the caller, and that is
 * reported as a typed conflict rather than retried — which is what lets the
 * Governor's admission decision be computed from a snapshot without ever being
 * able to overwrite newer truth.
 *
 * ## Why the worker record store lives here
 *
 * The Agent Runtime defines `AgenticNodeRecordStore` but deliberately does not
 * implement a durable one: durability is a deployment concern, and the Runtime
 * has no database. Operator supplies it, backed by the same SQLite file as the
 * plan itself, so "the worker ran" and "the node completed" are two rows in one
 * store — and the window between them survives a process kill, which is the
 * whole basis of node-level recovery.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  AgenticNodeClaimOutcome,
  AgenticNodeCost,
  AgenticNodeEvidence,
  AgenticNodeRecordStore,
  AgenticNodeToolCallRecord,
  AgenticNodeWorkerRecord,
  AgenticProviderReconciliation,
  AgenticProviderUsageRecord,
  AgenticProviderUsageStore,
  JsonValue,
} from "chanter-agent-runtime";
import {
  AGENTIC_MODEL_PROVIDER_CONTRACT_VERSION,
  AGENTIC_RECONCILIATION_NOT_ATTEMPTED,
} from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import type {
  AgenticCompiledPlan,
  AgenticContextBundle,
  AgenticIntentContract,
  AgenticNodeState,
  AgenticNodeType,
  AgenticPlanState,
  AgenticValueObservation,
} from "./agenticMissionContract.js";
import type {
  DesiredState,
  ObservedState,
  StateDelta,
} from "./agenticExceptionContract.js";
import type { ConnectorCapabilityManifest } from "./agenticSimulatedConnector.js";
import type { AgenticRoutingDecision } from "./agenticCapabilityRouter.js";

export interface AgenticTypedError {
  readonly code: string;
  readonly message: string;
}

export type AgenticReconciliationOutcome =
  | "worker_result_found"
  | "no_worker_result"
  | "conflict";

export interface AgenticMissionRecord {
  readonly missionId: string;
  readonly traceId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly objective: string;
  readonly intentHash: string;
  readonly intent: AgenticIntentContract;
  readonly contextBundleId: string;
  readonly contextBundle: AgenticContextBundle;
  readonly planId: string;
  readonly planHash: string;
  readonly plan: AgenticCompiledPlan;
  readonly routing: readonly AgenticRoutingDecision[];
  readonly status: AgenticPlanState;
  readonly executionApprovedBy: string | null;
  readonly executionApprovedAt: string | null;
  readonly executionApprovedPlanHash: string | null;
  readonly candidateHash: string | null;
  readonly candidateMarkdown: string | null;
  readonly candidateApprovedBy: string | null;
  readonly candidateApprovedAt: string | null;
  readonly approvedCandidateHash: string | null;
  readonly candidateApprovalExpiresAt: string | null;
  readonly candidateAuthorityRevision: string | null;
  readonly artifactHash: string | null;
  readonly artifactName: string | null;
  readonly valueObservation: AgenticValueObservation | null;
  /** Intake state for an operational-exception mission; `null` for every other kind. */
  readonly exceptionState: AgenticExceptionIntakeState | null;
  readonly typedError: AgenticTypedError | null;
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgenticNodeRecord {
  readonly planId: string;
  readonly nodeId: string;
  readonly missionId: string;
  readonly nodeType: AgenticNodeType;
  readonly capabilityId: string | null;
  readonly workerKind: string | null;
  readonly providerBindingId: string | null;
  readonly dependsOn: readonly string[];
  readonly inputRefs: readonly string[];
  readonly authorityRequirement: "none" | "human_approval_bound_to_candidate_hash";
  readonly budget: {
    readonly maxToolCalls: number;
    readonly maxModelCalls: number;
    readonly maxDurationMs: number;
    readonly maxTokens: number | null;
    readonly maxCostMicros: number | null;
  };
  readonly deadlineOffsetMs: number;
  readonly attemptLimit: number;
  readonly reconciliationMode: string;
  readonly evidencePolicy: {
    readonly minimumItems: number;
    readonly requireAcceptedContextReference: boolean;
  };
  readonly payloadHash: string;
  readonly state: AgenticNodeState;
  readonly attempts: number;
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: string | null;
  readonly deadlineAt: string | null;
  readonly idempotencyKey: string;
  readonly output: JsonValue | null;
  readonly outputHash: string | null;
  readonly cost: AgenticNodeCost | null;
  readonly latencyMs: number | null;
  readonly reconciliationOutcome: AgenticReconciliationOutcome | null;
  readonly reconciledAt: string | null;
  readonly typedError: AgenticTypedError | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface AgenticEventRecord {
  readonly eventId: string;
  readonly missionId: string;
  readonly planId: string;
  readonly sequence: number;
  readonly scope: "mission" | "plan" | "node";
  readonly nodeId: string | null;
  readonly eventType: string;
  readonly previousState: string | null;
  readonly newState: string | null;
  readonly actor: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly evidenceReferences: readonly string[];
  readonly typedError: AgenticTypedError | null;
}

export interface AgenticEvidenceRecord {
  readonly evidenceId: string;
  readonly planId: string;
  readonly nodeId: string;
  readonly missionId: string;
  readonly kind: AgenticNodeEvidence["kind"];
  readonly label: string;
  readonly sourceReference: string;
  readonly contentHash: string;
  readonly createdAt: string;
}

export interface AgenticArtifactWriteRecord {
  readonly missionId: string;
  readonly artifactName: string;
  readonly artifactHash: string;
  readonly approvedCandidateHash: string;
  readonly byteLength: number;
  readonly artifactPath: string;
  readonly writtenAt: string;
}

// ---------------------------------------------------------------------------
// State machines
// ---------------------------------------------------------------------------

const ALLOWED_PLAN_TRANSITIONS = new Map<AgenticPlanState, ReadonlySet<AgenticPlanState>>([
  ["compiled", new Set<AgenticPlanState>(["approval_required", "cancelled"])],
  ["approval_required", new Set<AgenticPlanState>(["approved", "cancelled", "failed_terminal"])],
  ["approved", new Set<AgenticPlanState>(["running", "cancelled", "failed_terminal"])],
  ["running", new Set<AgenticPlanState>([
    "awaiting_authority", "completed", "failed_recoverable",
    "reconciliation_required", "failed_terminal", "cancelled",
  ])],
  ["awaiting_authority", new Set<AgenticPlanState>([
    "running", "failed_recoverable", "reconciliation_required", "failed_terminal", "cancelled",
  ])],
  ["failed_recoverable", new Set<AgenticPlanState>([
    "running", "reconciliation_required", "failed_terminal", "cancelled",
  ])],
  ["reconciliation_required", new Set<AgenticPlanState>([
    "running", "failed_recoverable", "failed_terminal", "cancelled",
  ])],
  ["completed", new Set<AgenticPlanState>()],
  ["failed_terminal", new Set<AgenticPlanState>()],
  ["cancelled", new Set<AgenticPlanState>()],
]);

/**
 * Node transitions.
 *
 * `reconciliation_required -> completed` exists on purpose: when a reconcile
 * proves the worker already ran and produced an exact result, the resume commits
 * that record rather than executing anything. `reconciliation_required ->
 * running` is the opposite finding — no worker result exists, so one attempt is
 * genuinely owed. There is no edge from `reconciliation_required` that skips the
 * reconcile itself.
 */
const ALLOWED_NODE_TRANSITIONS = new Map<AgenticNodeState, ReadonlySet<AgenticNodeState>>([
  ["blocked", new Set<AgenticNodeState>(["ready", "cancelled", "failed_terminal"])],
  ["ready", new Set<AgenticNodeState>(["running", "cancelled", "failed_terminal"])],
  ["running", new Set<AgenticNodeState>([
    "completed", "failed_recoverable", "reconciliation_required", "failed_terminal", "cancelled",
  ])],
  ["failed_recoverable", new Set<AgenticNodeState>([
    "ready", "running", "reconciliation_required", "failed_terminal", "cancelled",
  ])],
  // `failed_recoverable` is reachable from here on purpose: a reconcile that
  // proves no worker result exists owes the node one genuine attempt, and
  // `failed_recoverable` is the state the Governor will admit from. There is no
  // edge that reaches execution without passing through the reconcile itself.
  ["reconciliation_required", new Set<AgenticNodeState>([
    "running", "completed", "failed_recoverable", "failed_terminal", "cancelled",
  ])],
  ["completed", new Set<AgenticNodeState>()],
  ["failed_terminal", new Set<AgenticNodeState>()],
  ["cancelled", new Set<AgenticNodeState>()],
]);

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

interface MissionRow {
  mission_id: string;
  trace_id: string;
  workspace_id: string;
  actor_id: string;
  objective: string;
  intent_hash: string;
  intent_json: string;
  context_bundle_id: string;
  context_bundle_json: string;
  plan_id: string;
  plan_hash: string;
  plan_json: string;
  routing_json: string;
  status: AgenticPlanState;
  execution_approved_by: string | null;
  execution_approved_at: string | null;
  execution_approved_plan_hash: string | null;
  candidate_hash: string | null;
  candidate_markdown: string | null;
  candidate_approved_by: string | null;
  candidate_approved_at: string | null;
  approved_candidate_hash: string | null;
  candidate_approval_expires_at: string | null;
  candidate_authority_revision: string | null;
  artifact_hash: string | null;
  artifact_name: string | null;
  exception_state_json: string | null;
  value_observation_json: string | null;
  typed_error_json: string | null;
  requested_at: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  plan_id: string;
  node_id: string;
  mission_id: string;
  node_type: AgenticNodeType;
  capability_id: string | null;
  worker_kind: string | null;
  provider_binding_id: string | null;
  depends_on_json: string;
  input_refs_json: string;
  authority_requirement: "none" | "human_approval_bound_to_candidate_hash";
  budget_json: string;
  deadline_offset_ms: number;
  attempt_limit: number;
  reconciliation_mode: string;
  evidence_policy_json: string;
  payload_hash: string;
  state: AgenticNodeState;
  attempts: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  deadline_at: string | null;
  idempotency_key: string;
  output_json: string | null;
  output_hash: string | null;
  cost_json: string | null;
  latency_ms: number | null;
  reconciliation_outcome: AgenticReconciliationOutcome | null;
  reconciled_at: string | null;
  typed_error_json: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  mission_id: string;
  plan_id: string;
  sequence: number;
  scope: "mission" | "plan" | "node";
  node_id: string | null;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  actor: string;
  reason: string;
  timestamp: string;
  evidence_refs_json: string;
  typed_error_json: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  plan_id: string;
  node_id: string;
  mission_id: string;
  kind: AgenticNodeEvidence["kind"];
  label: string;
  source_reference: string;
  content_hash: string;
  created_at: string;
}

interface WorkerRecordRow {
  idempotency_key: string;
  execution_hash: string;
  capability_id: string;
  claim_owner: string | null;
  claimed_at: string | null;
  status: string | null;
  structured_output_json: string | null;
  output_hash: string | null;
  evidence_json: string | null;
  tool_calls_json: string | null;
  cost_json: string | null;
  latency_ms: number | null;
  typed_error_json: string | null;
  recorded_at: string | null;
}

/** Exact durable identity of one active, unrecorded worker authority. */
export interface AgenticWorkerClaimIdentity {
  readonly idempotencyKey: string;
  readonly executionHash: string;
  readonly claimOwner: string;
  readonly claimedAt: string;
}

/** Current durable worker-row identity after a compare-and-release loses. */
export interface AgenticWorkerAuthoritySnapshot {
  readonly idempotencyKey: string;
  readonly executionHash: string;
  readonly claimOwner: string | null;
  readonly claimedAt: string | null;
  readonly recordedAt: string | null;
}

export interface AgenticOrphanClaimRetirement {
  readonly retired: boolean;
  readonly current: AgenticWorkerAuthoritySnapshot | null;
}

/** Runtime's store plus Operator-only inspection and exact orphan retirement. */
export interface OperatorAgenticNodeRecordStore extends AgenticNodeRecordStore {
  inspectActiveClaim(idempotencyKey: string): AgenticWorkerClaimIdentity | null;
  retireOrphanClaim(expected: AgenticWorkerClaimIdentity): AgenticOrphanClaimRetirement;
}

interface ProviderUsageRow {
  provider_call_key: string;
  mission_id: string;
  plan_id: string;
  node_id: string;
  idempotency_key: string;
  capability_id: string;
  binding_id: string;
  provider_name: string;
  model_id: string;
  mode: string;
  attempt: number;
  provider_request_id: string | null;
  request_hash: string;
  raw_response_hash: string | null;
  response_hash: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  monetary_cost_micros: number | null;
  monetary_cost_source: string;
  monetary_cost_unavailable_reason: string | null;
  pricing_revision: string | null;
  latency_ms: number;
  finish_reason: string | null;
  typed_error_json: string | null;
  fallback_decision: string;
  fallback_from_binding_id: string | null;
  evidence_references_json: string;
  reconciliation_json: string | null;
  recorded_at: string;
}

interface ArtifactWriteRow {
  mission_id: string;
  artifact_name: string;
  artifact_hash: string;
  approved_candidate_hash: string;
  byte_length: number;
  artifact_path: string;
  written_at: string;
}

function parseJson<T>(value: string | null): T | null {
  return value === null ? null : (JSON.parse(value) as T);
}

function mapMission(row: MissionRow): AgenticMissionRecord {
  return {
    missionId: row.mission_id,
    traceId: row.trace_id,
    workspaceId: row.workspace_id,
    actorId: row.actor_id,
    objective: row.objective,
    intentHash: row.intent_hash,
    intent: JSON.parse(row.intent_json) as AgenticIntentContract,
    contextBundleId: row.context_bundle_id,
    contextBundle: JSON.parse(row.context_bundle_json) as AgenticContextBundle,
    planId: row.plan_id,
    planHash: row.plan_hash,
    plan: JSON.parse(row.plan_json) as AgenticCompiledPlan,
    routing: JSON.parse(row.routing_json) as AgenticRoutingDecision[],
    status: row.status,
    executionApprovedBy: row.execution_approved_by,
    executionApprovedAt: row.execution_approved_at,
    executionApprovedPlanHash: row.execution_approved_plan_hash,
    candidateHash: row.candidate_hash,
    candidateMarkdown: row.candidate_markdown,
    candidateApprovedBy: row.candidate_approved_by,
    candidateApprovedAt: row.candidate_approved_at,
    approvedCandidateHash: row.approved_candidate_hash,
    candidateApprovalExpiresAt: row.candidate_approval_expires_at,
    candidateAuthorityRevision: row.candidate_authority_revision,
    artifactHash: row.artifact_hash,
    artifactName: row.artifact_name,
    valueObservation: parseJson<AgenticValueObservation>(row.value_observation_json),
    exceptionState: parseJson<AgenticExceptionIntakeState>(row.exception_state_json),
    typedError: parseJson<AgenticTypedError>(row.typed_error_json),
    requestedAt: row.requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNode(row: NodeRow): AgenticNodeRecord {
  return {
    planId: row.plan_id,
    nodeId: row.node_id,
    missionId: row.mission_id,
    nodeType: row.node_type,
    capabilityId: row.capability_id,
    workerKind: row.worker_kind,
    providerBindingId: row.provider_binding_id,
    dependsOn: JSON.parse(row.depends_on_json) as string[],
    inputRefs: JSON.parse(row.input_refs_json) as string[],
    authorityRequirement: row.authority_requirement,
    budget: JSON.parse(row.budget_json) as AgenticNodeRecord["budget"],
    deadlineOffsetMs: Number(row.deadline_offset_ms),
    attemptLimit: Number(row.attempt_limit),
    reconciliationMode: row.reconciliation_mode,
    evidencePolicy: JSON.parse(row.evidence_policy_json) as AgenticNodeRecord["evidencePolicy"],
    payloadHash: row.payload_hash,
    state: row.state,
    attempts: Number(row.attempts),
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    deadlineAt: row.deadline_at,
    idempotencyKey: row.idempotency_key,
    output: parseJson<JsonValue>(row.output_json),
    outputHash: row.output_hash,
    cost: parseJson<AgenticNodeCost>(row.cost_json),
    latencyMs: row.latency_ms === null ? null : Number(row.latency_ms),
    reconciliationOutcome: row.reconciliation_outcome,
    reconciledAt: row.reconciled_at,
    typedError: parseJson<AgenticTypedError>(row.typed_error_json),
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): AgenticEventRecord {
  return {
    eventId: row.event_id,
    missionId: row.mission_id,
    planId: row.plan_id,
    sequence: Number(row.sequence),
    scope: row.scope,
    nodeId: row.node_id,
    eventType: row.event_type,
    previousState: row.previous_state,
    newState: row.new_state,
    actor: row.actor,
    reason: row.reason,
    timestamp: row.timestamp,
    evidenceReferences: JSON.parse(row.evidence_refs_json) as string[],
    typedError: parseJson<AgenticTypedError>(row.typed_error_json),
  };
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface AgenticMissionInsertInput {
  readonly intent: AgenticIntentContract;
  readonly contextBundle: AgenticContextBundle;
  readonly plan: AgenticCompiledPlan;
  readonly routing: readonly AgenticRoutingDecision[];
  readonly timestamp: string;
  /** Deterministic execution identity per node, supplied by the service. */
  readonly idempotencyKeyFor: (nodeId: string) => string;
  /**
   * Intake state for an operational-exception mission. Written once, with the
   * mission, and never updated: what was observed and wanted at submission is
   * the thing every later hash binds to, so a later edit would silently
   * invalidate an approval that had already been given.
   */
  readonly exceptionState?: AgenticExceptionIntakeState | null;
}

/**
 * ObservedState, DesiredState, and StateDelta as established at intake.
 *
 * Carried together because they are one derivation: the delta is a pure
 * function of the other two, and storing them apart would allow a combination
 * that never actually existed.
 */
export interface AgenticExceptionIntakeState {
  readonly observed: ObservedState;
  readonly desired: DesiredState;
  readonly delta: StateDelta;
  readonly connectorManifest: ConnectorCapabilityManifest;
}

export interface AgenticEventInput {
  readonly actor: string;
  readonly reason: string;
  readonly timestamp: string;
  readonly evidenceReferences?: readonly string[];
  readonly typedError?: AgenticTypedError | null;
}

export interface AgenticNodeTransitionInput extends AgenticEventInput {
  readonly attempts?: number;
  readonly leaseOwner?: string | null;
  readonly leaseExpiresAt?: string | null;
  readonly deadlineAt?: string | null;
  readonly output?: JsonValue | null;
  readonly outputHash?: string | null;
  readonly cost?: AgenticNodeCost | null;
  readonly latencyMs?: number | null;
  readonly reconciliationOutcome?: AgenticReconciliationOutcome | null;
  readonly reconciledAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

export interface AgenticMissionUpdateInput extends AgenticEventInput {
  readonly executionApprovedBy?: string;
  readonly executionApprovedPlanHash?: string;
  readonly candidateHash?: string | null;
  readonly candidateMarkdown?: string | null;
  readonly candidateApprovedBy?: string;
  readonly approvedCandidateHash?: string;
  readonly candidateApprovalExpiresAt?: string | null;
  readonly candidateAuthorityRevision?: string | null;
  readonly artifactHash?: string | null;
  readonly artifactName?: string | null;
  readonly valueObservation?: AgenticValueObservation | null;
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

export class AgenticPlanJournal {
  constructor(
    private readonly database: DatabaseSync,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  // -- Reads ---------------------------------------------------------------

  getMission(missionId: string): AgenticMissionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM operator_agentic_missions WHERE mission_id = ?")
      .get(missionId) as MissionRow | undefined;
    return row ? mapMission(row) : null;
  }

  requireMission(missionId: string): AgenticMissionRecord {
    const mission = this.getMission(missionId);
    if (!mission) {
      throw new OperatorError("Agentic mission was not found.", 404, "AGENTIC_MISSION_NOT_FOUND");
    }
    return mission;
  }

  listMissions(limit: number): AgenticMissionRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM operator_agentic_missions ORDER BY created_at DESC, mission_id DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => mapMission(row as unknown as MissionRow));
  }

  listNodes(planId: string): AgenticNodeRecord[] {
    return this.database
      .prepare("SELECT * FROM operator_agentic_plan_nodes WHERE plan_id = ? ORDER BY node_id ASC")
      .all(planId)
      .map((row) => mapNode(row as unknown as NodeRow));
  }

  getNode(planId: string, nodeId: string): AgenticNodeRecord | null {
    const row = this.database
      .prepare("SELECT * FROM operator_agentic_plan_nodes WHERE plan_id = ? AND node_id = ?")
      .get(planId, nodeId) as NodeRow | undefined;
    return row ? mapNode(row) : null;
  }

  requireNode(planId: string, nodeId: string): AgenticNodeRecord {
    const node = this.getNode(planId, nodeId);
    if (!node) {
      throw new OperatorError("Agentic plan node was not found.", 404, "AGENTIC_NODE_NOT_FOUND");
    }
    return node;
  }

  listEvents(missionId: string): AgenticEventRecord[] {
    return this.database
      .prepare("SELECT * FROM operator_agentic_plan_events WHERE mission_id = ? ORDER BY sequence ASC")
      .all(missionId)
      .map((row) => mapEvent(row as unknown as EventRow));
  }

  listEvidence(missionId: string): AgenticEvidenceRecord[] {
    return this.database
      .prepare(
        `SELECT * FROM operator_agentic_node_evidence WHERE mission_id = ?
          ORDER BY node_id ASC, evidence_id ASC`,
      )
      .all(missionId)
      .map((row) => {
        const evidence = row as unknown as EvidenceRow;
        return {
          evidenceId: evidence.evidence_id,
          planId: evidence.plan_id,
          nodeId: evidence.node_id,
          missionId: evidence.mission_id,
          kind: evidence.kind,
          label: evidence.label,
          sourceReference: evidence.source_reference,
          contentHash: evidence.content_hash,
          createdAt: evidence.created_at,
        };
      });
  }

  getArtifactWrite(missionId: string, artifactName: string): AgenticArtifactWriteRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM operator_agentic_artifact_writes WHERE mission_id = ? AND artifact_name = ?",
      )
      .get(missionId, artifactName) as ArtifactWriteRow | undefined;
    return row
      ? {
        missionId: row.mission_id,
        artifactName: row.artifact_name,
        artifactHash: row.artifact_hash,
        approvedCandidateHash: row.approved_candidate_hash,
        byteLength: Number(row.byte_length),
        artifactPath: row.artifact_path,
        writtenAt: row.written_at,
      }
      : null;
  }

  countArtifactWrites(missionId: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS total FROM operator_agentic_artifact_writes WHERE mission_id = ?")
      .get(missionId) as { total: number };
    return Number(row.total);
  }

  // -- Mission creation ----------------------------------------------------

  /**
   * Durable create: mission row + every node + every edge + two events.
   *
   * Compilation and "a human must now authorize this" are journaled as separate
   * facts, because they are separate facts: the plan existing is not the same
   * event as the plan requiring approval, and an audit that conflated them could
   * not show that no worker ran in between.
   */
  insertMission(input: AgenticMissionInsertInput): AgenticMissionRecord {
    return this.withSavepoint(() => {
      const { intent, plan } = input;
      this.database.prepare(
        `INSERT INTO operator_agentic_missions (
          mission_id, trace_id, schema_version, workspace_id, actor_id, objective,
          intent_hash, intent_json, context_bundle_id, context_bundle_json,
          plan_id, plan_hash, plan_json, routing_json, exception_state_json, status, approval_required,
          requested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'compiled', 1, ?, ?, ?)`,
      ).run(
        intent.missionId,
        intent.traceId,
        intent.schemaVersion,
        intent.workspaceId,
        intent.actorId,
        intent.objective,
        intent.intentHash,
        JSON.stringify(intent),
        input.contextBundle.contextBundleId,
        JSON.stringify(input.contextBundle),
        plan.planId,
        plan.planHash,
        JSON.stringify(plan),
        JSON.stringify(input.routing),
        input.exceptionState === undefined || input.exceptionState === null
          ? null
          : JSON.stringify(input.exceptionState),
        intent.requestedAt,
        input.timestamp,
        input.timestamp,
      );

      const insertNode = this.database.prepare(
        `INSERT INTO operator_agentic_plan_nodes (
          plan_id, node_id, mission_id, node_type, capability_id, worker_kind,
          provider_binding_id, depends_on_json, input_refs_json, authority_requirement, budget_json,
          deadline_offset_ms, attempt_limit, reconciliation_mode, evidence_policy_json,
          payload_hash, state, attempts, idempotency_key, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      );
      const insertEdge = this.database.prepare(
        `INSERT INTO operator_agentic_plan_edges (plan_id, from_node_id, to_node_id)
         VALUES (?, ?, ?)`,
      );
      for (const node of plan.nodes) {
        insertNode.run(
          plan.planId,
          node.nodeId,
          intent.missionId,
          node.nodeType,
          node.capabilityId,
          node.workerKind,
          node.providerBindingId,
          JSON.stringify(node.dependencyIds),
          JSON.stringify(node.inputRefs),
          node.authorityRequirement,
          JSON.stringify(node.budget),
          node.deadlineOffsetMs,
          node.attemptLimit,
          node.reconciliationMode,
          JSON.stringify(node.evidencePolicy),
          node.payloadHash,
          // A node with no dependency is immediately admissible; every other
          // node starts blocked and is opened only by durable dependency truth.
          node.dependencyIds.length === 0 ? "ready" : "blocked",
          input.idempotencyKeyFor(node.nodeId),
          input.timestamp,
          input.timestamp,
        );
      }
      for (const edge of plan.edges) {
        insertEdge.run(plan.planId, edge.fromNodeId, edge.toNodeId);
      }

      this.appendEvent({
        missionId: intent.missionId,
        planId: plan.planId,
        scope: "mission",
        nodeId: null,
        eventType: "mission_compiled",
        previousState: null,
        newState: "compiled",
        actor: intent.actorId,
        reason: "Intent, verified context, and a deterministic plan were compiled and persisted.",
        timestamp: input.timestamp,
        evidenceReferences: [
          `intent-sha256:${intent.intentHash}`,
          `context-bundle:${input.contextBundle.contextBundleId}`,
          `plan-sha256:${plan.planHash}`,
        ],
      });
      return this.transitionMissionInternal(intent.missionId, "approval_required", {
        actor: intent.actorId,
        reason: "Execution of this plan requires an explicit human approval bound to its exact plan hash.",
        timestamp: input.timestamp,
        evidenceReferences: [`plan-sha256:${plan.planHash}`],
      });
    });
  }

  // -- Transitions ---------------------------------------------------------

  transitionMission(
    missionId: string,
    newState: AgenticPlanState,
    options: AgenticMissionUpdateInput,
  ): AgenticMissionRecord {
    return this.withSavepoint(() => this.transitionMissionInternal(missionId, newState, options));
  }

  /**
   * Records mission-level fields without a state change.
   *
   * Used for facts that accumulate inside one state — a candidate hash produced
   * while the plan is still running, for instance — so recording them never
   * requires inventing a state transition that did not happen.
   */
  updateMission(missionId: string, options: AgenticMissionUpdateInput & { eventType: string }): AgenticMissionRecord {
    return this.withSavepoint(() => {
      const current = this.requireMission(missionId);
      this.applyMissionFields(missionId, options, options.timestamp);
      this.appendEvent({
        missionId,
        planId: current.planId,
        scope: "mission",
        nodeId: null,
        eventType: options.eventType,
        previousState: current.status,
        newState: current.status,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
      return this.requireMission(missionId);
    });
  }

  private transitionMissionInternal(
    missionId: string,
    newState: AgenticPlanState,
    options: AgenticMissionUpdateInput,
  ): AgenticMissionRecord {
    const current = this.requireMission(missionId);
    if (!ALLOWED_PLAN_TRANSITIONS.get(current.status)?.has(newState)) {
      throw new OperatorError(
        `Invalid durable agentic plan transition ${current.status} -> ${newState}.`,
        409,
        "AGENTIC_PLAN_INVALID_TRANSITION",
      );
    }
    const update = this.database.prepare(
      `UPDATE operator_agentic_missions SET status = ?, updated_at = ?
        WHERE mission_id = ? AND status = ?`,
    ).run(newState, options.timestamp, missionId, current.status);
    if (Number(update.changes) !== 1) {
      throw new OperatorError(
        "Durable agentic plan state changed before the transition could be recorded.",
        409,
        "AGENTIC_PLAN_CONCURRENT_TRANSITION",
      );
    }
    this.applyMissionFields(missionId, options, options.timestamp);
    this.appendEvent({
      missionId,
      planId: current.planId,
      scope: "plan",
      nodeId: null,
      eventType: `plan_${newState}`,
      previousState: current.status,
      newState,
      actor: options.actor,
      reason: options.reason,
      timestamp: options.timestamp,
      evidenceReferences: options.evidenceReferences ?? [],
      typedError: options.typedError ?? null,
    });
    return this.requireMission(missionId);
  }

  private applyMissionFields(
    missionId: string,
    options: AgenticMissionUpdateInput,
    timestamp: string,
  ): void {
    const assignments: string[] = [];
    const values: Array<string | number | null> = [];
    const set = (column: string, value: string | number | null): void => {
      assignments.push(`${column} = ?`);
      values.push(value);
    };
    if (options.executionApprovedBy !== undefined) {
      set("execution_approved_by", options.executionApprovedBy);
      set("execution_approved_at", timestamp);
    }
    if (options.executionApprovedPlanHash !== undefined) {
      set("execution_approved_plan_hash", options.executionApprovedPlanHash);
    }
    if (options.candidateHash !== undefined) set("candidate_hash", options.candidateHash);
    if (options.candidateMarkdown !== undefined) set("candidate_markdown", options.candidateMarkdown);
    if (options.candidateApprovedBy !== undefined) {
      set("candidate_approved_by", options.candidateApprovedBy);
      set("candidate_approved_at", timestamp);
    }
    if (options.approvedCandidateHash !== undefined) {
      set("approved_candidate_hash", options.approvedCandidateHash);
    }
    if (options.candidateApprovalExpiresAt !== undefined) {
      set("candidate_approval_expires_at", options.candidateApprovalExpiresAt);
    }
    if (options.candidateAuthorityRevision !== undefined) {
      set("candidate_authority_revision", options.candidateAuthorityRevision);
    }
    if (options.artifactHash !== undefined) set("artifact_hash", options.artifactHash);
    if (options.artifactName !== undefined) set("artifact_name", options.artifactName);
    if (options.valueObservation !== undefined) {
      set("value_observation_json", options.valueObservation === null
        ? null
        : JSON.stringify(options.valueObservation));
    }
    if (options.typedError !== undefined) {
      set("typed_error_json", options.typedError === null ? null : JSON.stringify(options.typedError));
    }
    if (assignments.length === 0) return;
    assignments.push("updated_at = ?");
    values.push(timestamp, missionId);
    this.database
      .prepare(`UPDATE operator_agentic_missions SET ${assignments.join(", ")} WHERE mission_id = ?`)
      .run(...values);
  }

  transitionNode(
    planId: string,
    nodeId: string,
    newState: AgenticNodeState,
    options: AgenticNodeTransitionInput,
  ): AgenticNodeRecord {
    return this.withSavepoint(() => {
      const current = this.requireNode(planId, nodeId);
      if (!ALLOWED_NODE_TRANSITIONS.get(current.state)?.has(newState)) {
        throw new OperatorError(
          `Invalid durable agentic node transition ${current.state} -> ${newState} for node ${nodeId}.`,
          409,
          "AGENTIC_NODE_INVALID_TRANSITION",
        );
      }
      const update = this.database.prepare(
        `UPDATE operator_agentic_plan_nodes
            SET state = ?, attempts = ?, lease_owner = ?, lease_expires_at = ?, deadline_at = ?,
                output_json = ?, output_hash = ?, cost_json = ?, latency_ms = ?,
                reconciliation_outcome = ?, reconciled_at = ?, typed_error_json = ?,
                started_at = ?, completed_at = ?, updated_at = ?
          WHERE plan_id = ? AND node_id = ? AND state = ?`,
      ).run(
        newState,
        options.attempts ?? current.attempts,
        options.leaseOwner === undefined ? current.leaseOwner : options.leaseOwner,
        options.leaseExpiresAt === undefined ? current.leaseExpiresAt : options.leaseExpiresAt,
        options.deadlineAt === undefined ? current.deadlineAt : options.deadlineAt,
        options.output === undefined
          ? (current.output === null ? null : JSON.stringify(current.output))
          : (options.output === null ? null : JSON.stringify(options.output)),
        options.outputHash === undefined ? current.outputHash : options.outputHash,
        options.cost === undefined
          ? (current.cost === null ? null : JSON.stringify(current.cost))
          : (options.cost === null ? null : JSON.stringify(options.cost)),
        options.latencyMs === undefined ? current.latencyMs : options.latencyMs,
        options.reconciliationOutcome === undefined
          ? current.reconciliationOutcome
          : options.reconciliationOutcome,
        options.reconciledAt === undefined ? current.reconciledAt : options.reconciledAt,
        options.typedError === undefined
          ? (current.typedError === null ? null : JSON.stringify(current.typedError))
          : (options.typedError === null ? null : JSON.stringify(options.typedError)),
        options.startedAt === undefined ? current.startedAt : options.startedAt,
        options.completedAt === undefined ? current.completedAt : options.completedAt,
        options.timestamp,
        planId,
        nodeId,
        current.state,
      );
      if (Number(update.changes) !== 1) {
        throw new OperatorError(
          "Durable agentic node state changed before the transition could be recorded.",
          409,
          "AGENTIC_NODE_CONCURRENT_TRANSITION",
        );
      }
      this.appendEvent({
        missionId: current.missionId,
        planId,
        scope: "node",
        nodeId,
        eventType: `node_${newState}`,
        previousState: current.state,
        newState,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
      return this.requireNode(planId, nodeId);
    });
  }

  /** Records a node-scoped fact that changes no state (a reconcile finding). */
  appendNodeAuditEvent(
    planId: string,
    nodeId: string,
    eventType: string,
    options: AgenticNodeTransitionInput,
  ): AgenticNodeRecord {
    return this.withSavepoint(() => {
      const current = this.requireNode(planId, nodeId);
      if (
        options.reconciliationOutcome !== undefined
        || options.reconciledAt !== undefined
        || options.leaseOwner !== undefined
        || options.attempts !== undefined
      ) {
        this.database.prepare(
          `UPDATE operator_agentic_plan_nodes
              SET reconciliation_outcome = ?, reconciled_at = ?, lease_owner = ?,
                  lease_expires_at = ?, attempts = ?, updated_at = ?
            WHERE plan_id = ? AND node_id = ?`,
        ).run(
          options.reconciliationOutcome === undefined
            ? current.reconciliationOutcome
            : options.reconciliationOutcome,
          options.reconciledAt === undefined ? current.reconciledAt : options.reconciledAt,
          options.leaseOwner === undefined ? current.leaseOwner : options.leaseOwner,
          options.leaseExpiresAt === undefined ? current.leaseExpiresAt : options.leaseExpiresAt,
          // Recording an attempt allowance without a state change. A node
          // already sitting in `failed_recoverable` cannot transition to itself,
          // and inventing a round trip through another state purely to carry
          // this number would journal two transitions that never happened.
          options.attempts === undefined ? current.attempts : options.attempts,
          options.timestamp,
          planId,
          nodeId,
        );
      }
      this.appendEvent({
        missionId: current.missionId,
        planId,
        scope: "node",
        nodeId,
        eventType,
        previousState: current.state,
        newState: current.state,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
      return this.requireNode(planId, nodeId);
    });
  }

  /** Persists the evidence one node emitted. Idempotent on (plan, node, evidence). */
  recordNodeEvidence(
    missionId: string,
    planId: string,
    nodeId: string,
    evidence: readonly AgenticNodeEvidence[],
    timestamp: string,
  ): void {
    this.withSavepoint(() => {
      const insert = this.database.prepare(
        `INSERT OR IGNORE INTO operator_agentic_node_evidence (
          evidence_id, plan_id, node_id, mission_id, kind, label,
          source_reference, content_hash, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of evidence) {
        insert.run(
          item.evidenceId,
          planId,
          nodeId,
          missionId,
          item.kind,
          item.label,
          item.sourceReference,
          item.contentHash,
          timestamp,
        );
      }
    });
  }

  /**
   * Records the one artifact write.
   *
   * The primary key does the enforcing: a second write under the same identity
   * raises rather than incrementing a counter, so "exactly once" is a database
   * guarantee rather than a convention every caller must remember.
   */
  recordArtifactWrite(record: AgenticArtifactWriteRecord): void {
    const existing = this.getArtifactWrite(record.missionId, record.artifactName);
    if (existing) {
      if (existing.artifactHash !== record.artifactHash) {
        throw new OperatorError(
          "A different artifact was already written under this mission identity.",
          409,
          "AGENTIC_ARTIFACT_WRITE_CONFLICT",
          { existingArtifactHash: existing.artifactHash, attemptedArtifactHash: record.artifactHash },
        );
      }
      return;
    }
    this.database.prepare(
      `INSERT INTO operator_agentic_artifact_writes (
        mission_id, artifact_name, artifact_hash, approved_candidate_hash,
        byte_length, artifact_path, written_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.missionId,
      record.artifactName,
      record.artifactHash,
      record.approvedCandidateHash,
      record.byteLength,
      record.artifactPath,
      record.writtenAt,
    );
  }

  // -- Runtime provider usage store -----------------------------------------

  /**
   * The durable backing for the Runtime's `AgenticProviderUsageStore`.
   *
   * Deliberately the same SQLite file, and deliberately a different table from
   * the worker records: the two answer different questions at different moments.
   * A worker record says "this node finished and produced exactly this"; a
   * provider usage row says "this provider was reached, and here is what it
   * cost". The second is written first, which is why an interruption between
   * them cannot produce an untracked charge.
   */
  createProviderUsageStore(): AgenticProviderUsageStore {
    const database = this.database;
    const toRecord = (row: ProviderUsageRow): AgenticProviderUsageRecord => ({
      schemaVersion: AGENTIC_MODEL_PROVIDER_CONTRACT_VERSION,
      providerCallKey: row.provider_call_key,
      missionId: row.mission_id,
      planId: row.plan_id,
      nodeId: row.node_id,
      idempotencyKey: row.idempotency_key,
      capabilityId: row.capability_id,
      bindingId: row.binding_id,
      providerName: row.provider_name,
      modelId: row.model_id,
      mode: row.mode as AgenticProviderUsageRecord["mode"],
      attempt: Number(row.attempt),
      providerRequestId: row.provider_request_id,
      requestHash: row.request_hash,
      rawResponseHash: row.raw_response_hash,
      responseHash: row.response_hash,
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      totalTokens: row.total_tokens === null ? null : Number(row.total_tokens),
      monetaryCostMicros: row.monetary_cost_micros === null ? null : Number(row.monetary_cost_micros),
      monetaryCostSource: row.monetary_cost_source as AgenticProviderUsageRecord["monetaryCostSource"],
      monetaryCostUnavailableReason: row.monetary_cost_unavailable_reason,
      pricingRevision: row.pricing_revision,
      latencyMs: Number(row.latency_ms),
      finishReason: row.finish_reason,
      typedError: parseJson<AgenticProviderUsageRecord["typedError"]>(row.typed_error_json) ?? null,
      fallbackDecision: row.fallback_decision as AgenticProviderUsageRecord["fallbackDecision"],
      fallbackFromBindingId: row.fallback_from_binding_id,
      evidenceReferencesCited: parseJson<string[]>(row.evidence_references_json) ?? [],
      reconciliation: parseJson<AgenticProviderReconciliation>(row.reconciliation_json)
        ?? AGENTIC_RECONCILIATION_NOT_ATTEMPTED,
      recordedAt: row.recorded_at,
    });

    return {
      read(providerCallKey: string): AgenticProviderUsageRecord | null {
        const row = database
          .prepare("SELECT * FROM operator_agentic_provider_usage WHERE provider_call_key = ?")
          .get(providerCallKey) as unknown as ProviderUsageRow | undefined;
        return row ? toRecord(row) : null;
      },
      record(usage: AgenticProviderUsageRecord): void {
        // `OR IGNORE`, never `OR REPLACE`. A second write under one call key is
        // a replay of a charge that already happened; overwriting it would erase
        // the very evidence that proves the first call occurred.
        database.prepare(
          `INSERT OR IGNORE INTO operator_agentic_provider_usage (
            provider_call_key, mission_id, plan_id, node_id, idempotency_key, capability_id,
            binding_id, provider_name, model_id, mode, attempt, provider_request_id,
            request_hash, raw_response_hash, response_hash, input_tokens, output_tokens, total_tokens,
            monetary_cost_micros, monetary_cost_source, monetary_cost_unavailable_reason, pricing_revision,
            latency_ms, finish_reason, typed_error_json, fallback_decision, fallback_from_binding_id,
            evidence_references_json, reconciliation_json, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          usage.providerCallKey,
          usage.missionId,
          usage.planId,
          usage.nodeId,
          usage.idempotencyKey,
          usage.capabilityId,
          usage.bindingId,
          usage.providerName,
          usage.modelId,
          usage.mode,
          usage.attempt,
          usage.providerRequestId,
          usage.requestHash,
          usage.rawResponseHash,
          usage.responseHash,
          usage.inputTokens,
          usage.outputTokens,
          usage.totalTokens,
          usage.monetaryCostMicros,
          usage.monetaryCostSource,
          usage.monetaryCostUnavailableReason,
          usage.pricingRevision,
          usage.latencyMs,
          usage.finishReason,
          usage.typedError === null ? null : JSON.stringify(usage.typedError),
          usage.fallbackDecision,
          usage.fallbackFromBindingId,
          JSON.stringify(usage.evidenceReferencesCited),
          JSON.stringify(usage.reconciliation),
          usage.recordedAt,
        );
      },
      recordReconciliation(providerCallKey: string, reconciliation: AgenticProviderReconciliation): void {
        // Updates only. A reconciliation describes a charge that is already
        // durable; creating a row here would be evidence for a charge nobody
        // recorded, which is worse than no evidence at all.
        database.prepare(
          "UPDATE operator_agentic_provider_usage SET reconciliation_json = ? WHERE provider_call_key = ?",
        ).run(JSON.stringify(reconciliation), providerCallKey);
      },
      listForNode(idempotencyKey: string): readonly AgenticProviderUsageRecord[] {
        return (database
          .prepare(
            `SELECT * FROM operator_agentic_provider_usage
              WHERE idempotency_key = ? ORDER BY provider_call_key ASC`,
          )
          .all(idempotencyKey) as unknown as ProviderUsageRow[]).map(toRecord);
      },
    };
  }

  /** Every provider usage row recorded for one mission, oldest call key first. */
  listProviderUsage(missionId: string): readonly AgenticProviderUsageRecord[] {
    const store = this.createProviderUsageStore();
    return (this.database
      .prepare(
        `SELECT provider_call_key FROM operator_agentic_provider_usage
          WHERE mission_id = ? ORDER BY recorded_at ASC, provider_call_key ASC`,
      )
      .all(missionId) as Array<{ provider_call_key: string }>)
      .map((row) => store.read(row.provider_call_key))
      .filter((record): record is AgenticProviderUsageRecord => record !== null);
  }

  /** Durable count of provider invocations for one node execution identity. */
  countProviderCallsForNode(idempotencyKey: string): number {
    const row = this.database
      .prepare("SELECT COUNT(*) AS total FROM operator_agentic_provider_usage WHERE idempotency_key = ?")
      .get(idempotencyKey) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  }

  // -- Runtime worker record store ------------------------------------------

  /**
   * The durable backing for the Runtime's `AgenticNodeRecordStore`.
   *
   * Claims and outcomes share one table so "claimed but not recorded" is a
   * readable state rather than an absence — which is exactly what a node-level
   * reconcile needs in order to distinguish "the worker never ran" from "the
   * worker ran and we lost the answer".
   */
  createWorkerRecordStore(
    clock: () => string,
    claimIdFactory: () => string = randomUUID,
  ): OperatorAgenticNodeRecordStore {
    const database = this.database;
    // A second Operator process waits for the millisecond-scale claim
    // transaction to commit rather than surfacing an expected SQLITE_BUSY.
    // The wait is bounded; lock failures beyond it remain real database errors.
    database.exec("PRAGMA busy_timeout = 5000;");

    // Runtime's interface intentionally returns only the canonical claim
    // outcome. Operator retains the exact acquisition token privately so the
    // same store instance can bind outcome recording and deadline release to
    // the authority it actually acquired.
    const locallyHeldClaims = new Map<string, AgenticWorkerClaimIdentity>();

    const readAuthority = (idempotencyKey: string): WorkerRecordRow | undefined =>
      database
        .prepare("SELECT * FROM operator_agentic_worker_records WHERE idempotency_key = ?")
        .get(idempotencyKey) as WorkerRecordRow | undefined;

    const snapshot = (row: WorkerRecordRow | undefined): AgenticWorkerAuthoritySnapshot | null =>
      row
        ? {
          idempotencyKey: row.idempotency_key,
          executionHash: row.execution_hash,
          claimOwner: row.claim_owner,
          claimedAt: row.claimed_at,
          recordedAt: row.recorded_at,
        }
        : null;

    const classify = (
      row: WorkerRecordRow,
      executionHash: string,
    ): AgenticNodeClaimOutcome | "released" => {
      if (row.execution_hash !== executionHash) return "binding_mismatch";
      if (row.recorded_at) return "already_recorded";
      if (row.claim_owner) return "in_flight";
      return "released";
    };

    const classifyLosingWrite = (
      idempotencyKey: string,
      executionHash: string,
    ): AgenticNodeClaimOutcome => {
      const current = readAuthority(idempotencyKey);
      if (current) {
        const outcome = classify(current, executionHash);
        if (outcome !== "released") return outcome;
      }
      // A zero-row write that still observes no committed winner is not claim
      // authority. It is an impossible state under BEGIN IMMEDIATE, so surface
      // it as a typed durable-state conflict rather than lying with `claimed`.
      throw new OperatorError(
        "The durable worker claim did not acquire authority and no committed winner could be classified.",
        409,
        "AGENTIC_WORKER_CLAIM_NOT_ACQUIRED",
        { idempotencyKey },
      );
    };

    return {
      claim(idempotencyKey: string, executionHash: string): AgenticNodeClaimOutcome {
        return withTransaction(database, () => {
          const row = readAuthority(idempotencyKey);
          if (row) {
            const existing = classify(row, executionHash);
            if (existing !== "released") return existing;
          }

          const claim: AgenticWorkerClaimIdentity = {
            idempotencyKey,
            executionHash,
            claimOwner: claimIdFactory(),
            claimedAt: clock(),
          };

          if (row) {
            const write = database.prepare(
              `UPDATE operator_agentic_worker_records
                  SET claim_owner = ?, claimed_at = ?
                WHERE idempotency_key = ?
                  AND execution_hash = ?
                  AND claim_owner IS NULL
                  AND recorded_at IS NULL`,
            ).run(
              claim.claimOwner,
              claim.claimedAt,
              idempotencyKey,
              executionHash,
            );
            if (write.changes !== 1) return classifyLosingWrite(idempotencyKey, executionHash);
          } else {
            // The conflict target is deliberately only the durable identity
            // key. Expected first-claim contention is translated to a zero-row
            // result; every unrelated SQLite failure still throws.
            const write = database.prepare(
              `INSERT INTO operator_agentic_worker_records (
                idempotency_key, execution_hash, capability_id, claim_owner, claimed_at
              ) VALUES (?, ?, '', ?, ?)
              ON CONFLICT(idempotency_key) DO NOTHING`,
            ).run(
              idempotencyKey,
              executionHash,
              claim.claimOwner,
              claim.claimedAt,
            );
            if (write.changes !== 1) return classifyLosingWrite(idempotencyKey, executionHash);
          }

          locallyHeldClaims.set(idempotencyKey, claim);
          return "claimed";
        });
      },
      recordWorkerOutcome(record: AgenticNodeWorkerRecord): void {
        const held = locallyHeldClaims.get(record.idempotencyKey);
        if (!held || held.executionHash !== record.executionHash) {
          throw new OperatorError(
            "This worker store does not hold the exact durable authority required to record the outcome.",
            409,
            "AGENTIC_WORKER_RECORD_AUTHORITY_MISSING",
            { idempotencyKey: record.idempotencyKey },
          );
        }
        const write = database.prepare(
          `UPDATE operator_agentic_worker_records
              SET capability_id = ?, status = ?, structured_output_json = ?, output_hash = ?,
                  evidence_json = ?, tool_calls_json = ?, cost_json = ?, latency_ms = ?,
                  typed_error_json = ?, recorded_at = ?, claim_owner = NULL
            WHERE idempotency_key = ?
              AND execution_hash = ?
              AND claim_owner = ?
              AND claimed_at = ?
              AND recorded_at IS NULL`,
        ).run(
          record.capabilityId,
          record.status,
          record.structuredOutput === null ? null : JSON.stringify(record.structuredOutput),
          record.outputHash,
          JSON.stringify(record.evidence),
          JSON.stringify(record.toolCallRecords),
          JSON.stringify(record.cost),
          record.latencyMs,
          record.typedError === null ? null : JSON.stringify(record.typedError),
          record.recordedAt,
          record.idempotencyKey,
          record.executionHash,
          held.claimOwner,
          held.claimedAt,
        );
        if (write.changes !== 1) {
          readAuthority(record.idempotencyKey);
          throw new OperatorError(
            "Durable worker authority changed before the outcome could be recorded.",
            409,
            "AGENTIC_WORKER_RECORD_AUTHORITY_LOST",
            { idempotencyKey: record.idempotencyKey },
          );
        }
        locallyHeldClaims.delete(record.idempotencyKey);
      },
      read(idempotencyKey: string): AgenticNodeWorkerRecord | null {
        const row = database
          .prepare("SELECT * FROM operator_agentic_worker_records WHERE idempotency_key = ?")
          .get(idempotencyKey) as WorkerRecordRow | undefined;
        if (!row?.recorded_at || !row.status) return null;
        return {
          idempotencyKey: row.idempotency_key,
          executionHash: row.execution_hash,
          capabilityId: row.capability_id,
          status: row.status as AgenticNodeWorkerRecord["status"],
          structuredOutput: parseJson<JsonValue>(row.structured_output_json),
          outputHash: row.output_hash,
          evidence: (parseJson<AgenticNodeEvidence[]>(row.evidence_json) ?? []),
          toolCallRecords: (parseJson<AgenticNodeToolCallRecord[]>(row.tool_calls_json) ?? []),
          cost: (parseJson<AgenticNodeCost>(row.cost_json)
            ?? { toolCalls: 0, modelCalls: 0, tokenCost: null, monetaryCostMicros: null }),
          latencyMs: Number(row.latency_ms ?? 0),
          typedError: parseJson<AgenticTypedError>(row.typed_error_json) as
            AgenticNodeWorkerRecord["typedError"],
          recordedAt: row.recorded_at,
        };
      },
      releaseClaim(idempotencyKey: string): void {
        const held = locallyHeldClaims.get(idempotencyKey);
        if (!held) return;
        const write = database.prepare(
          `UPDATE operator_agentic_worker_records
              SET claim_owner = NULL, claimed_at = NULL
            WHERE idempotency_key = ?
              AND execution_hash = ?
              AND claim_owner = ?
              AND claimed_at = ?
              AND recorded_at IS NULL`,
        ).run(
          held.idempotencyKey,
          held.executionHash,
          held.claimOwner,
          held.claimedAt,
        );
        if (write.changes === 0) readAuthority(idempotencyKey);
        locallyHeldClaims.delete(idempotencyKey);
      },
      inspectActiveClaim(idempotencyKey: string): AgenticWorkerClaimIdentity | null {
        const row = readAuthority(idempotencyKey);
        if (!row || row.recorded_at || !row.claim_owner || !row.claimed_at) return null;
        return {
          idempotencyKey: row.idempotency_key,
          executionHash: row.execution_hash,
          claimOwner: row.claim_owner,
          claimedAt: row.claimed_at,
        };
      },
      retireOrphanClaim(expected: AgenticWorkerClaimIdentity): AgenticOrphanClaimRetirement {
        const write = database.prepare(
          `UPDATE operator_agentic_worker_records
              SET claim_owner = NULL, claimed_at = NULL
            WHERE idempotency_key = ?
              AND execution_hash = ?
              AND claim_owner = ?
              AND claimed_at = ?
              AND recorded_at IS NULL`,
        ).run(
          expected.idempotencyKey,
          expected.executionHash,
          expected.claimOwner,
          expected.claimedAt,
        );
        if (write.changes === 1) {
          const held = locallyHeldClaims.get(expected.idempotencyKey);
          if (held?.claimOwner === expected.claimOwner) {
            locallyHeldClaims.delete(expected.idempotencyKey);
          }
          return { retired: true, current: snapshot(readAuthority(expected.idempotencyKey)) };
        }
        return { retired: false, current: snapshot(readAuthority(expected.idempotencyKey)) };
      },
    };
  }

  // -- Internals -----------------------------------------------------------

  private appendEvent(event: {
    missionId: string;
    planId: string;
    scope: "mission" | "plan" | "node";
    nodeId: string | null;
    eventType: string;
    previousState: string | null;
    newState: string | null;
    actor: string;
    reason: string;
    timestamp: string;
    evidenceReferences?: readonly string[];
    typedError?: AgenticTypedError | null;
  }): void {
    const sequenceRow = this.database
      .prepare(
        `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
           FROM operator_agentic_plan_events WHERE mission_id = ?`,
      )
      .get(event.missionId) as { next_sequence: number };
    this.database.prepare(
      `INSERT INTO operator_agentic_plan_events (
        event_id, mission_id, plan_id, sequence, scope, node_id, event_type,
        previous_state, new_state, actor, reason, timestamp,
        evidence_refs_json, typed_error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.idFactory(),
      event.missionId,
      event.planId,
      Number(sequenceRow.next_sequence),
      event.scope,
      event.nodeId,
      event.eventType,
      event.previousState,
      event.newState,
      event.actor,
      event.reason,
      event.timestamp,
      JSON.stringify(event.evidenceReferences ?? []),
      event.typedError ? JSON.stringify(event.typedError) : null,
    );
  }

  private withSavepoint<T>(operation: () => T): T {
    this.database.exec("SAVEPOINT agentic_plan_journal_atomic");
    try {
      const result = operation();
      this.database.exec("RELEASE SAVEPOINT agentic_plan_journal_atomic");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT agentic_plan_journal_atomic");
      this.database.exec("RELEASE SAVEPOINT agentic_plan_journal_atomic");
      throw error;
    }
  }
}
