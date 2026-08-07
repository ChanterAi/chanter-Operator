/**
 * CHANTER OS — operational exception contract (`chanter.operational-exception.v1`).
 *
 * The typed vocabulary for governing one operational exception from observed
 * state to independently verified resolution. Pure declarations and total
 * functions: no database, no HTTP, no connector, no clock of its own.
 *
 * ## Why these five shapes are distinct
 *
 * It would be shorter to carry one blob describing "the problem and the fix".
 * Each separation below exists because something must be able to fail closed
 * against exactly that boundary:
 *
 *   - **ObservedState** is what a source system *was*, at a stated revision. It
 *     is re-derivable from the source, so a second observation either reproduces
 *     the hash or proves the world moved — which is the only way "stale
 *     observation" becomes detectable rather than assumed away.
 *   - **DesiredState** is the exact acceptable terminal condition, written
 *     before anything is attempted. Deriving it afterwards from whatever
 *     happened would make verification a tautology.
 *   - **StateDelta** is the difference, bounded to exact fields. It is what a
 *     human actually reviews, and what an approval binds to.
 *   - **ActionContract** is the one write, fully specified: target, capability,
 *     expected pre-state, payload bytes, idempotency key, deadline. Approval
 *     binds to *this*, so approving a fix for one invoice cannot authorize the
 *     same fix on another.
 *   - **TerminalOutcome** is the mission's answer, and only a verification
 *     oracle can produce the `completed_verified` form of it.
 *
 * ## Everything here is content-addressed, and the chain is deliberate
 *
 *     observationHash ─┐
 *                      ├─> deltaHash ─> actionContractHash ─> approval
 *     desiredStateHash ┘
 *
 * Each hash covers the ones before it, so a changed observation changes the
 * delta, which changes the action contract, which invalidates the approval. That
 * is one mechanism, not four checks that could be individually forgotten.
 */
import type { JsonValue } from "chanter-agent-runtime";
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { createHash } from "node:crypto";

export const OPERATIONAL_EXCEPTION_SCHEMA_VERSION = "chanter.operational-exception.v1" as const;

const OBSERVED_STATE_HASH_DOMAIN = "chanter.operational-exception.observed-state.v1";
const DESIRED_STATE_HASH_DOMAIN = "chanter.operational-exception.desired-state.v1";
const STATE_DELTA_HASH_DOMAIN = "chanter.operational-exception.state-delta.v1";
const ACTION_CONTRACT_HASH_DOMAIN = "chanter.operational-exception.action-contract.v1";
const WRITE_PAYLOAD_HASH_DOMAIN = "chanter.operational-exception.write-payload.v1";

function digest(domain: string, payload: string): string {
  return createHash("sha256").update(domain).update(" ").update(payload).digest("hex");
}

/**
 * The value types one bounded field may hold.
 *
 * Deliberately narrow. An operational field that could be an arbitrary nested
 * object would make "the delta is bounded to exact fields" unenforceable, and
 * would make a human-reviewable diff impossible to render honestly.
 */
export type ExceptionFieldValue = string | number | boolean | null;

export interface ExceptionField {
  readonly field: string;
  readonly value: ExceptionFieldValue;
}

// ---------------------------------------------------------------------------
// ObservedState
// ---------------------------------------------------------------------------

/**
 * What a source system held, when it was read, and how to check that again.
 *
 * `sourceRevision` is the connector's own version marker for the record. It is
 * carried separately from `observationHash` because they answer different
 * questions: the revision is the source's claim about its own version, and the
 * hash is this fabric's independent digest of the fields it actually saw. A
 * source that silently changed a field without bumping its revision is caught by
 * the second even though the first would say nothing happened.
 */
export interface ObservedState {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly sourceSystemId: string;
  readonly targetId: string;
  readonly sourceRevision: string;
  readonly observedFields: readonly ExceptionField[];
  readonly observationTime: string;
  readonly observationHash: string;
}

/**
 * Hashes only what the source actually said.
 *
 * Two exclusions, each for its own reason:
 *
 *   - **`observationTime`**, because two reads of an unchanged record must
 *     produce the same hash or "has the world moved?" could never be answered by
 *     comparison. The time is evidence about the read, not about the state.
 *   - **`missionId`**, because this is the identity of *a record*, not of one
 *     mission's opinion about it. The connector derives the same hash over its
 *     own state to enforce the pre-state check at write time, and it has no
 *     mission to include — a mission-scoped hash could never match, which is
 *     exactly the defect this exclusion fixes. `missionId` still binds the
 *     surrounding `ObservedState`, so §6's requirement is met by the record
 *     rather than by the digest.
 */
