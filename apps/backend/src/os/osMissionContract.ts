/**
 * CHANTER OS unified mission control plane — canonical contract.
 *
 * This module is the single place that defines what "one CHANTER OS mission"
 * means across every execution lane. It holds only pure declarations and total
 * mapping functions: no database, no HTTP, no service. The projection service
 * (`osMissionControlService.ts`) is the only consumer, so a lane can never grow
 * its own private idea of identity, state, authority, or evidence.
 *
 * Three invariants shape everything below.
 *
 *   1. **Existing stores stay authoritative.** Nothing here persists anything.
 *      Every OS field is derived from durable truth that a reviewed lane
 *      authority already owns — `operator_missions`, the Phase 2D mission graph,
 *      `operator_platform_autoposter_commands`, `autoposter_runtime_missions`,
 *      and the Runtime's persisted approval checkpoints.
 *
 *   2. **Identity is derived, never minted.** `osMissionId` is a pure function
 *      of (lane, lane-native id), so a read, a list, a replay, and a restart all
 *      produce the same identity, and no projection needs a new id table or a
 *      random value. The lane is part of the identity, so an id from one lane
 *      can never resolve inside another.
 *
 *   3. **No state may imply completion without authoritative evidence.** The
 *      state mapping below is deliberately conservative: every non-terminal or
 *      ambiguous lane state maps to a non-completed OS state, and `completed` is
 *      reachable only from a lane state that already required durable
 *      downstream evidence to be entered.
 */
import {
  resolveRegisteredMissionAction,
  type RegisteredMissionAction,
} from "../missions/missionActionRegistry.js";

// ---------------------------------------------------------------------------
// Canonical state taxonomy
// ---------------------------------------------------------------------------

/**
 * The one OS-level state taxonomy both proven lanes map onto.
 *
 * Lane-specific internal states are retained by their own authorities and are
 * still exposed verbatim on the projection (`laneState`), so this mapping adds
 * a truthful common vocabulary without deleting any lane's real detail.
 */
export const OS_MISSION_STATES = [
  "submitted",
  "approval_required",
  "approved",
  "execution_started",
  "downstream_request_prepared",
  "downstream_result_observed",
  "completed",
  "failed_recoverable",
  "reconciliation_required",
  "failed_terminal",
  "stopped",
] as const;

export type OsMissionState = (typeof OS_MISSION_STATES)[number];

/** OS states from which no further automatic progress is possible. */
const TERMINAL_OS_STATES: ReadonlySet<OsMissionState> = new Set<OsMissionState>([
  "completed",
  "failed_terminal",
  "stopped",
]);

export function isTerminalOsMissionState(state: OsMissionState): boolean {
  return TERMINAL_OS_STATES.has(state);
}

/**
 * The durable execution-journal state shared, byte for byte, by both mission
 * spines (`operator_mission_executions` and `autoposter_mission_executions`).
 * Declared here rather than imported from either journal so the mapping below
 * is provably total over one closed world instead of over whichever lane
 * happened to be imported first.
 */
export type OsLaneExecutionState =
  | "approval_required"
  | "approved"
  | "execution_started"
  | "downstream_request_prepared"
  | "downstream_result_observed"
  | "result_persisted"
  | "completed"
  | "failed_recoverable"
  | "failed_terminal"
  | "reconciliation_required"
  | "recovery_in_progress";

/** The recovery classification a human stop writes into the journal. */
export const STOPPED_RECOVERY_CLASSIFICATION = "STOPPED_FOR_ESCALATION";

/**
 * Maps one durable mission-execution state onto the canonical OS taxonomy.
 *
 * Two mappings are deliberately lossy in the safe direction:
 *
 *   - `result_persisted` maps to `downstream_result_observed`, never
 *     `completed`. Operator has persisted the result but has not yet journaled
 *     the completion boundary, so claiming completion here would assert an
 *     outcome the durable record does not yet carry.
 *   - `recovery_in_progress` maps to `failed_recoverable`. A bounded recovery
 *     attempt is in flight; until it lands, the honest OS answer is still
 *     "recoverable failure", never "executing".
 *
 * `failed_terminal` splits on the journaled recovery classification so a human
 * stop reads as `stopped` rather than as a system failure.
 */
