import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";

export const SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA =
  "chanter.operator.safecommit-closeout.v1" as const;
export const SAFECOMMIT_CLOSEOUT_ACTION = "safecommit.closeout.execute" as const;
export const SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA =
  "chanter.safecommit.closeout.v1" as const;
export const SAFECOMMIT_APPROVAL_BASIS =
  "founder_reviewed_exact_plan_and_repository_preflight" as const;
export const SAFECOMMIT_APPROVAL_EVIDENCE_SCHEMA =
  "chanter.operator.safecommit-closeout-approval-evidence.v1" as const;

export const SafeCommitCloseoutStates = [
  "approval_required",
  "approved",
  "execution_claimed",
  "completed",
  "failed_terminal",
  "invalidated",
  "revoked",
] as const;
export type SafeCommitCloseoutState = (typeof SafeCommitCloseoutStates)[number];

export const SafeCommitInvalidationReasonCodes = [
  "plan_mutated",
  "worktree_mutated",
  "repository_truth_changed",
  "remote_truth_changed",
] as const;
export type SafeCommitInvalidationReasonCode =
  (typeof SafeCommitInvalidationReasonCodes)[number];

export type SafeCommitCloseoutOutcome = "completed" | "failed_terminal";

interface CloseoutRow {
  request_id: string;
  idempotency_key: string;
  schema_version: typeof SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA;
  action: typeof SAFECOMMIT_CLOSEOUT_ACTION;
  plan_id: string;
  plan_schema_version: typeof SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA;
  plan_hash: string;
  requested_by: string;
  requested_at: string;
  status: SafeCommitCloseoutState;
  approved_by: string | null;
  approval_basis: typeof SAFECOMMIT_APPROVAL_BASIS | null;
  approval_note: string | null;
  approved_at: string | null;
  approved_plan_hash: string | null;
  approval_evidence_id: string | null;
  approval_evidence_digest: string | null;
  claimed_by: string | null;
  claimed_at: string | null;
  terminal_actor: string | null;
  terminal_reason_code: string | null;
  terminal_reason: string | null;
  terminal_at: string | null;
  terminal_evidence_ref: string | null;
  terminal_evidence_digest: string | null;
  closeout_evidence_ref: string | null;
  closeout_evidence_digest: string | null;
  closeout_outcome: SafeCommitCloseoutOutcome | null;
  created_at: string;
  updated_at: string;
}

interface CloseoutEventRow {
  event_id: string;
  request_id: string;
  sequence: number;
  event_type: string;
  previous_state: SafeCommitCloseoutState | null;
  new_state: SafeCommitCloseoutState;
  actor: string;
  reason_code: string;
  reason: string;
  timestamp: string;
  evidence_ref: string | null;
  evidence_digest: string | null;
}

export interface SafeCommitApprovalEvidence {
  schemaVersion: typeof SAFECOMMIT_APPROVAL_EVIDENCE_SCHEMA;
  evidenceId: string;
  requestId: string;
  action: typeof SAFECOMMIT_CLOSEOUT_ACTION;
  planId: string;
  planHash: string;
  approvedBy: string;
  approvalBasis: typeof SAFECOMMIT_APPROVAL_BASIS;
  approvalNote: string | null;
  approvedAt: string;
  digest: string;
}

export interface SafeCommitCloseoutEvent {
  eventId: string;
  sequence: number;
  eventType: string;
  previousState: SafeCommitCloseoutState | null;
  newState: SafeCommitCloseoutState;
  actor: string;
  reasonCode: string;
  reason: string;
  timestamp: string;
  evidenceRef: string | null;
  evidenceDigest: string | null;
}

export interface SafeCommitCloseoutView {
  replayed: boolean;
  schemaVersion: typeof SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA;
  action: typeof SAFECOMMIT_CLOSEOUT_ACTION;
  requestId: string;
  idempotencyKey: string;
  planId: string;
  planSchemaVersion: typeof SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA;
  planHash: string;
  requestedBy: string;
  requestedAt: string;
  status: SafeCommitCloseoutState;
  approvalRequired: true;
  approvalEvidence: SafeCommitApprovalEvidence | null;
  claim: { claimedBy: string; claimedAt: string } | null;
  terminal: {
    actor: string;
    reasonCode: string;
    reason: string;
    at: string;
    evidenceRef: string | null;
    evidenceDigest: string | null;
  } | null;
  closeoutEvidence: {
    reference: string;
    digest: string;
    outcome: SafeCommitCloseoutOutcome;
    recordedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  events: SafeCommitCloseoutEvent[];
}

interface ServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  protectedValues?: readonly string[];
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_ACTOR_LENGTH = 120;
const MAX_NOTE_LENGTH = 1_000;
const MAX_REASON_LENGTH = 1_000;
const MAX_EVIDENCE_REFERENCE_LENGTH = 500;

function record(value: unknown, scope: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new OperatorError(
      `${scope} must be a JSON object.`,
      400,
      "OPERATOR_SAFECOMMIT_REQUEST_INVALID",
    );
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new OperatorError(
      `Unsupported SafeCommit closeout field: ${JSON.stringify(unknown[0])}.`,
      400,
      "OPERATOR_SAFECOMMIT_FIELD_UNSUPPORTED",
    );
  }
  const missing = required.find((key) => !(key in value));
  if (missing) {
    throw new OperatorError(
      `Missing required SafeCommit closeout field: ${missing}.`,
      400,
      "OPERATOR_SAFECOMMIT_FIELD_REQUIRED",
    );
  }
}

function exactIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
    throw new OperatorError(
      `${field} must be a bounded exact identifier.`,
      400,
      "OPERATOR_SAFECOMMIT_IDENTITY_INVALID",
    );
  }
  return value;
}

function exactText(value: unknown, field: string, maximum: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maximum
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new OperatorError(
      `${field} must be a trimmed nonblank string of at most ${maximum} characters.`,
      400,
      "OPERATOR_SAFECOMMIT_FIELD_INVALID",
    );
  }
  return value;
}

function optionalNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return exactText(value, "approvalNote", MAX_NOTE_LENGTH);
}

function exactHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) {
    throw new OperatorError(
      `${field} must be an exact lowercase 64-character SHA-256 digest.`,
      400,
      "OPERATOR_SAFECOMMIT_HASH_INVALID",
    );
  }
  return value;
}

function exactIsoTimestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string"
    || !value
    || Number.isNaN(Date.parse(value))
    || new Date(value).toISOString() !== value
  ) {
    throw new OperatorError(
      `${field} must be a canonical UTC ISO-8601 timestamp.`,
      400,
      "OPERATOR_SAFECOMMIT_TIMESTAMP_INVALID",
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class SafeCommitCloseoutService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly protectedValues: string[];

  constructor(
    private readonly database: DatabaseSync,
    options: ServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  submit(value: unknown): SafeCommitCloseoutView {
    const input = record(value, "SafeCommit closeout request");
    assertExactKeys(input, [
      "schemaVersion",
      "action",
      "requestId",
      "idempotencyKey",
      "planId",
      "planSchemaVersion",
      "planHash",
      "requestedBy",
      "requestedAt",
    ]);
    if (input.schemaVersion !== SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA) {
      throw new OperatorError(
        `schemaVersion must be ${SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA}.`,
        400,
        "OPERATOR_SAFECOMMIT_SCHEMA_UNSUPPORTED",
      );
    }
    if (input.action !== SAFECOMMIT_CLOSEOUT_ACTION) {
      throw new OperatorError(
        `action must be ${SAFECOMMIT_CLOSEOUT_ACTION}.`,
        409,
        "OPERATOR_SAFECOMMIT_ACTION_UNREGISTERED",
      );
    }
    if (input.planSchemaVersion !== SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA) {
      throw new OperatorError(
        `planSchemaVersion must be ${SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA}.`,
        400,
        "OPERATOR_SAFECOMMIT_PLAN_SCHEMA_UNSUPPORTED",
      );
    }

    const canonical = {
      requestId: exactIdentifier(input.requestId, "requestId"),
      idempotencyKey: exactIdentifier(input.idempotencyKey, "idempotencyKey"),
      planId: exactIdentifier(input.planId, "planId"),
      planHash: exactHash(input.planHash, "planHash"),
      requestedBy: exactText(input.requestedBy, "requestedBy", MAX_ACTOR_LENGTH),
      requestedAt: exactIsoTimestamp(input.requestedAt, "requestedAt"),
    };
    this.assertContainsNoProtectedValue(Object.values(canonical));

    const existing = this.getRow(canonical.requestId);
    if (existing) {
      this.assertSubmitReplay(existing, canonical);
      return this.buildView(existing, true);
    }
    const conflicting = this.database.prepare(
      `SELECT * FROM operator_safecommit_closeouts
       WHERE idempotency_key = ? OR plan_id = ?
       LIMIT 1`,
    ).get(canonical.idempotencyKey, canonical.planId) as CloseoutRow | undefined;
    if (conflicting) {
      throw new OperatorError(
        "The SafeCommit idempotency key or plan id is already bound to another request.",
        409,
        "OPERATOR_SAFECOMMIT_IDENTITY_CONFLICT",
      );
    }

    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      this.database.prepare(
        `INSERT INTO operator_safecommit_closeouts (
          request_id, idempotency_key, schema_version, action, plan_id,
          plan_schema_version, plan_hash, requested_by, requested_at, status,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval_required', ?, ?)`,
      ).run(
        canonical.requestId,
        canonical.idempotencyKey,
        SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA,
        SAFECOMMIT_CLOSEOUT_ACTION,
        canonical.planId,
        SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA,
        canonical.planHash,
        canonical.requestedBy,
        canonical.requestedAt,
        timestamp,
        timestamp,
      );
      this.appendEvent({
        requestId: canonical.requestId,
        eventType: "closeout_approval_requested",
        previousState: null,
        newState: "approval_required",
        actor: canonical.requestedBy,
        reasonCode: "approval_required",
        reason: "SafeCommit submitted one exact external closeout plan hash for founder control approval.",
        timestamp,
        evidenceRef: `safecommit-plan:${canonical.planId}`,
        evidenceDigest: canonical.planHash,
      });
    });
    return this.buildView(this.requireRow(canonical.requestId));
  }

  get(requestId: string): SafeCommitCloseoutView {
    return this.buildView(this.requireRow(exactIdentifier(requestId, "requestId")));
  }

  approve(requestIdValue: string, value: unknown): SafeCommitCloseoutView {
    const requestId = exactIdentifier(requestIdValue, "requestId");
    const input = record(value, "SafeCommit closeout approval");
    assertExactKeys(
      input,
      ["planHash", "approvedBy", "approvalBasis"],
      ["approvalNote"],
    );
    const planHash = exactHash(input.planHash, "planHash");
    const approvedBy = exactText(input.approvedBy, "approvedBy", MAX_ACTOR_LENGTH);
    if (input.approvalBasis !== SAFECOMMIT_APPROVAL_BASIS) {
      throw new OperatorError(
        `approvalBasis must be ${SAFECOMMIT_APPROVAL_BASIS}.`,
        400,
        "OPERATOR_SAFECOMMIT_APPROVAL_BASIS_INVALID",
      );
    }
    const approvalNote = optionalNote(input.approvalNote);
    this.assertContainsNoProtectedValue([approvedBy, approvalNote ?? ""]);

    const current = this.requireRow(requestId);
    this.assertRowIntegrity(current);
    this.assertPlanHash(current, planHash);
    if (current.status !== "approval_required") {
      if (
        ["approved", "execution_claimed", "completed", "failed_terminal"].includes(current.status)
        && current.approved_by === approvedBy
        && current.approval_basis === SAFECOMMIT_APPROVAL_BASIS
        && current.approval_note === approvalNote
      ) {
        return this.buildView(current, true);
      }
      throw this.stateError(current.status, "approved");
    }

    const approvedAt = this.now().toISOString();
    const evidenceId = this.idFactory();
    const evidenceWithoutDigest = {
      schemaVersion: SAFECOMMIT_APPROVAL_EVIDENCE_SCHEMA,
      evidenceId,
      requestId,
      action: SAFECOMMIT_CLOSEOUT_ACTION,
      planId: current.plan_id,
      planHash,
      approvedBy,
      approvalBasis: SAFECOMMIT_APPROVAL_BASIS,
      approvalNote,
      approvedAt,
    };
    const evidenceDigest = sha256(canonicalJson(evidenceWithoutDigest));

    withTransaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE operator_safecommit_closeouts
         SET status = 'approved', approved_by = ?, approval_basis = ?,
             approval_note = ?, approved_at = ?, approved_plan_hash = ?,
             approval_evidence_id = ?, approval_evidence_digest = ?, updated_at = ?
         WHERE request_id = ? AND status = 'approval_required'`,
      ).run(
        approvedBy,
        SAFECOMMIT_APPROVAL_BASIS,
        approvalNote,
        approvedAt,
        planHash,
        evidenceId,
        evidenceDigest,
        approvedAt,
        requestId,
      );
      this.assertChanged(update, "Approval request changed before approval could be persisted.");
      this.appendEvent({
        eventId: evidenceId,
        requestId,
        eventType: "closeout_approved",
        previousState: "approval_required",
        newState: "approved",
        actor: approvedBy,
        reasonCode: SAFECOMMIT_APPROVAL_BASIS,
        reason: "Founder control approval was durably bound to the exact SafeCommit plan hash.",
        timestamp: approvedAt,
        evidenceRef: `operator-safecommit-approval:${evidenceId}`,
        evidenceDigest,
      });
    });
    return this.buildView(this.requireRow(requestId));
  }

  revoke(requestIdValue: string, value: unknown): SafeCommitCloseoutView {
    const requestId = exactIdentifier(requestIdValue, "requestId");
    const input = record(value, "SafeCommit closeout revocation");
    assertExactKeys(input, ["planHash", "revokedBy", "reason"]);
    const planHash = exactHash(input.planHash, "planHash");
    const revokedBy = exactText(input.revokedBy, "revokedBy", MAX_ACTOR_LENGTH);
    const reason = exactText(input.reason, "reason", MAX_REASON_LENGTH);
    this.assertContainsNoProtectedValue([revokedBy, reason]);

    const current = this.requireRow(requestId);
    this.assertRowIntegrity(current);
    this.assertPlanHash(current, planHash);
    if (current.status === "revoked") {
      if (
        current.terminal_actor === revokedBy
        && current.terminal_reason === reason
        && current.terminal_reason_code === "founder_revoked"
      ) {
        return this.buildView(current, true);
      }
      throw this.stateError(current.status, "revoked");
    }
    if (current.status !== "approval_required" && current.status !== "approved") {
      throw this.stateError(current.status, "revoked");
    }

    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE operator_safecommit_closeouts
         SET status = 'revoked', terminal_actor = ?,
             terminal_reason_code = 'founder_revoked', terminal_reason = ?,
             terminal_at = ?, updated_at = ?
         WHERE request_id = ? AND status = ?`,
      ).run(revokedBy, reason, timestamp, timestamp, requestId, current.status);
      this.assertChanged(update, "Approval request changed before revocation could be persisted.");
      this.appendEvent({
        requestId,
        eventType: "closeout_revoked",
        previousState: current.status,
        newState: "revoked",
        actor: revokedBy,
        reasonCode: "founder_revoked",
        reason,
        timestamp,
      });
    });
    return this.buildView(this.requireRow(requestId));
  }

  claim(requestIdValue: string, value: unknown): SafeCommitCloseoutView {
    const requestId = exactIdentifier(requestIdValue, "requestId");
    const input = record(value, "SafeCommit closeout execution claim");
    assertExactKeys(input, [
      "planHash",
      "claimedBy",
      "approvalEvidenceId",
      "approvalEvidenceDigest",
    ]);
    const planHash = exactHash(input.planHash, "planHash");
    const claimedBy = exactText(input.claimedBy, "claimedBy", MAX_ACTOR_LENGTH);
    const approvalEvidenceId = exactIdentifier(
      input.approvalEvidenceId,
      "approvalEvidenceId",
    );
    const approvalEvidenceDigest = exactHash(
      input.approvalEvidenceDigest,
      "approvalEvidenceDigest",
    );
    this.assertContainsNoProtectedValue([claimedBy]);

    const current = this.requireRow(requestId);
    this.assertRowIntegrity(current);
    this.assertPlanHash(current, planHash);
    this.assertApprovalEvidence(current, approvalEvidenceId, approvalEvidenceDigest);
    if (current.status !== "approved") {
      if (
        ["execution_claimed", "completed", "failed_terminal"].includes(current.status)
        && current.claimed_by === claimedBy
      ) {
        return this.buildView(current, true);
      }
      throw this.stateError(current.status, "execution_claimed");
    }

    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE operator_safecommit_closeouts
         SET status = 'execution_claimed', claimed_by = ?, claimed_at = ?, updated_at = ?
         WHERE request_id = ? AND status = 'approved'`,
      ).run(claimedBy, timestamp, timestamp, requestId);
      this.assertChanged(update, "Approval changed before execution could be claimed.");
      this.appendEvent({
        requestId,
        eventType: "closeout_execution_claimed",
        previousState: "approved",
        newState: "execution_claimed",
        actor: claimedBy,
        reasonCode: "approved_plan_claimed",
        reason: "SafeCommit atomically claimed the exact approved plan for one governed execution.",
        timestamp,
        evidenceRef: `operator-safecommit-approval:${approvalEvidenceId}`,
        evidenceDigest: approvalEvidenceDigest,
      });
    });
    return this.buildView(this.requireRow(requestId));
  }

  invalidate(requestIdValue: string, value: unknown): SafeCommitCloseoutView {
    const requestId = exactIdentifier(requestIdValue, "requestId");
    const input = record(value, "SafeCommit closeout invalidation");
    assertExactKeys(input, [
      "planHash",
      "invalidatedBy",
      "approvalEvidenceId",
      "approvalEvidenceDigest",
      "reasonCode",
      "evidenceRef",
      "evidenceDigest",
    ]);
    const planHash = exactHash(input.planHash, "planHash");
    const invalidatedBy = exactText(
      input.invalidatedBy,
      "invalidatedBy",
      MAX_ACTOR_LENGTH,
    );
    const approvalEvidenceId = exactIdentifier(
      input.approvalEvidenceId,
      "approvalEvidenceId",
    );
    const approvalEvidenceDigest = exactHash(
      input.approvalEvidenceDigest,
      "approvalEvidenceDigest",
    );
    if (
      typeof input.reasonCode !== "string"
      || !SafeCommitInvalidationReasonCodes.includes(
        input.reasonCode as SafeCommitInvalidationReasonCode,
      )
    ) {
      throw new OperatorError(
        "reasonCode is not a registered SafeCommit invalidation reason.",
        400,
        "OPERATOR_SAFECOMMIT_INVALIDATION_REASON_UNREGISTERED",
      );
    }
    const reasonCode = input.reasonCode as SafeCommitInvalidationReasonCode;
    const evidenceRef = exactText(
      input.evidenceRef,
      "evidenceRef",
      MAX_EVIDENCE_REFERENCE_LENGTH,
    );
    const evidenceDigest = exactHash(input.evidenceDigest, "evidenceDigest");
    this.assertContainsNoProtectedValue([invalidatedBy, evidenceRef]);

    const current = this.requireRow(requestId);
    this.assertRowIntegrity(current);
    this.assertPlanHash(current, planHash);
    this.assertApprovalEvidence(current, approvalEvidenceId, approvalEvidenceDigest);
    if (current.status === "invalidated") {
      if (
        current.terminal_actor === invalidatedBy
        && current.terminal_reason_code === reasonCode
        && current.terminal_evidence_ref === evidenceRef
        && current.terminal_evidence_digest === evidenceDigest
      ) {
        return this.buildView(current, true);
      }
      throw this.stateError(current.status, "invalidated");
    }
    if (current.status !== "approved" && current.status !== "execution_claimed") {
      throw this.stateError(current.status, "invalidated");
    }
    if (current.claimed_by && current.claimed_by !== invalidatedBy) {
      throw new OperatorError(
        "Only the executor holding the durable claim may invalidate it.",
        409,
        "OPERATOR_SAFECOMMIT_EXECUTOR_BINDING_MISMATCH",
      );
    }

    const timestamp = this.now().toISOString();
    const reason =
      "SafeCommit reported that current repository truth no longer matches the approved plan.";
    withTransaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE operator_safecommit_closeouts
         SET status = 'invalidated', terminal_actor = ?, terminal_reason_code = ?,
             terminal_reason = ?, terminal_at = ?, terminal_evidence_ref = ?,
             terminal_evidence_digest = ?, updated_at = ?
         WHERE request_id = ? AND status = ?`,
      ).run(
        invalidatedBy,
        reasonCode,
        reason,
        timestamp,
        evidenceRef,
        evidenceDigest,
        timestamp,
        requestId,
        current.status,
      );
      this.assertChanged(update, "Approval changed before invalidation could be persisted.");
      this.appendEvent({
        requestId,
        eventType: "closeout_invalidated",
        previousState: current.status,
        newState: "invalidated",
        actor: invalidatedBy,
        reasonCode,
        reason,
        timestamp,
        evidenceRef,
        evidenceDigest,
      });
    });
    return this.buildView(this.requireRow(requestId));
  }

  complete(requestIdValue: string, value: unknown): SafeCommitCloseoutView {
    const requestId = exactIdentifier(requestIdValue, "requestId");
    const input = record(value, "SafeCommit closeout completion");
    assertExactKeys(input, [
      "planHash",
      "completedBy",
      "approvalEvidenceId",
      "approvalEvidenceDigest",
      "outcome",
      "evidenceRef",
      "evidenceDigest",
    ]);
    const planHash = exactHash(input.planHash, "planHash");
    const completedBy = exactText(input.completedBy, "completedBy", MAX_ACTOR_LENGTH);
    const approvalEvidenceId = exactIdentifier(
      input.approvalEvidenceId,
      "approvalEvidenceId",
    );
    const approvalEvidenceDigest = exactHash(
      input.approvalEvidenceDigest,
      "approvalEvidenceDigest",
    );
    if (input.outcome !== "completed" && input.outcome !== "failed_terminal") {
      throw new OperatorError(
        "outcome must be completed or failed_terminal.",
        400,
        "OPERATOR_SAFECOMMIT_OUTCOME_INVALID",
      );
    }
    const outcome = input.outcome;
    const evidenceRef = exactText(
      input.evidenceRef,
      "evidenceRef",
      MAX_EVIDENCE_REFERENCE_LENGTH,
    );
    const evidenceDigest = exactHash(input.evidenceDigest, "evidenceDigest");
    this.assertContainsNoProtectedValue([completedBy, evidenceRef]);

    const current = this.requireRow(requestId);
    this.assertRowIntegrity(current);
    this.assertPlanHash(current, planHash);
    this.assertApprovalEvidence(current, approvalEvidenceId, approvalEvidenceDigest);
    if (current.status === "completed" || current.status === "failed_terminal") {
      if (
        current.status === outcome
        && current.terminal_actor === completedBy
        && current.closeout_evidence_ref === evidenceRef
        && current.closeout_evidence_digest === evidenceDigest
      ) {
        return this.buildView(current, true);
      }
      throw this.stateError(current.status, outcome);
    }
    if (current.status !== "execution_claimed") {
      throw this.stateError(current.status, outcome);
    }
    if (current.claimed_by !== completedBy) {
      throw new OperatorError(
        "Only the executor holding the durable claim may complete it.",
        409,
        "OPERATOR_SAFECOMMIT_EXECUTOR_BINDING_MISMATCH",
      );
    }

    const timestamp = this.now().toISOString();
    const reasonCode =
      outcome === "completed" ? "closeout_completed" : "closeout_failed_terminal";
    const reason =
      outcome === "completed"
        ? "SafeCommit returned durable evidence for the completed closeout."
        : "SafeCommit returned durable evidence for a terminal closeout failure.";
    withTransaction(this.database, () => {
      const update = this.database.prepare(
        `UPDATE operator_safecommit_closeouts
         SET status = ?, terminal_actor = ?, terminal_reason_code = ?,
             terminal_reason = ?, terminal_at = ?, closeout_evidence_ref = ?,
             closeout_evidence_digest = ?, closeout_outcome = ?, updated_at = ?
         WHERE request_id = ? AND status = 'execution_claimed'`,
      ).run(
        outcome,
        completedBy,
        reasonCode,
        reason,
        timestamp,
        evidenceRef,
        evidenceDigest,
        outcome,
        timestamp,
        requestId,
      );
      this.assertChanged(update, "Execution claim changed before completion could be persisted.");
      this.appendEvent({
        requestId,
        eventType: outcome === "completed"
          ? "closeout_completed"
          : "closeout_failed_terminal",
        previousState: "execution_claimed",
        newState: outcome,
        actor: completedBy,
        reasonCode,
        reason,
        timestamp,
        evidenceRef,
        evidenceDigest,
      });
    });
    return this.buildView(this.requireRow(requestId));
  }

  private getRow(requestId: string): CloseoutRow | null {
    const row = this.database.prepare(
      "SELECT * FROM operator_safecommit_closeouts WHERE request_id = ?",
    ).get(requestId) as CloseoutRow | undefined;
    return row ?? null;
  }

  private requireRow(requestId: string): CloseoutRow {
    const row = this.getRow(requestId);
    if (!row) {
      throw new OperatorError(
        "SafeCommit closeout approval request was not found.",
        404,
        "OPERATOR_SAFECOMMIT_REQUEST_NOT_FOUND",
      );
    }
    this.assertRowIntegrity(row);
    return row;
  }

  private listEvents(requestId: string): SafeCommitCloseoutEvent[] {
    return this.database.prepare(
      `SELECT * FROM operator_safecommit_closeout_events
       WHERE request_id = ? ORDER BY sequence ASC`,
    ).all(requestId).map((value) => {
      const row = value as unknown as CloseoutEventRow;
      return {
        eventId: row.event_id,
        sequence: Number(row.sequence),
        eventType: row.event_type,
        previousState: row.previous_state,
        newState: row.new_state,
        actor: row.actor,
        reasonCode: row.reason_code,
        reason: row.reason,
        timestamp: row.timestamp,
        evidenceRef: row.evidence_ref,
        evidenceDigest: row.evidence_digest,
      };
    });
  }

  private appendEvent(input: {
    eventId?: string;
    requestId: string;
    eventType: string;
    previousState: SafeCommitCloseoutState | null;
    newState: SafeCommitCloseoutState;
    actor: string;
    reasonCode: string;
    reason: string;
    timestamp: string;
    evidenceRef?: string | null;
    evidenceDigest?: string | null;
  }): void {
    const sequence = this.database.prepare(
      `SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
       FROM operator_safecommit_closeout_events WHERE request_id = ?`,
    ).get(input.requestId) as { next_sequence: number };
    this.database.prepare(
      `INSERT INTO operator_safecommit_closeout_events (
        event_id, request_id, sequence, event_type, previous_state, new_state,
        actor, reason_code, reason, timestamp, evidence_ref, evidence_digest
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.eventId ?? this.idFactory(),
      input.requestId,
      Number(sequence.next_sequence),
      input.eventType,
      input.previousState,
      input.newState,
      input.actor,
      input.reasonCode,
      input.reason,
      input.timestamp,
      input.evidenceRef ?? null,
      input.evidenceDigest ?? null,
    );
  }

  private buildApprovalEvidence(row: CloseoutRow): SafeCommitApprovalEvidence | null {
    if (
      !row.approved_by
      || !row.approval_basis
      || !row.approved_at
      || !row.approved_plan_hash
      || !row.approval_evidence_id
      || !row.approval_evidence_digest
    ) {
      return null;
    }
    return {
      schemaVersion: SAFECOMMIT_APPROVAL_EVIDENCE_SCHEMA,
      evidenceId: row.approval_evidence_id,
      requestId: row.request_id,
      action: SAFECOMMIT_CLOSEOUT_ACTION,
      planId: row.plan_id,
      planHash: row.approved_plan_hash,
      approvedBy: row.approved_by,
      approvalBasis: row.approval_basis,
      approvalNote: row.approval_note,
      approvedAt: row.approved_at,
      digest: row.approval_evidence_digest,
    };
  }

  private buildView(row: CloseoutRow, replayed = false): SafeCommitCloseoutView {
    return {
      replayed,
      schemaVersion: SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA,
      action: SAFECOMMIT_CLOSEOUT_ACTION,
      requestId: row.request_id,
      idempotencyKey: row.idempotency_key,
      planId: row.plan_id,
      planSchemaVersion: SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA,
      planHash: row.plan_hash,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at,
      status: row.status,
      approvalRequired: true,
      approvalEvidence: this.buildApprovalEvidence(row),
      claim: row.claimed_by && row.claimed_at
        ? { claimedBy: row.claimed_by, claimedAt: row.claimed_at }
        : null,
      terminal:
        row.terminal_actor
        && row.terminal_reason_code
        && row.terminal_reason
        && row.terminal_at
          ? {
              actor: row.terminal_actor,
              reasonCode: row.terminal_reason_code,
              reason: row.terminal_reason,
              at: row.terminal_at,
              evidenceRef: row.terminal_evidence_ref,
              evidenceDigest: row.terminal_evidence_digest,
            }
          : null,
      closeoutEvidence:
        row.closeout_evidence_ref
        && row.closeout_evidence_digest
        && row.closeout_outcome
        && row.terminal_at
          ? {
              reference: row.closeout_evidence_ref,
              digest: row.closeout_evidence_digest,
              outcome: row.closeout_outcome,
              recordedAt: row.terminal_at,
            }
          : null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      events: this.listEvents(row.request_id),
    };
  }

  private assertSubmitReplay(
    row: CloseoutRow,
    input: {
      requestId: string;
      idempotencyKey: string;
      planId: string;
      planHash: string;
      requestedBy: string;
      requestedAt: string;
    },
  ): void {
    this.assertRowIntegrity(row);
    if (
      row.idempotency_key !== input.idempotencyKey
      || row.plan_id !== input.planId
      || row.plan_hash !== input.planHash
      || row.requested_by !== input.requestedBy
      || row.requested_at !== input.requestedAt
    ) {
      throw new OperatorError(
        "The request id is already bound to different immutable SafeCommit closeout input.",
        409,
        "OPERATOR_SAFECOMMIT_REQUEST_BINDING_MISMATCH",
      );
    }
  }

  private assertRowIntegrity(row: CloseoutRow): void {
    if (
      row.schema_version !== SAFECOMMIT_CLOSEOUT_REQUEST_SCHEMA
      || row.action !== SAFECOMMIT_CLOSEOUT_ACTION
      || row.plan_schema_version !== SAFECOMMIT_CLOSEOUT_PLAN_SCHEMA
      || !HASH_PATTERN.test(row.plan_hash)
      || !SafeCommitCloseoutStates.includes(row.status)
    ) {
      throw new OperatorError(
        "Durable SafeCommit closeout request integrity validation failed.",
        409,
        "OPERATOR_SAFECOMMIT_INTEGRITY_VIOLATION",
      );
    }
    if (row.approved_plan_hash !== null && row.approved_plan_hash !== row.plan_hash) {
      throw new OperatorError(
        "Durable SafeCommit approval no longer matches the immutable plan hash.",
        409,
        "OPERATOR_SAFECOMMIT_APPROVAL_INTEGRITY_VIOLATION",
      );
    }
    const evidence = this.buildApprovalEvidence(row);
    if (evidence) {
      const { digest: _digest, ...withoutDigest } = evidence;
      if (sha256(canonicalJson(withoutDigest)) !== evidence.digest) {
        throw new OperatorError(
          "Durable SafeCommit approval evidence digest validation failed.",
          409,
          "OPERATOR_SAFECOMMIT_APPROVAL_INTEGRITY_VIOLATION",
        );
      }
    } else if (row.status !== "approval_required" && row.status !== "revoked") {
      throw new OperatorError(
        "Durable SafeCommit approval evidence is incomplete.",
        409,
        "OPERATOR_SAFECOMMIT_APPROVAL_INTEGRITY_VIOLATION",
      );
    }
    const hasAnyApprovalField = [
      row.approved_by,
      row.approval_basis,
      row.approval_note,
      row.approved_at,
      row.approved_plan_hash,
      row.approval_evidence_id,
      row.approval_evidence_digest,
    ].some((value) => value !== null);
    if (hasAnyApprovalField && !evidence) {
      throw new OperatorError(
        "Durable SafeCommit approval fields are only partially populated.",
        409,
        "OPERATOR_SAFECOMMIT_APPROVAL_INTEGRITY_VIOLATION",
      );
    }
    if (row.status === "approval_required" && hasAnyApprovalField) {
      throw new OperatorError(
        "Approval-required SafeCommit lifecycle state contains approval evidence.",
        409,
        "OPERATOR_SAFECOMMIT_APPROVAL_INTEGRITY_VIOLATION",
      );
    }

    const hasCompleteClaim = Boolean(row.claimed_by && row.claimed_at);
    if (Boolean(row.claimed_by) !== Boolean(row.claimed_at)) {
      throw new OperatorError(
        "Durable SafeCommit execution claim is incomplete.",
        409,
        "OPERATOR_SAFECOMMIT_CLAIM_INTEGRITY_VIOLATION",
      );
    }
    if (
      ["execution_claimed", "completed", "failed_terminal"].includes(row.status)
      && !hasCompleteClaim
    ) {
      throw new OperatorError(
        "Durable SafeCommit lifecycle state is missing its execution claim.",
        409,
        "OPERATOR_SAFECOMMIT_CLAIM_INTEGRITY_VIOLATION",
      );
    }
    if (
      ["approval_required", "approved", "revoked"].includes(row.status)
      && hasCompleteClaim
    ) {
      throw new OperatorError(
        "Pre-execution SafeCommit lifecycle state contains an execution claim.",
        409,
        "OPERATOR_SAFECOMMIT_CLAIM_INTEGRITY_VIOLATION",
      );
    }

    const terminalFields = [
      row.terminal_actor,
      row.terminal_reason_code,
      row.terminal_reason,
      row.terminal_at,
    ];
    const isTerminal = ["completed", "failed_terminal", "invalidated", "revoked"]
      .includes(row.status);
    if (isTerminal && terminalFields.some((value) => !value)) {
      throw new OperatorError(
        "Durable SafeCommit terminal lifecycle evidence is incomplete.",
        409,
        "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
      );
    }
    if (!isTerminal && terminalFields.some((value) => value !== null)) {
      throw new OperatorError(
        "Non-terminal SafeCommit lifecycle state contains terminal fields.",
        409,
        "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
      );
    }
    if (row.status === "invalidated") {
      if (
        !row.terminal_evidence_ref
        || !row.terminal_evidence_digest
        || !HASH_PATTERN.test(row.terminal_evidence_digest)
      ) {
        throw new OperatorError(
          "Invalidated SafeCommit approval is missing mutation evidence.",
          409,
          "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
        );
      }
    } else if (row.terminal_evidence_ref !== null || row.terminal_evidence_digest !== null) {
      throw new OperatorError(
        "Non-invalidated SafeCommit lifecycle state contains mutation evidence.",
        409,
        "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
      );
    }
    if (row.status === "completed" || row.status === "failed_terminal") {
      if (
        row.closeout_outcome !== row.status
        || !row.closeout_evidence_ref
        || !row.closeout_evidence_digest
        || !HASH_PATTERN.test(row.closeout_evidence_digest)
      ) {
        throw new OperatorError(
          "Terminal SafeCommit execution is missing exact closeout evidence.",
          409,
          "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
        );
      }
    } else if (
      row.closeout_outcome !== null
      || row.closeout_evidence_ref !== null
      || row.closeout_evidence_digest !== null
    ) {
      throw new OperatorError(
        "Non-completed SafeCommit lifecycle state contains closeout evidence.",
        409,
        "OPERATOR_SAFECOMMIT_TERMINAL_INTEGRITY_VIOLATION",
      );
    }
  }

  private assertPlanHash(row: CloseoutRow, planHash: string): void {
    if (row.plan_hash !== planHash) {
      throw new OperatorError(
        "The supplied plan hash does not match the immutable SafeCommit closeout request.",
        409,
        "OPERATOR_SAFECOMMIT_PLAN_HASH_MISMATCH",
      );
    }
  }

  private assertApprovalEvidence(
    row: CloseoutRow,
    evidenceId: string,
    evidenceDigest: string,
  ): void {
    if (
      row.approval_evidence_id !== evidenceId
      || row.approval_evidence_digest !== evidenceDigest
    ) {
      throw new OperatorError(
        "The supplied approval evidence reference does not match Operator truth.",
        409,
        "OPERATOR_SAFECOMMIT_APPROVAL_EVIDENCE_MISMATCH",
      );
    }
  }

  private assertChanged(result: { changes: number | bigint }, message: string): void {
    if (Number(result.changes) !== 1) {
      throw new OperatorError(
        message,
        409,
        "OPERATOR_SAFECOMMIT_CONCURRENT_TRANSITION",
      );
    }
  }

  private stateError(
    current: SafeCommitCloseoutState,
    attempted: SafeCommitCloseoutState,
  ): OperatorError {
    return new OperatorError(
      `SafeCommit closeout cannot transition from ${current} to ${attempted}.`,
      409,
      "OPERATOR_SAFECOMMIT_INVALID_TRANSITION",
    );
  }

  private assertContainsNoProtectedValue(values: readonly string[]): void {
    if (
      this.protectedValues.some((protectedValue) =>
        values.some((value) => value.includes(protectedValue)))
    ) {
      throw new OperatorError(
        "SafeCommit closeout input must not contain protected configuration data.",
        400,
        "OPERATOR_SAFECOMMIT_PROTECTED_VALUE_REJECTED",
      );
    }
  }
}