export function createObservationHash(
  input: Pick<ObservedState, "sourceSystemId" | "targetId" | "sourceRevision" | "observedFields">,
): string {
  return digest(OBSERVED_STATE_HASH_DOMAIN, canonicalizeAgenticJson({
    sourceSystemId: input.sourceSystemId,
    targetId: input.targetId,
    sourceRevision: input.sourceRevision,
    observedFields: fieldsAsJson(input.observedFields),
  }));
}

// ---------------------------------------------------------------------------
// DesiredState
// ---------------------------------------------------------------------------

/**
 * A machine-checkable condition the terminal state must satisfy.
 *
 * `equals` is the only comparison this P0 needs, and adding operators that
 * nothing exercises would be contract surface with no proof behind it.
 */
export interface ExceptionAcceptanceConstraint {
  readonly constraintId: string;
  readonly field: string;
  readonly comparison: "equals";
  readonly value: ExceptionFieldValue;
  /** Human-readable statement of the same condition, for the approval screen. */
  readonly statement: string;
}

export interface DesiredState {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly targetId: string;
  readonly desiredFields: readonly ExceptionField[];
  readonly acceptanceConstraints: readonly ExceptionAcceptanceConstraint[];
  readonly desiredStateHash: string;
}

export function createDesiredStateHash(
  input: Pick<DesiredState, "missionId" | "targetId" | "desiredFields" | "acceptanceConstraints">,
): string {
  return digest(DESIRED_STATE_HASH_DOMAIN, canonicalizeAgenticJson({
    missionId: input.missionId,
    targetId: input.targetId,
    desiredFields: fieldsAsJson(input.desiredFields),
    acceptanceConstraints: [...input.acceptanceConstraints]
      .sort((left, right) => (left.constraintId < right.constraintId ? -1 : 1))
      .map((constraint): Record<string, JsonValue> => ({
        constraintId: constraint.constraintId,
        field: constraint.field,
        comparison: constraint.comparison,
        value: constraint.value,
        statement: constraint.statement,
      })),
  }));
}

// ---------------------------------------------------------------------------
// StateDelta
// ---------------------------------------------------------------------------

export interface ExceptionFieldChange {
  readonly field: string;
  readonly observedValue: ExceptionFieldValue;
  readonly desiredValue: ExceptionFieldValue;
}

export interface StateDelta {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly targetId: string;
  /** The exact observation this delta was computed from. */
  readonly observationHash: string;
  readonly desiredStateHash: string;
  readonly changes: readonly ExceptionFieldChange[];
  readonly deltaHash: string;
}

export function createStateDeltaHash(
  input: Pick<StateDelta, "missionId" | "targetId" | "observationHash" | "desiredStateHash" | "changes">,
): string {
  return digest(STATE_DELTA_HASH_DOMAIN, canonicalizeAgenticJson({
    missionId: input.missionId,
    targetId: input.targetId,
    observationHash: input.observationHash,
    desiredStateHash: input.desiredStateHash,
    changes: [...input.changes]
      .sort((left, right) => (left.field < right.field ? -1 : 1))
      .map((change): Record<string, JsonValue> => ({
        field: change.field,
        observedValue: change.observedValue,
        desiredValue: change.desiredValue,
      })),
  }));
}

/**
 * The exact difference between what was observed and what is wanted.
 *
 * Total and deterministic: same inputs, same delta, same hash, on any machine.
 * A field present in the desired state but absent from the observation is a
 * change from `null`, which is the honest reading — the source does not hold
 * that field, and the action will set it.
 */