export function osStateFromExecutionState(
  state: OsLaneExecutionState,
  recoveryClassification: string,
): OsMissionState {
  switch (state) {
    case "approval_required":
      return "approval_required";
    case "approved":
      return "approved";
    case "execution_started":
      return "execution_started";
    case "downstream_request_prepared":
      return "downstream_request_prepared";
    case "downstream_result_observed":
    case "result_persisted":
      return "downstream_result_observed";
    case "completed":
      return "completed";
    case "recovery_in_progress":
    case "failed_recoverable":
      return "failed_recoverable";
    case "reconciliation_required":
      return "reconciliation_required";
    case "failed_terminal":
      return recoveryClassification === STOPPED_RECOVERY_CLASSIFICATION
        ? "stopped"
        : "failed_terminal";
  }
}

/** The Phase 2D graph orchestration state, mapped onto the same taxonomy. */
export type OsGraphState =
  | "approval_required"
  | "approved"
  | "running"
  | "completed"
  | "failed_recoverable"
  | "failed_terminal"
  | "cancelled";

export function osStateFromGraphState(state: OsGraphState): OsMissionState {
  switch (state) {
    case "approval_required":
      return "approval_required";
    case "approved":
      return "approved";
    case "running":
      return "execution_started";
    case "completed":
      return "completed";
    case "failed_recoverable":
      return "failed_recoverable";
    case "failed_terminal":
      return "failed_terminal";
    case "cancelled":
      return "stopped";
  }
}

// ---------------------------------------------------------------------------
// Canonical lane registry
// ---------------------------------------------------------------------------

export const OS_MISSION_LANES = [
  "generic_governed_task",
  "platform_autoposter_command",
  "autoposter_direct_mission",
] as const;

export type OsMissionLane = (typeof OS_MISSION_LANES)[number];

/** How a lane's bounded execution becomes authorized. */
export type OsApprovalRequirement =
  /** One control-capability approval names the approver and authorizes execution. */
  | "operator_control_approval"
  /** Control-capability approval that must additionally carry the exact graph hash. */
  | "operator_control_approval_bound_to_graph_hash";

/** How a lane resolves an ambiguous downstream outcome before any retry. */
export type OsReconciliationMode =
  /** Read exact downstream truth first; retry only on a proven absent binding. */
  | "downstream_lookup_before_retry";

export interface OsMissionLaneSpec {
  readonly lane: OsMissionLane;
  /**
   * The canonical intake schema this lane accepts on `POST /api/os/missions`.
   * `null` marks an observed-only lane: it is projected, listed, and governed
   * through OS control actions, but the OS submit route never creates one,
   * because its (product, action) pair is already claimed by a submittable
   * lane and two intakes for one identity would be ambiguous.
   */
  readonly intakeSchemaVersion: string | null;
  readonly product: string;
  readonly action: string;
  readonly approvalRequirement: OsApprovalRequirement;
  /** The exact bounded effect a lane's execution is permitted to have. */
  readonly executionScope: string;
  /** True only for a lane permitted to reach a real external system. */
  readonly realExternalExecutionAllowed: boolean;
  readonly reconciliationMode: OsReconciliationMode;
  /** The durable Operator record that owns this lane's canonical truth. */
  readonly sourceOfTruth: string;
}

/**
 * The single canonical OS lane registry.
 *
 * Registration is a reviewed code change, never data, and every entry's
 * (product, action) pair is cross-checked against the existing closed-world
 * `missionActionRegistry` at module load — see `assertLaneRegistryIsConsistent`
 * below. That check is what keeps this from becoming a second, drifting
 * capability registry: OS metadata lives here, action truth stays there, and
 * the two cannot disagree without failing the process at startup.
 */
export const OS_MISSION_LANE_SPECS: readonly OsMissionLaneSpec[] = Object.freeze([
  Object.freeze({
    lane: "generic_governed_task" as const,
    intakeSchemaVersion: "chanter.mission.v1",
    product: "loop_governor",
    action: "loop_governor.manual_loop.create",
    approvalRequirement: "operator_control_approval" as const,
    executionScope: "loop_governor_manual_loop_create_only",
    realExternalExecutionAllowed: false,
    reconciliationMode: "downstream_lookup_before_retry" as const,
    sourceOfTruth: "operator_missions",
  }),
  Object.freeze({
    lane: "platform_autoposter_command" as const,
    intakeSchemaVersion: "chanter.platform.autoposter.create-work.v1",
    product: "auto_poster",
    action: "autoposter.post.schedule",
    approvalRequirement: "operator_control_approval_bound_to_graph_hash" as const,
    executionScope: "autoposter_unapproved_draft_only",
    realExternalExecutionAllowed: true,
    reconciliationMode: "downstream_lookup_before_retry" as const,
    sourceOfTruth: "operator_platform_autoposter_commands",
  }),
  Object.freeze({
    lane: "autoposter_direct_mission" as const,
    intakeSchemaVersion: null,
    product: "auto_poster",
    action: "autoposter.post.schedule",
    approvalRequirement: "operator_control_approval" as const,
    executionScope: "autoposter_unapproved_draft_only",
    realExternalExecutionAllowed: true,
    reconciliationMode: "downstream_lookup_before_retry" as const,
    sourceOfTruth: "autoposter_runtime_missions",
  }),
]);

export function osMissionLaneSpec(lane: OsMissionLane): OsMissionLaneSpec {
  const spec = OS_MISSION_LANE_SPECS.find((candidate) => candidate.lane === lane);
  /* c8 ignore next 3 -- unreachable: `lane` is the closed union above. */
  if (!spec) {
    throw new Error(`No OS mission lane is registered for ${lane}.`);
  }
  return spec;
}

/** Resolves the submittable lane that owns one canonical intake schema. */
export function osLaneForIntakeSchema(schemaVersion: unknown): OsMissionLaneSpec | null {
  if (typeof schemaVersion !== "string" || !schemaVersion) return null;
  return OS_MISSION_LANE_SPECS.find(
    (candidate) => candidate.intakeSchemaVersion === schemaVersion,
  ) ?? null;
}

/** The reviewed action entry backing one lane, from the existing registry. */
export function registeredActionForLane(spec: OsMissionLaneSpec): RegisteredMissionAction {
  const registered = resolveRegisteredMissionAction(spec.product, spec.action);
  /* c8 ignore next 5 -- unreachable: enforced at module load below. */
  if (!registered) {
    throw new Error(
      `OS lane ${spec.lane} references an unregistered mission action ${spec.product}/${spec.action}.`,
    );
  }
  return registered;
}

/**
 * Fails the process at import time if the OS lane registry has drifted from the
 * reviewed action registry. Routing metadata that names an action nobody
 * executes — or an intake schema claimed by two lanes — is a contract defect,
 * and the only safe moment to surface it is before the server accepts traffic.
 */
function assertLaneRegistryIsConsistent(): void {
  const seenIntakeSchemas = new Set<string>();
  for (const spec of OS_MISSION_LANE_SPECS) {
    registeredActionForLane(spec);
    if (spec.intakeSchemaVersion === null) continue;
    if (seenIntakeSchemas.has(spec.intakeSchemaVersion)) {
      throw new Error(
        `Two OS lanes claim the intake schema ${spec.intakeSchemaVersion}; intake routing would be ambiguous.`,
      );
    }
    seenIntakeSchemas.add(spec.intakeSchemaVersion);
  }
}

assertLaneRegistryIsConsistent();

// ---------------------------------------------------------------------------
// Canonical identity
// ---------------------------------------------------------------------------

const OS_MISSION_ID_PREFIX = "os";