export function computeStateDelta(observed: ObservedState, desired: DesiredState): StateDelta {
  const observedByField = new Map(observed.observedFields.map((entry) => [entry.field, entry.value]));
  const changes: ExceptionFieldChange[] = [];
  for (const target of [...desired.desiredFields].sort((left, right) => (left.field < right.field ? -1 : 1))) {
    const current = observedByField.has(target.field)
      ? (observedByField.get(target.field) as ExceptionFieldValue)
      : null;
    if (current === target.value) continue;
    changes.push({ field: target.field, observedValue: current, desiredValue: target.value });
  }
  const base = {
    missionId: observed.missionId,
    targetId: observed.targetId,
    observationHash: observed.observationHash,
    desiredStateHash: desired.desiredStateHash,
    changes,
  };
  return {
    schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
    ...base,
    deltaHash: createStateDeltaHash(base),
  };
}

// ---------------------------------------------------------------------------
// ActionContract
// ---------------------------------------------------------------------------

/**
 * The exact write, fully specified before a human sees it.
 *
 * `expectedPreStateHash` is what makes this contract safe to approve and then
 * apply later: the connector re-checks it at write time, so an action approved
 * against one state cannot be applied to a different one. Together with
 * `idempotencyKey` — derived from the contract, not generated — a replayed or
 * restarted apply is recognized by the connector as the same action rather than
 * performed twice.
 */
export interface ActionContract {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly connectorId: string;
  readonly capability: string;
  readonly targetId: string;
  readonly expectedPreStateHash: string;
  readonly stateDeltaHash: string;
  readonly writePayload: readonly ExceptionField[];
  readonly writePayloadHash: string;
  readonly idempotencyKey: string;
  readonly deadline: string;
  readonly actionContractHash: string;
}

export function createWritePayloadHash(
  connectorId: string,
  targetId: string,
  payload: readonly ExceptionField[],
): string {
  return digest(WRITE_PAYLOAD_HASH_DOMAIN, canonicalizeAgenticJson({
    connectorId,
    targetId,
    payload: fieldsAsJson(payload),
  }));
}

export function createActionContractHash(
  input: Omit<ActionContract, "schemaVersion" | "actionContractHash">,
): string {
  return digest(ACTION_CONTRACT_HASH_DOMAIN, canonicalizeAgenticJson({
    missionId: input.missionId,
    connectorId: input.connectorId,
    capability: input.capability,
    targetId: input.targetId,
    expectedPreStateHash: input.expectedPreStateHash,
    stateDeltaHash: input.stateDeltaHash,
    writePayload: fieldsAsJson(input.writePayload),
    writePayloadHash: input.writePayloadHash,
    idempotencyKey: input.idempotencyKey,
    deadline: input.deadline,
  }));
}

/**
 * Compiles the one action that resolves this delta.
 *
 * The idempotency key is **derived**, never generated: a restarted process
 * recompiling the same contract must produce the same key, or the connector
 * would see a second action rather than a repeat of the first. Deriving it from
 * the delta and payload hashes also means a changed delta is a *different*
 * action rather than a retry of the old one.
 */
export function compileActionContract(input: {
  readonly missionId: string;
  readonly connectorId: string;
  readonly capability: string;
  readonly targetId: string;
  readonly expectedPreStateHash: string;
  readonly delta: StateDelta;
  readonly deadline: string;
}): ActionContract {
  const writePayload: ExceptionField[] = input.delta.changes.map((change) => ({
    field: change.field,
    value: change.desiredValue,
  }));
  const writePayloadHash = createWritePayloadHash(input.connectorId, input.targetId, writePayload);
  const idempotencyKey = `${input.missionId}:${input.delta.deltaHash.slice(0, 32)}:${writePayloadHash.slice(0, 32)}`;
  const base = {
    missionId: input.missionId,
    connectorId: input.connectorId,
    capability: input.capability,
    targetId: input.targetId,
    expectedPreStateHash: input.expectedPreStateHash,
    stateDeltaHash: input.delta.deltaHash,
    writePayload,
    writePayloadHash,
    idempotencyKey,
    deadline: input.deadline,
  };
  return {
    schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
    ...base,
    actionContractHash: createActionContractHash(base),
  };
}

/**
 * The exact bytes a human approves.
 *
 * This is the candidate. The fabric's existing approval authority binds a
 * decision to a candidate hash, refuses a mismatched one, expires it, and pins
 * it to a committed authority revision — all of which this reuses rather than
 * reimplementing. Rendering the contract as stable canonical JSON means the
 * bytes shown, the bytes hashed, and the bytes checked at write time are the
 * same bytes.
 */