/**
 * Derives the canonical OS mission identity from its lane and lane-native id.
 *
 * Deterministic and side-effect free: the same lane record always yields the
 * same identity across reads, lists, replays, and restarts, so no correlation
 * table is required and no read ever mints an id. The lane is embedded, so an
 * identity minted for one lane can never resolve against another lane's store.
 */
export function osMissionIdFor(lane: OsMissionLane, laneNativeId: string): string {
  return `${OS_MISSION_ID_PREFIX}:${lane}:${laneNativeId}`;
}

export interface ParsedOsMissionId {
  readonly lane: OsMissionLane;
  readonly laneNativeId: string;
}

/**
 * Parses a canonical OS mission identity back into its lane binding.
 *
 * Returns `null` for anything that is not exactly `os:<registered lane>:<id>`.
 * An unparseable or unregistered identity is refused by the caller rather than
 * being probed against each lane in turn — that probing is exactly how an
 * unknown id silently falls through into the wrong lane.
 */
export function parseOsMissionId(value: unknown): ParsedOsMissionId | null {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (parts.length < 3 || parts[0] !== OS_MISSION_ID_PREFIX) return null;
  const lane = parts[1] as OsMissionLane;
  if (!OS_MISSION_LANES.includes(lane)) return null;
  // Lane-native ids may themselves contain ':', so everything after the lane
  // segment is the id — rejoined verbatim so no caller byte is reinterpreted.
  const laneNativeId = parts.slice(2).join(":");
  if (!laneNativeId) return null;
  return { lane, laneNativeId };
}

export interface OsMissionIdentity {
  readonly osMissionId: string;
  /**
   * Monotonic count of durable transitions this OS mission has accumulated in
   * its lane's canonical journal. Derived, never stored: it exists so a caller
   * can detect that durable truth advanced between two reads.
   */
  readonly missionRevision: number;
  /**
   * The immutable payload digest the lane authority bound at submission.
   * `null` only for a legacy AutoPoster mission predating the execution
   * journal, where no digest was ever durably bound — reported as absent
   * rather than recomputed, because a recomputed digest would not be the
   * value any approval was actually bound to.
   */
  readonly payloadHash: string | null;
  readonly traceId: string | null;
  readonly product: string;
  readonly action: string;
  readonly lane: OsMissionLane;
  readonly workspaceId: string | null;
  readonly actorId: string;
  /** The exact committed repository revision the persisted approval binds to. */
  readonly authorityRevision: string | null;
  readonly runtimeExecutionId: string | null;
  readonly downstreamIdentity: OsDownstreamIdentity | null;
}

// ---------------------------------------------------------------------------
// Canonical authority
// ---------------------------------------------------------------------------

export interface OsMissionAuthority {
  /** Every registered lane requires human approval before bounded execution. */
  readonly required: true;
  /** True when a persisted approval checkpoint authority is wired at all. */
  readonly configured: boolean;
  /** True when Operator can both sign an approval and have it be verifiable. */
  readonly trusted: boolean;
  readonly approved: boolean;
  readonly approvedBy: string | null;
  readonly approvalId: string | null;
  readonly authorityRevision: string | null;
  readonly repositoryBinding: string | null;
  readonly expiresAt: string | null;
  /** The typed reason authority is absent or refused; `null` when it holds. */
  readonly refusalCode: string | null;
}

// ---------------------------------------------------------------------------
// Canonical evidence and outcome
// ---------------------------------------------------------------------------

/**
 * The lane-typed downstream identity an execution produced.
 *
 * Discriminated so a caller reads real, lane-shaped identities instead of a
 * lowest-common-denominator string, while `kind` keeps the union total.
 */
export type OsDownstreamIdentity =
  | {
    readonly kind: "loop_governor_manual_loop";
    readonly taskId: string;
    readonly loopId: string;
    readonly created: boolean;
  }
  | {
    readonly kind: "autoposter_unapproved_draft";
    readonly jobIds: readonly string[];
    readonly campaignId: string | null;
    readonly approvalId: string | null;
    readonly evidenceBundleId: string | null;
    /** Publication stays human-gated; the OS view states it, never infers it. */
    readonly publicationApprovalState: "human_required";
  };

export type OsEvidenceStatus =
  | "pending"
  | "authoritative"
  | "failed"
  | "reconciliation_required";

/**
 * The canonical replay outcome, taken from the Runtime's own idempotency
 * decision rather than from an Operator-side guess.
 */
export type OsReplayOutcome =
  | "not_observed"
  | "not_applicable"
  | "first_execution"
  | "duplicate"
  | "mismatch";

export function osReplayOutcome(value: unknown): OsReplayOutcome {
  return value === "not_applicable"
    || value === "first_execution"
    || value === "duplicate"
    || value === "mismatch"
    ? value
    : "not_observed";
}

/** The OS-level control actions a mission may currently accept. */
export const OS_MISSION_ACTIONS = ["approve", "reconcile", "resume", "stop"] as const;

export type OsMissionAction = (typeof OS_MISSION_ACTIONS)[number];

export interface OsMissionTypedError {
  readonly code: string;
  readonly message: string;
}

export interface OsMissionOutcome {
  readonly status: OsMissionState;
  readonly evidenceStatus: OsEvidenceStatus;
  readonly evidenceReference: string | null;
  /**
   * The Runtime's non-authoritative Real AI Value observation, when one was
   * attached to the mission result. Reported exactly as observed — `null` means
   * no adapter produced one, and is never substituted with a computed value.
   */
  readonly valueObservation: unknown | null;
  readonly downstreamIdentity: OsDownstreamIdentity | null;
  readonly replayOutcome: OsReplayOutcome;
  readonly recoveryClassification: string | null;
  readonly lastConfirmedBoundary: OsMissionState | null;
  /**
   * The control actions that can still advance this mission — advisory
   * guidance for an operator, not an enforcement gate. Each lane authority
   * remains the only decider of whether an action is accepted, so a terminal
   * mission lists nothing here while an idempotent replay of its final action
   * still returns durable truth unchanged.
   */
  readonly nextPermittedActions: readonly OsMissionAction[];
  readonly typedError: OsMissionTypedError | null;
}

// ---------------------------------------------------------------------------
// The unified mission view
// ---------------------------------------------------------------------------

export interface OsMissionView {
  readonly schemaVersion: typeof OS_MISSION_VIEW_SCHEMA_VERSION;
  /** True when this response returned existing durable truth unchanged. */
  readonly replayed: boolean;
  readonly identity: OsMissionIdentity;
  readonly lane: OsMissionLane;
  readonly laneCapability: {
    readonly approvalRequirement: OsApprovalRequirement;
    readonly executionScope: string;
    readonly downstreamOperationType: string;
    readonly realExternalExecutionAllowed: boolean;
    readonly reconciliationMode: OsReconciliationMode;
    readonly sourceOfTruth: string;
  };
  readonly status: OsMissionState;
  /** The lane authority's own state string, preserved verbatim. */
  readonly laneState: string;
  readonly authority: OsMissionAuthority;
  readonly outcome: OsMissionOutcome;
  /** Stable pointer back to the lane-native canonical record. */
  readonly laneReference: {
    readonly laneNativeId: string;
    readonly missionId: string | null;
    readonly commandId: string | null;
    readonly graphId: string | null;
    readonly graphHash: string | null;
  };
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export const OS_MISSION_VIEW_SCHEMA_VERSION = "chanter.os.mission.view.v1" as const;

export interface OsMissionListQuery {
  readonly lane?: unknown;
  readonly product?: unknown;
  readonly action?: unknown;
  readonly status?: unknown;
  readonly workspaceId?: unknown;
  readonly approvalState?: unknown;
  readonly from?: unknown;
  readonly to?: unknown;
  readonly limit?: unknown;
}

export type OsApprovalStateFilter = "required" | "approved";