export function renderActionContractCandidate(contract: ActionContract): string {
  return `${canonicalizeAgenticJson({
    schemaVersion: contract.schemaVersion,
    missionId: contract.missionId,
    connectorId: contract.connectorId,
    capability: contract.capability,
    targetId: contract.targetId,
    expectedPreStateHash: contract.expectedPreStateHash,
    stateDeltaHash: contract.stateDeltaHash,
    writePayload: fieldsAsJson(contract.writePayload),
    writePayloadHash: contract.writePayloadHash,
    idempotencyKey: contract.idempotencyKey,
    deadline: contract.deadline,
    actionContractHash: contract.actionContractHash,
  })}\n`;
}

// ---------------------------------------------------------------------------
// TerminalOutcome
// ---------------------------------------------------------------------------

export const OPERATIONAL_EXCEPTION_TERMINAL_STATES = [
  "completed_verified",
  "blocked",
  "failed",
  "unknown_requires_human",
] as const;

export type OperationalExceptionTerminalState =
  (typeof OPERATIONAL_EXCEPTION_TERMINAL_STATES)[number];

/**
 * The mission's answer, projected from durable plan truth.
 *
 * A projection rather than a second state machine, deliberately: the fabric
 * already owns one reviewed lifecycle with one set of legal transitions, and a
 * parallel terminal-state store would be a second authority over the same fact.
 * `completed_verified` is unreachable except through a passing oracle, because
 * the plan itself cannot reach `completed` without one.
 */
export interface TerminalOutcome {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly state: OperationalExceptionTerminalState;
  readonly verified: boolean;
  readonly reason: string;
  /** The oracle's own evidence reference, when one exists. */
  readonly verificationReference: string | null;
}

// ---------------------------------------------------------------------------
// Value observation
// ---------------------------------------------------------------------------

/**
 * Bounded operational measures, every one of them counted from durable rows.
 *
 * There is deliberately no monetary or ROI field. This fixture is an
 * architecture proof, and a commercial number derived from it would be invented
 * rather than measured.
 */
export interface ExceptionValueObservation {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly missionId: string;
  readonly exceptionDetected: number;
  readonly stateChangingActions: number;
  readonly duplicateActions: number;
  readonly humanApprovals: number;
  readonly reconciliationCount: number;
  readonly verificationCount: number;
  readonly timeToVerifiedResolutionMs: number | null;
  /** Provider spend for this mission, in micros. `0` when nothing was billed. */
  readonly providerCostMicros: number;
  readonly providerCalls: number;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Field order must never affect a hash, so every hashing path sorts first.
 * Two observations of the same record that differ only in key order are the
 * same observation, and must digest identically.
 */
function sortFields(fields: readonly ExceptionField[]): ExceptionField[] {
  return [...fields]
    .sort((left, right) => (left.field < right.field ? -1 : 1))
    .map((entry) => ({ field: entry.field, value: entry.value }));
}

/**
 * The same sorted fields, as plain JSON for the canonical hasher.
 *
 * A projection rather than a cast: the contract's interfaces are readonly and
 * carry no index signature, and widening them to satisfy a serializer would let
 * arbitrary keys into a shape whose whole purpose is being bounded.
 */
function fieldsAsJson(fields: readonly ExceptionField[]): JsonValue {
  return sortFields(fields).map(
    (entry): Record<string, JsonValue> => ({ field: entry.field, value: entry.value }),
  );
}

export function exceptionFieldsFrom(
  record: Readonly<Record<string, ExceptionFieldValue>>,
): ExceptionField[] {
  return sortFields(Object.entries(record).map(([field, value]) => ({ field, value })));
}

/** Whether every acceptance constraint holds against these fields. */
export function evaluateAcceptanceConstraints(
  fields: readonly ExceptionField[],
  constraints: readonly ExceptionAcceptanceConstraint[],
): { readonly satisfied: boolean; readonly unsatisfied: readonly string[] } {
  const byField = new Map(fields.map((entry) => [entry.field, entry.value]));
  const unsatisfied = constraints
    .filter((constraint) => {
      const actual = byField.has(constraint.field)
        ? (byField.get(constraint.field) as ExceptionFieldValue)
        : null;
      return actual !== constraint.value;
    })
    .map((constraint) => constraint.constraintId);
  return { satisfied: unsatisfied.length === 0, unsatisfied };
}
