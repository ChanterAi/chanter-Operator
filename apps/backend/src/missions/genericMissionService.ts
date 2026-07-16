/**
 * Phase 2C generic durable mission authority.
 *
 * One durable Operator-owned mission spine for every registered non-AutoPoster
 * action (today exactly one: `loop_governor.manual_loop.create`). The accepted
 * Phase 2A AutoPosterMissionService is intentionally untouched; this service
 * mirrors its proven semantics onto the additive `operator_missions` tables:
 *
 *   durable create (exact replay / typed 409 mismatches)
 *   -> independent control-token approval (submission can never approve)
 *   -> Agent Runtime execution through the registered adapter boundary
 *   -> boundary-journaled crash recovery (Reconcile / Resume safely / Stop)
 *   -> bounded single retry (retry_count <= 1) and explicit terminal states
 *   -> Agent Run Ledger lineage in the same SQLite transactions
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  createRuntimeMissionPayloadHash,
  envelopeToRuntimeMissionRequest,
  validateManualLoopInput,
  type ChanterMissionEnvelopeV1,
  type JsonValue,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type RuntimeMissionStatus,
} from "chanter-agent-runtime";
import type { AgentRunLedgerService } from "../agentRunLedger/agentRunLedgerService.js";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import {
  GenericMissionJournal,
  type GenericMissionDownstreamIds,
  type GenericMissionExecutionRecord,
  type GenericMissionExecutionState,
  type GenericMissionJournalTransition,
  type GenericMissionTypedError,
} from "./genericMissionJournal.js";
import {
  GenericMissionLedger,
  type GenericMissionLedgerContext,
} from "./genericMissionLedger.js";
import type { LoopGovernorMissionExecutor } from "./loopGovernorRuntime.js";
import {
  resolveRegisteredMissionAction,
  type RegisteredMissionAction,
} from "./missionActionRegistry.js";

const ACTOR_ID = "chanter-operator";
const REDACTED_VALUE = "[REDACTED]";
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ACTOR_LENGTH = 120;
const MAX_TENANT_LENGTH = 160;
const MAX_OBJECTIVE_LENGTH = 2_000;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;

export type GenericMissionStatus = "approval_required" | "executing" | RuntimeMissionStatus;

export type GenericMissionRecoveryAction = "Reconcile" | "Resume safely" | "Stop / escalate";

export interface GenericMissionExecutionView {
  state: GenericMissionExecutionState;
  executionAttemptId: string;
  missionPayloadHash: string;
  downstreamOperationType: string;
  lastConfirmedBoundary: GenericMissionExecutionState;
  recoveryReason: string;
  recoveryClassification: string;
  reconciliationOutcome: string;
  downstreamIds: GenericMissionDownstreamIds | null;
  authoritativeLoopId: string | null;
  retryCount: number;
  nextPermittedActions: GenericMissionRecoveryAction[];
  evidenceStatus: "pending" | "authoritative" | "failed" | "reconciliation_required";
  typedError: GenericMissionTypedError | null;
}

export interface GenericRuntimeMission {
  replayed: boolean;
  missionId: string;
  traceId: string;
  product: string;
  action: string;
  actorId: string;
  tenantUserId: string;
  workspaceId: string | null;
  accountId: string | null;
  objective: string;
  input: Record<string, JsonValue>;
  idempotencyKey: string;
  status: GenericMissionStatus;
  approvalRequired: true;
  approvedBy: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
  runtimeResult: RuntimeMissionResult | null;
  execution: GenericMissionExecutionView | null;
  executionJournal: GenericMissionJournalTransition[];
}

export interface GenericMissionReadiness {
  configured: boolean;
  executionScope: "loop_governor_manual_loop_create_only";
  actions: string[];
  realAgentExecution: false;
}

export type GenericMissionFailureBoundary =
  | "after_approval_persistence"
  | "after_runtime_execution_start_persistence"
  | "after_downstream_request_preparation_persistence"
  | "after_operator_observes_runtime_result_before_persistence"
  | "during_restart_claim_recovery";

interface GenericMissionServiceOptions {
  agentRunLedgerService: AgentRunLedgerService;
  now?: () => Date;
  idFactory?: () => string;
  protectedValues?: string[];
  failureInjector?: (boundary: GenericMissionFailureBoundary, missionId: string) => void;
}

interface MissionRow {
  mission_id: string;
  trace_id: string;
  product: string;
  action: string;
  actor_id: string;
  tenant_user_id: string;
  workspace_id: string | null;
  account_id: string | null;
  objective: string;
  input_json: string;
  idempotency_key: string;
  payload_hash: string;
  status: GenericMissionStatus;
  approval_required: number;
  approved_by: string | null;
  runtime_result_json: string | null;
  requested_at: string;
  created_at: string;
  updated_at: string;
}

interface CanonicalSubmitInput {
  missionId: string;
  traceId: string;
  idempotencyKey: string;
  actorId: string;
  tenantUserId: string;
  workspaceId: string | null;
  accountId: string | null;
  registered: RegisteredMissionAction;
  objective: string;
  input: Record<string, JsonValue>;
  requestedAt: string;
  payloadHash: string;
}

function redactProtectedValues(value: unknown, protectedValues: readonly string[]): unknown {
  if (typeof value === "string") {
    return protectedValues.reduce(
      (redacted, protectedValue) => redacted.split(protectedValue).join(REDACTED_VALUE),
      value,
    );
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactProtectedValues(item, protectedValues));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactProtectedValues(key, protectedValues) as string,
        redactProtectedValues(item, protectedValues),
      ]),
    );
  }
  return value;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactIdentifier(value: unknown, field: string, maxLength: number): string {
  if (
    typeof value !== "string"
    || !value
    || value !== value.trim()
    || value.length > maxLength
    || CONTROL_CHAR_PATTERN.test(value)
  ) {
    throw new OperatorError(
      `${field} must be an exact nonblank identifier of at most ${maxLength} characters.`,
      400,
      "OPERATOR_MISSION_IDENTITY_INVALID",
    );
  }
  return value;
}

function optionalExactIdentifier(
  value: unknown,
  field: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return exactIdentifier(value, field, maxLength);
}

export function permittedGenericRecoveryActions(
  execution: GenericMissionExecutionRecord,
): GenericMissionRecoveryAction[] {
  if (execution.currentState === "approved") return ["Resume safely", "Stop / escalate"];
  if (
    execution.currentState === "execution_started"
    || execution.currentState === "downstream_request_prepared"
  ) {
    return ["Reconcile", "Stop / escalate"];
  }
  if (execution.currentState === "downstream_result_observed") return ["Resume safely"];
  if (execution.currentState === "result_persisted") return ["Resume safely"];
  if (execution.currentState === "failed_recoverable") {
    const retryable = (
      execution.reconciliationOutcome === "not_found"
      || execution.reconciliationOutcome === "incomplete"
    ) && execution.retryCount === 0;
    return retryable
      ? ["Reconcile", "Resume safely", "Stop / escalate"]
      : ["Reconcile", "Stop / escalate"];
  }
  if (execution.currentState === "reconciliation_required") return ["Stop / escalate"];
  if (execution.currentState === "recovery_in_progress") return ["Reconcile"];
  return [];
}

function executionEvidenceStatus(
  execution: GenericMissionExecutionRecord,
): GenericMissionExecutionView["evidenceStatus"] {
  if (execution.currentState === "completed") return "authoritative";
  if (execution.currentState === "failed_terminal") return "failed";
  if (
    execution.currentState === "reconciliation_required"
    || execution.currentState === "failed_recoverable"
  ) {
    return "reconciliation_required";
  }
  return "pending";
}

function mapExecutionView(execution: GenericMissionExecutionRecord): GenericMissionExecutionView {
  return {
    state: execution.currentState,
    executionAttemptId: execution.executionAttemptId,
    missionPayloadHash: execution.missionPayloadHash,
    downstreamOperationType: execution.downstreamOperationType,
    lastConfirmedBoundary: execution.lastConfirmedBoundary,
    recoveryReason: execution.recoveryReason,
    recoveryClassification: execution.recoveryClassification,
    reconciliationOutcome: execution.reconciliationOutcome,
    downstreamIds: execution.downstreamIds,
    authoritativeLoopId: execution.downstreamIds?.loopId ?? null,
    retryCount: execution.retryCount,
    nextPermittedActions: permittedGenericRecoveryActions(execution),
    evidenceStatus: executionEvidenceStatus(execution),
    typedError: execution.typedError,
  };
}

function mapMission(
  row: MissionRow,
  execution: GenericMissionExecutionRecord | null,
  transitions: GenericMissionJournalTransition[],
  replayed = false,
): GenericRuntimeMission {
  return {
    replayed,
    missionId: row.mission_id,
    traceId: row.trace_id,
    product: row.product,
    action: row.action,
    actorId: row.actor_id,
    tenantUserId: row.tenant_user_id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    objective: row.objective,
    input: JSON.parse(row.input_json) as Record<string, JsonValue>,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    approvalRequired: true,
    approvedBy: row.approved_by,
    requestedAt: row.requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    runtimeResult: row.runtime_result_json
      ? (JSON.parse(row.runtime_result_json) as RuntimeMissionResult)
      : null,
    execution: execution ? mapExecutionView(execution) : null,
    executionJournal: transitions,
  };
}

export class GenericMissionService {
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly protectedValues: string[];
  private readonly journal: GenericMissionJournal;
  private readonly missionLedger: GenericMissionLedger;
  private readonly failureInjector?: GenericMissionServiceOptions["failureInjector"];

  constructor(
    private readonly database: DatabaseSync,
    private readonly executor: LoopGovernorMissionExecutor,
    options: GenericMissionServiceOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.journal = new GenericMissionJournal(database, this.idFactory);
    this.missionLedger = new GenericMissionLedger(options.agentRunLedgerService, {
      productId: "loop_governor",
      workflowId: "loop_governor.manual_loop.create",
      toolId: "chanter-agent-runtime:loop-governor-adapter",
      toolName: "CHANTER Agent Runtime Loop Governor adapter",
      inputSummary: "Create one governed manual (agent-frozen) Loop Governor relay loop.",
      actionSummary: "Operator governed one Loop Governor manual-loop mission.",
      completedValidationSummary:
        "Operator verified the exact loop/task identity, manual-relay mode, and real-agent freeze before completion.",
    });
    this.failureInjector = options.failureInjector;
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  getReadiness(): GenericMissionReadiness {
    return {
      configured: this.executor.configured,
      executionScope: "loop_governor_manual_loop_create_only",
      actions: ["loop_governor.manual_loop.create"],
      realAgentExecution: false,
    };
  }

  hasMission(missionId: string): boolean {
    const normalized = String(missionId || "").trim();
    if (!normalized) return false;
    return Boolean(
      this.database
        .prepare("SELECT mission_id FROM operator_missions WHERE mission_id = ?")
        .get(normalized),
    );
  }

  listMissions(limit = 50): GenericRuntimeMission[] {
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100));
    return this.database
      .prepare(
        "SELECT * FROM operator_missions ORDER BY created_at DESC, mission_id DESC LIMIT ?",
      )
      .all(boundedLimit)
      .map((row) => {
        const missionRow = row as unknown as MissionRow;
        const execution = this.journal.getExecution(missionRow.mission_id);
        const transitions = execution
          ? this.journal.listTransitions(missionRow.mission_id)
          : [];
        return mapMission(missionRow, execution, transitions);
      });
  }

  getMission(missionId: string): GenericRuntimeMission {
    const normalized = String(missionId || "").trim();
    const row = this.database
      .prepare("SELECT * FROM operator_missions WHERE mission_id = ?")
      .get(normalized) as MissionRow | undefined;
    if (!row) throw new OperatorError("Runtime mission was not found.", 404);
    const execution = this.journal.getExecution(row.mission_id);
    const transitions = execution ? this.journal.listTransitions(row.mission_id) : [];
    return mapMission(row, execution, transitions);
  }

  // -------------------------------------------------------------------------
  // Durable create
  // -------------------------------------------------------------------------

  async createMissionFromEnvelope(
    envelope: ChanterMissionEnvelopeV1,
  ): Promise<GenericRuntimeMission> {
    const registered = resolveRegisteredMissionAction(
      envelope.target.product,
      envelope.target.action,
    );
    if (!registered || registered.lane !== "generic") {
      throw new OperatorError(
        "The mission target is not registered with the Operator gateway.",
        409,
        "OPERATOR_MISSION_TARGET_MISMATCH",
      );
    }

    const missionId = exactIdentifier(envelope.missionId, "missionId", MAX_IDENTIFIER_LENGTH);
    const traceId = exactIdentifier(envelope.traceId, "traceId", MAX_IDENTIFIER_LENGTH);
    const idempotencyKey = optionalExactIdentifier(
      envelope.idempotencyKey,
      "idempotencyKey",
      MAX_IDENTIFIER_LENGTH,
    ) ?? `operator-mission:${missionId}`;
    const actorId = exactIdentifier(envelope.source.requestedBy, "source.requestedBy", MAX_ACTOR_LENGTH);
    const tenantUserId = exactIdentifier(envelope.tenant.userId, "tenant.userId", MAX_TENANT_LENGTH);
    const workspaceId = optionalExactIdentifier(
      envelope.tenant.workspaceId,
      "tenant.workspaceId",
      MAX_TENANT_LENGTH,
    );
    const accountId = optionalExactIdentifier(
      envelope.tenant.accountId,
      "tenant.accountId",
      MAX_IDENTIFIER_LENGTH,
    );
    const objective = String(envelope.objective ?? "").trim();
    if (!objective || objective.length > MAX_OBJECTIVE_LENGTH) {
      throw new OperatorError(
        `objective must be a nonblank string of at most ${MAX_OBJECTIVE_LENGTH} characters.`,
        400,
      );
    }

    // Adapter-owned closed-world input validation, enforced at submission so a
    // mission that can never execute is refused before it becomes durable.
    const runtimeRequest = envelopeToRuntimeMissionRequest(envelope);
    const inputErrors = validateManualLoopInput(runtimeRequest).errors;
    if (inputErrors.length > 0) {
      const first = inputErrors[0]!;
      throw new OperatorError(first.message, 400, first.code);
    }

    const serializedInput = JSON.stringify(envelope.input);
    this.assertContainsNoProtectedValue([
      missionId,
      traceId,
      idempotencyKey,
      actorId,
      tenantUserId,
      workspaceId ?? "",
      accountId ?? "",
      objective,
      serializedInput,
    ]);

    const payloadHash = createRuntimeMissionPayloadHash({
      ...runtimeRequest,
      missionId,
      traceId,
      idempotencyKey,
    });
    const canonical: CanonicalSubmitInput = {
      missionId,
      traceId,
      idempotencyKey,
      actorId,
      tenantUserId,
      workspaceId,
      accountId,
      registered,
      objective,
      input: envelope.input,
      requestedAt: envelope.requestedAt,
      payloadHash,
    };

    const existing = this.missionRowBy("mission_id", missionId);
    if (existing) {
      this.assertExistingCreateBinding(existing, canonical);
      return { ...this.getMission(existing.mission_id), replayed: true };
    }

    const executionAttemptId = this.idFactory();
    const timestamp = this.now().toISOString();
    const created = withTransaction(this.database, () => {
      const raced = this.missionRowBy("mission_id", missionId);
      if (raced) {
        this.assertExistingCreateBinding(raced, canonical);
        return { missionId: raced.mission_id, replayed: true };
      }
      this.assertIdentifiersAvailable(canonical);
      this.database
        .prepare(
          `INSERT INTO operator_missions (
            mission_id, trace_id, product, action, actor_id, tenant_user_id,
            workspace_id, account_id, objective, input_json, idempotency_key,
            payload_hash, status, approval_required, approved_by,
            runtime_result_json, requested_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval_required', 1, NULL, NULL, ?, ?, ?)`,
        )
        .run(
          missionId,
          traceId,
          registered.product,
          registered.action,
          actorId,
          tenantUserId,
          workspaceId,
          accountId,
          objective,
          serializedInput,
          idempotencyKey,
          payloadHash,
          canonical.requestedAt,
          timestamp,
          timestamp,
        );
      this.journal.initialize({
        missionId,
        executionAttemptId,
        missionPayloadHash: payloadHash,
        downstreamOperationType: registered.downstreamOperationType,
        timestamp,
        actor: actorId,
      });
      this.missionLedger.initialize({
        missionId,
        traceId,
        attemptId: executionAttemptId,
        startedAt: timestamp,
        updatedAt: timestamp,
        approvalActor: null,
        approvalTimestamp: null,
        runtimeStarted: false,
      });
      return { missionId, replayed: false };
    });

    return created.replayed
      ? { ...this.getMission(created.missionId), replayed: true }
      : this.getMission(created.missionId);
  }

  // -------------------------------------------------------------------------
  // Approval + execution
  // -------------------------------------------------------------------------

  async approveAndExecute(
    missionId: string,
    approvedByValue: unknown,
  ): Promise<GenericRuntimeMission> {
    const approvedBy = typeof approvedByValue === "string" ? approvedByValue.trim() : "";
    if (!approvedBy) throw new OperatorError("approvedBy is required.", 400);
    if (approvedBy.length > MAX_ACTOR_LENGTH) {
      throw new OperatorError(`approvedBy must be at most ${MAX_ACTOR_LENGTH} characters.`, 400);
    }
    this.assertContainsNoProtectedValue([approvedBy]);

    const current = this.getMission(missionId);
    if (current.runtimeResult && current.execution?.state === "completed") {
      this.assertCompletedReplayBinding(current, approvedBy);
      withTransaction(this.database, () => {
        this.journal.transition(current.missionId, "completed", {
          actor: ACTOR_ID,
          reason: "Exact durable replay returned the existing authoritative result without execution.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "completed",
          recoveryClassification: "DURABLE_REPLAY",
          evidenceReferences: [
            `mission:${current.missionId}`,
            ...(current.execution?.authoritativeLoopId
              ? [`loop-governor-loop:${current.execution.authoritativeLoopId}`]
              : []),
          ],
        });
      });
      return this.getMission(current.missionId);
    }
    if (current.status === "executing") {
      throw new OperatorError(
        "Runtime mission is interrupted or already active; use Reconcile before any retry.",
        409,
        "RECOVERY_RECONCILIATION_REQUIRED",
      );
    }
    if (current.status !== "approval_required" || current.execution?.state !== "approval_required") {
      throw new OperatorError(`Runtime mission cannot execute from status ${current.status}.`, 409);
    }

    const approvedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const result = this.database.prepare(
        `UPDATE operator_missions
           SET status = 'executing', approved_by = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'approval_required' AND runtime_result_json IS NULL`,
      ).run(approvedBy, approvedAt, current.missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError("Runtime mission state changed before approval could be saved.", 409);
      }
      this.journal.transition(current.missionId, "approved", {
        actor: approvedBy,
        reason: "Founder approval was durably persisted before execution.",
        timestamp: approvedAt,
        lastConfirmedBoundary: "approved",
        evidenceReferences: [`approval:${approvedBy}`],
      });
      this.missionLedger.recordApproved(
        this.ledgerContext(current.missionId, approvedAt),
      );
    });
    this.injectFailure("after_approval_persistence", current.missionId);

    const startedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(current.missionId, "execution_started", {
        actor: "chanter-agent-runtime",
        reason: "Runtime execution attempt began under the persisted approval.",
        timestamp: startedAt,
        lastConfirmedBoundary: "execution_started",
        evidenceReferences: [`attempt:${current.execution!.executionAttemptId}`],
      });
      this.missionLedger.recordRunning(
        this.ledgerContext(current.missionId, startedAt),
      );
    });
    this.injectFailure("after_runtime_execution_start_persistence", current.missionId);

    const preparedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(current.missionId, "downstream_request_prepared", {
        actor: "chanter-agent-runtime",
        reason: "Exact Loop Governor request scope and payload hash were durably prepared.",
        timestamp: preparedAt,
        lastConfirmedBoundary: "downstream_request_prepared",
        evidenceReferences: [`payload-sha256:${current.execution!.missionPayloadHash}`],
      });
    });
    this.injectFailure("after_downstream_request_preparation_persistence", current.missionId);

    const mission = this.getMission(current.missionId);
    return this.executePreparedMission(
      mission,
      this.buildRuntimeRequest(mission, approvedBy),
    );
  }

  // -------------------------------------------------------------------------
  // Recovery: Reconcile / Resume safely / Stop
  // -------------------------------------------------------------------------

  async reconcileMission(missionId: string): Promise<GenericRuntimeMission> {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Reconcile");
    if (!mission.approvedBy) {
      throw new OperatorError("Mission approval is missing; recovery cannot bypass approval.", 409);
    }
    const attemptId = this.idFactory();
    withTransaction(this.database, () => {
      let currentExecution = this.journal.requireExecution(mission.missionId);
      if (currentExecution.currentState !== "failed_recoverable") {
        const interruptedAt = this.now().toISOString();
        const interruptedError = {
          code: "RECOVERY_INTERRUPTED_EXECUTION",
          message: "Execution was interrupted before Operator persisted an authoritative result.",
        };
        currentExecution = this.journal.transition(mission.missionId, "failed_recoverable", {
          actor: ACTOR_ID,
          reason: "A restarted process detected an uncertain downstream execution boundary.",
          timestamp: interruptedAt,
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: "Process interruption requires exact downstream reconciliation.",
          recoveryClassification: "INTERRUPTED_EXECUTION_DETECTED",
          typedError: interruptedError,
        });
        this.missionLedger.recordReconciliationRequired(
          this.ledgerContext(mission.missionId, interruptedAt),
          { code: interruptedError.code, reason: interruptedError.message },
        );
      }
      const recoveryStartedAt = this.now().toISOString();
      this.journal.transition(mission.missionId, "recovery_in_progress", {
        actor: ACTOR_ID,
        reason: "Operator claimed one bounded read-only reconciliation attempt.",
        timestamp: recoveryStartedAt,
        executionAttemptId: attemptId,
        lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
        typedError: null,
      });
      this.missionLedger.recordRunning(
        this.ledgerContext(mission.missionId, recoveryStartedAt),
      );
    });
    this.injectFailure("during_restart_claim_recovery", mission.missionId);

    const request = this.buildRuntimeRequest(mission, mission.approvedBy);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      throw new OperatorError("Recovery request does not match the durable payload hash.", 409, "RECOVERY_SCOPE_MISMATCH");
    }
    const result = await this.executor.lookup(request);
    const reconciledAt = this.now().toISOString();

    if (!result.ok) {
      const recoverable = result.code === "unavailable" || result.code === "timeout";
      const typedError: GenericMissionTypedError = {
        code: recoverable ? "RECOVERY_DOWNSTREAM_UNAVAILABLE" : "RECOVERY_EVIDENCE_INVALID",
        message: result.message,
      };
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(
          mission.missionId,
          recoverable ? "failed_recoverable" : "failed_terminal",
          {
            actor: ACTOR_ID,
            reason: typedError.message,
            timestamp: reconciledAt,
            lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
            recoveryReason: typedError.message,
            recoveryClassification: typedError.code,
            reconciliationOutcome: recoverable ? "unavailable" : "invalid",
            typedError,
          },
        );
        const ledgerContext = this.ledgerContext(mission.missionId, reconciledAt);
        if (recoverable) {
          this.missionLedger.recordReconciliationRequired(ledgerContext, {
            code: typedError.code,
            reason: typedError.message,
          });
        } else {
          this.missionLedger.recordFailed(ledgerContext, {
            code: typedError.code,
            reason: typedError.message,
          });
        }
      });
      return this.getMission(mission.missionId);
    }

    if (result.outcome === "payload_mismatch") {
      const typedError: GenericMissionTypedError = {
        code: "RECOVERY_PAYLOAD_MISMATCH",
        message: "Loop Governor durable truth reported payload_mismatch for this mission binding.",
      };
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        this.journal.transition(mission.missionId, "failed_terminal", {
          actor: ACTOR_ID,
          reason: typedError.message,
          timestamp: reconciledAt,
          lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
          recoveryReason: typedError.message,
          recoveryClassification: typedError.code,
          reconciliationOutcome: "payload_mismatch",
          reconciliationResult: result,
          typedError,
        });
        this.missionLedger.recordFailed(
          this.ledgerContext(mission.missionId, reconciledAt),
          { code: typedError.code, reason: typedError.message },
        );
      });
      return this.getMission(mission.missionId);
    }

    if (result.outcome === "unique") {
      withTransaction(this.database, () => {
        this.journal.transition(mission.missionId, "downstream_result_observed", {
          actor: ACTOR_ID,
          reason: "Loop Governor confirmed one exact durable loop binding after restart.",
          timestamp: reconciledAt,
          lastConfirmedBoundary: "downstream_result_observed",
          recoveryReason: "The existing downstream manual loop was recovered exactly.",
          recoveryClassification: "RECOVERED_EXISTING_DOWNSTREAM_RESULT",
          reconciliationOutcome: "unique",
          downstreamIds: {
            loopId: result.binding!.loopId,
            taskId: result.binding!.taskId,
            created: false,
          },
          reconciliationResult: result,
          runtimeObservation: null,
          typedError: null,
          evidenceReferences: [`loop-governor-loop:${result.binding!.loopId}`],
        });
        this.missionLedger.recordValidating(
          this.ledgerContext(mission.missionId, reconciledAt),
        );
      });
      return this.getMission(mission.missionId);
    }

    // not_found | incomplete: no completed downstream binding exists; the
    // idempotent create makes one bounded safe retry possible in both cases.
    const outcome = result.outcome;
    withTransaction(this.database, () => {
      const currentExecution = this.journal.requireExecution(mission.missionId);
      this.journal.transition(mission.missionId, "failed_recoverable", {
        actor: ACTOR_ID,
        reason: outcome === "incomplete"
          ? "Loop Governor holds a partial (task-only) intent; the idempotent create can complete it safely."
          : "Loop Governor confirmed that no downstream binding exists for the exact scope.",
        timestamp: reconciledAt,
        lastConfirmedBoundary: currentExecution.lastConfirmedBoundary,
        recoveryReason: "One bounded safe retry is permitted through the idempotent downstream create.",
        recoveryClassification: "SAFE_RETRY_AVAILABLE",
        reconciliationOutcome: outcome,
        reconciliationResult: result,
        runtimeObservation: null,
        typedError: null,
      });
      this.missionLedger.recordReconciliationRequired(
        this.ledgerContext(mission.missionId, reconciledAt),
        {
          code: "SAFE_RETRY_AVAILABLE",
          reason: "One bounded safe retry is permitted through the idempotent downstream create.",
        },
      );
    });
    return this.getMission(mission.missionId);
  }

  async resumeSafely(missionId: string): Promise<GenericRuntimeMission> {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Resume safely");
    if (!mission.approvedBy) {
      throw new OperatorError("Mission approval is missing; recovery cannot bypass approval.", 409);
    }

    if (execution.currentState === "result_persisted") {
      withTransaction(this.database, () => {
        const completedAt = this.now().toISOString();
        this.journal.transition(mission.missionId, "completed", {
          actor: ACTOR_ID,
          reason: "Restart completed the mission from its already-persisted Operator result.",
          timestamp: completedAt,
          lastConfirmedBoundary: "completed",
          recoveryClassification: "RECOVERED_OPERATOR_RESULT",
        });
        this.missionLedger.recordCompleted(
          this.ledgerContext(mission.missionId, completedAt),
          this.requireSerializedRuntimeResult(mission.missionId),
        );
      });
      return this.getMission(mission.missionId);
    }

    if (
      execution.currentState === "downstream_result_observed"
      && execution.runtimeObservation
    ) {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (
          currentExecution.currentState !== "downstream_result_observed"
          || !currentExecution.runtimeObservation
        ) {
          throw new OperatorError(
            "The observed Runtime result was already claimed by another recovery process.",
            409,
            "MISSION_JOURNAL_CONCURRENT_TRANSITION",
          );
        }
        this.prepareMissionRowForRecovery(mission.missionId, this.now().toISOString());
      });
      return this.persistObservedRuntimeResult(
        mission.missionId,
        execution.runtimeObservation as RuntimeMissionResult,
        "RECOVERED_RUNTIME_RESULT",
      );
    }

    const request = this.buildRuntimeRequest(mission, mission.approvedBy);
    const attemptId = this.idFactory();

    if (execution.currentState === "approved") {
      withTransaction(this.database, () => {
        if (this.journal.requireExecution(mission.missionId).currentState !== "approved") {
          throw new OperatorError(
            "The approved mission was already claimed by another recovery process.",
            409,
            "MISSION_JOURNAL_CONCURRENT_TRANSITION",
          );
        }
        const resumedAt = this.now().toISOString();
        this.prepareMissionRowForRecovery(mission.missionId, resumedAt);
        this.journal.transition(mission.missionId, "execution_started", {
          actor: "chanter-agent-runtime",
          reason: "Restart resumed an approved mission before any downstream request was prepared.",
          timestamp: resumedAt,
          executionAttemptId: attemptId,
          lastConfirmedBoundary: "execution_started",
          recoveryClassification: "RESUMED_BEFORE_DOWNSTREAM",
        });
        this.missionLedger.recordRunning(
          this.ledgerContext(mission.missionId, resumedAt),
        );
        this.journal.transition(mission.missionId, "downstream_request_prepared", {
          actor: "chanter-agent-runtime",
          reason: "The resumed execution durably prepared the exact downstream request.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "downstream_request_prepared",
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        "RESUMED_BEFORE_DOWNSTREAM",
      );
    }

    if (
      execution.currentState === "downstream_result_observed"
      && execution.reconciliationOutcome === "unique"
    ) {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (
          currentExecution.currentState !== "downstream_result_observed"
          || currentExecution.reconciliationOutcome !== "unique"
        ) {
          throw new OperatorError(
            "The reconciled loop result was already claimed by another recovery process.",
            409,
            "MISSION_JOURNAL_CONCURRENT_TRANSITION",
          );
        }
        const retryStartedAt = this.now().toISOString();
        this.prepareMissionRowForRecovery(mission.missionId, retryStartedAt);
        this.journal.transition(mission.missionId, "recovery_in_progress", {
          actor: ACTOR_ID,
          reason: "Operator is attaching the previously reconciled loop binding through the idempotent create.",
          timestamp: retryStartedAt,
          executionAttemptId: attemptId,
          lastConfirmedBoundary: "downstream_result_observed",
        });
        this.journal.transition(mission.missionId, "downstream_request_prepared", {
          actor: "chanter-agent-runtime",
          reason: "The recovery re-dispatch durably prepared the exact original downstream request.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "downstream_request_prepared",
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        "RECOVERED_EXISTING_DOWNSTREAM_RESULT",
      );
    }

    if (
      execution.currentState === "failed_recoverable"
      && (execution.reconciliationOutcome === "not_found" || execution.reconciliationOutcome === "incomplete")
      && execution.retryCount === 0
    ) {
      withTransaction(this.database, () => {
        const currentExecution = this.journal.requireExecution(mission.missionId);
        if (
          currentExecution.currentState !== "failed_recoverable"
          || (
            currentExecution.reconciliationOutcome !== "not_found"
            && currentExecution.reconciliationOutcome !== "incomplete"
          )
          || currentExecution.retryCount !== 0
        ) {
          throw new OperatorError(
            "The single safe retry was already claimed by another recovery process.",
            409,
            "MISSION_JOURNAL_CONCURRENT_TRANSITION",
          );
        }
        const retryStartedAt = this.now().toISOString();
        this.prepareMissionRowForRecovery(mission.missionId, retryStartedAt);
        this.journal.transition(mission.missionId, "recovery_in_progress", {
          actor: ACTOR_ID,
          reason: "Operator claimed the single permitted safe retry after exact reconciliation.",
          timestamp: retryStartedAt,
          executionAttemptId: attemptId,
          lastConfirmedBoundary: execution.lastConfirmedBoundary,
          retryCount: 1,
          recoveryClassification: "SAFE_RETRY_IN_PROGRESS",
          typedError: null,
        });
        this.missionLedger.recordRunning(
          this.ledgerContext(mission.missionId, retryStartedAt),
        );
        this.journal.transition(mission.missionId, "downstream_request_prepared", {
          actor: "chanter-agent-runtime",
          reason: "The single safe retry durably prepared the exact original downstream request.",
          timestamp: this.now().toISOString(),
          lastConfirmedBoundary: "downstream_request_prepared",
          recoveryClassification: "SAFE_RETRY_IN_PROGRESS",
          evidenceReferences: [`payload-sha256:${execution.missionPayloadHash}`],
        });
      });
      return this.executePreparedMission(
        this.getMission(mission.missionId),
        request,
        "SAFE_RETRY_COMPLETED",
      );
    }

    throw new OperatorError(
      `Mission cannot resume safely from durable state ${execution.currentState} without a valid reconciliation decision.`,
      409,
      "RECOVERY_RECONCILIATION_REQUIRED",
    );
  }

  stopAndEscalate(missionId: string): GenericRuntimeMission {
    const mission = this.getMission(missionId);
    const execution = this.journal.requireExecution(mission.missionId);
    this.assertRecoveryActionAllowed(execution, "Stop / escalate");
    const stoppedAt = this.now().toISOString();
    const typedError = {
      code: "RECOVERY_STOPPED_FOR_ESCALATION",
      message: "A human stopped automatic recovery and escalated the mission.",
    };
    withTransaction(this.database, () => {
      this.database.prepare(
        `UPDATE operator_missions SET status = 'failed', updated_at = ? WHERE mission_id = ?`,
      ).run(stoppedAt, mission.missionId);
      this.journal.transition(mission.missionId, "failed_terminal", {
        actor: ACTOR_ID,
        reason: typedError.message,
        timestamp: stoppedAt,
        lastConfirmedBoundary: execution.lastConfirmedBoundary,
        recoveryReason: typedError.message,
        recoveryClassification: "STOPPED_FOR_ESCALATION",
        typedError,
      });
      this.missionLedger.recordFailed(
        this.ledgerContext(mission.missionId, stoppedAt),
        { code: typedError.code, reason: typedError.message },
      );
    });
    return this.getMission(mission.missionId);
  }

  // -------------------------------------------------------------------------
  // Execution internals
  // -------------------------------------------------------------------------

  private buildRuntimeRequest(
    mission: GenericRuntimeMission,
    approvedBy: string,
  ): RuntimeMissionRequest {
    return {
      missionId: mission.missionId,
      traceId: mission.traceId,
      product: mission.product as RuntimeMissionRequest["product"],
      action: mission.action,
      actor: { id: mission.actorId, kind: "service" },
      tenant: {
        userId: mission.tenantUserId,
        ...(mission.workspaceId ? { workspaceId: mission.workspaceId } : {}),
        ...(mission.accountId ? { accountId: mission.accountId } : {}),
      },
      input: mission.input,
      approval: { approved: true, approvedBy },
      idempotencyKey: mission.idempotencyKey,
      requestedAt: mission.requestedAt,
      policyContext: {
        reason: "Founder approved creation of one manual Loop Governor relay loop.",
      },
    };
  }

  private async executePreparedMission(
    mission: GenericRuntimeMission,
    request: RuntimeMissionRequest,
    recoveryClassification?: string,
  ): Promise<GenericRuntimeMission> {
    const execution = this.journal.requireExecution(mission.missionId);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      throw new OperatorError(
        "The reconstructed mission payload does not match the durable payload hash.",
        409,
        "RECOVERY_SCOPE_MISMATCH",
      );
    }
    let runtimeResult: RuntimeMissionResult;
    try {
      runtimeResult = await this.executor.execute(request);
    } catch {
      runtimeResult = this.executorFailure(mission, request.approval?.approvedBy ?? "unknown");
    }
    return this.persistRuntimeOutcome(mission, runtimeResult, recoveryClassification);
  }

  private executorFailure(
    mission: GenericRuntimeMission,
    approvedBy: string,
  ): RuntimeMissionResult {
    const completedAt = this.now().toISOString();
    return {
      missionId: mission.missionId,
      traceId: mission.traceId,
      product: mission.product as RuntimeMissionResult["product"],
      action: mission.action,
      status: "failed",
      output: null,
      evidence: null,
      warnings: [],
      errors: [{
        code: "OPERATOR_RUNTIME_EXECUTOR_FAILED",
        message: "The Operator runtime mission executor failed safely.",
      }],
      policyDecision: null,
      approvalDecision: { required: true, approved: true, approvedBy },
      idempotency: { key: mission.idempotencyKey, outcome: "not_applicable" },
      startedAt: mission.updatedAt,
      completedAt,
      durationMs: 0,
    };
  }

  private normalizeRuntimeResult(runtimeResult: RuntimeMissionResult): RuntimeMissionResult {
    const redacted = redactProtectedValues(
      runtimeResult,
      this.protectedValues,
    ) as RuntimeMissionResult;
    JSON.parse(JSON.stringify(redacted));
    return redacted;
  }

  private verifiedDownstreamIds(
    runtimeResult: RuntimeMissionResult,
  ): GenericMissionDownstreamIds | null {
    const output = jsonObject(runtimeResult.output);
    const loop = jsonObject(output?.loop);
    const loopId = typeof loop?.loopId === "string" ? loop.loopId : "";
    const taskId = typeof loop?.taskId === "string" ? loop.taskId : "";
    return (
      (runtimeResult.status === "succeeded" || runtimeResult.status === "duplicate")
      && loopId
      && loopId === loopId.trim()
      && taskId
      && taskId === taskId.trim()
      && typeof loop?.created === "boolean"
      && output?.governor === "manual_relay"
      && output?.realAgentExecution === false
    )
      ? { loopId, taskId, created: loop.created as boolean }
      : null;
  }

  private persistObservedRuntimeResult(
    missionId: string,
    runtimeResult: RuntimeMissionResult,
    recoveryClassification?: string,
  ): GenericRuntimeMission {
    const serializedResult = JSON.stringify(runtimeResult);
    const persistedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const result = this.database.prepare(
        `UPDATE operator_missions
           SET status = ?, runtime_result_json = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'executing' AND runtime_result_json IS NULL`,
      ).run(runtimeResult.status, serializedResult, persistedAt, missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError(
          "Runtime mission result could not be saved without overwriting newer state.",
          409,
        );
      }
      this.journal.transition(missionId, "result_persisted", {
        actor: ACTOR_ID,
        reason: "The redacted Runtime result was durably persisted by Operator.",
        timestamp: persistedAt,
        lastConfirmedBoundary: "result_persisted",
        finalResultStatus: runtimeResult.status,
        recoveryClassification,
        evidenceReferences: [`runtime-result:${missionId}`],
      });
    });
    const completedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      this.journal.transition(missionId, "completed", {
        actor: ACTOR_ID,
        reason: "Mission completed only after the authoritative result was persisted.",
        timestamp: completedAt,
        lastConfirmedBoundary: "completed",
        recoveryClassification,
        typedError: null,
        evidenceReferences: [`mission:${missionId}`, `runtime-result:${missionId}`],
      });
      this.missionLedger.recordCompleted(
        this.ledgerContext(missionId, completedAt),
        serializedResult,
      );
    });
    return this.getMission(missionId);
  }

  private persistRuntimeOutcome(
    mission: GenericRuntimeMission,
    runtimeResultValue: RuntimeMissionResult,
    recoveryClassification?: string,
  ): GenericRuntimeMission {
    const runtimeResult = this.normalizeRuntimeResult(runtimeResultValue);
    const downstreamIds = this.verifiedDownstreamIds(runtimeResult);
    if (downstreamIds) {
      const observedAt = this.now().toISOString();
      withTransaction(this.database, () => {
        this.journal.transition(mission.missionId, "downstream_result_observed", {
          actor: "chanter-agent-runtime",
          reason: "Runtime observed one exact manual-loop result with the real-agent freeze attested.",
          timestamp: observedAt,
          lastConfirmedBoundary: "downstream_result_observed",
          downstreamIds,
          runtimeObservation: runtimeResult,
          recoveryClassification,
          typedError: null,
          evidenceReferences: [
            `loop-governor-loop:${downstreamIds.loopId}`,
            `loop-governor-task:${downstreamIds.taskId}`,
            `runtime-result:${mission.missionId}`,
          ],
        });
        this.missionLedger.recordValidating(
          this.ledgerContext(mission.missionId, observedAt),
        );
      });
      this.injectFailure("after_operator_observes_runtime_result_before_persistence", mission.missionId);
      return this.persistObservedRuntimeResult(
        mission.missionId,
        runtimeResult,
        recoveryClassification,
      );
    }

    const firstError = runtimeResult.errors[0] ?? {
      code: "RECOVERY_EVIDENCE_INVALID",
      message: "Runtime did not return authoritative manual-loop evidence.",
    };
    const typedError = { code: firstError.code, message: firstError.message };
    const recoverable = runtimeResult.status === "unavailable"
      || runtimeResult.status === "failed";
    const failedState = recoverable ? "failed_recoverable" : "failed_terminal";
    const failedAt = this.now().toISOString();
    withTransaction(this.database, () => {
      const serializedResult = JSON.stringify(runtimeResult);
      const result = this.database.prepare(
        `UPDATE operator_missions
           SET status = ?, runtime_result_json = ?, updated_at = ?
         WHERE mission_id = ? AND status = 'executing'`,
      ).run(runtimeResult.status, serializedResult, failedAt, mission.missionId);
      if (Number(result.changes) !== 1) {
        throw new OperatorError("Runtime mission failure could not be saved safely.", 409);
      }
      const current = this.journal.requireExecution(mission.missionId);
      this.journal.transition(mission.missionId, failedState, {
        actor: "chanter-agent-runtime",
        reason: recoverable
          ? "Runtime could not prove whether the downstream boundary completed; reconciliation is required before retry."
          : "Runtime returned a terminal typed refusal before authoritative completion.",
        timestamp: failedAt,
        lastConfirmedBoundary: current.lastConfirmedBoundary,
        recoveryReason: typedError.message,
        recoveryClassification: recoveryClassification ?? (recoverable
          ? "RECOVERY_DOWNSTREAM_UNAVAILABLE"
          : "RECOVERY_EVIDENCE_INVALID"),
        finalResultStatus: runtimeResult.status,
        runtimeObservation: runtimeResult,
        typedError,
        evidenceReferences: [`runtime-result:${mission.missionId}`],
      });
      const ledgerContext = this.ledgerContext(mission.missionId, failedAt);
      if (recoverable) {
        this.missionLedger.recordReconciliationRequired(ledgerContext, {
          code: typedError.code,
          reason: typedError.message,
        });
      } else {
        this.missionLedger.recordFailed(ledgerContext, {
          code: typedError.code,
          reason: typedError.message,
        });
      }
    });
    return this.getMission(mission.missionId);
  }

  private prepareMissionRowForRecovery(missionId: string, timestamp: string): void {
    const result = this.database.prepare(
      `UPDATE operator_missions
         SET status = 'executing', runtime_result_json = NULL, updated_at = ?
       WHERE mission_id = ? AND approved_by IS NOT NULL`,
    ).run(timestamp, missionId);
    if (Number(result.changes) !== 1) {
      throw new OperatorError(
        "The approved mission row could not be claimed for recovery.",
        409,
        "RECOVERY_RECONCILIATION_REQUIRED",
      );
    }
  }

  private assertCompletedReplayBinding(
    mission: GenericRuntimeMission,
    replayApprovedBy: string,
  ): void {
    const execution = this.journal.requireExecution(mission.missionId);
    const runtimeResult = mission.runtimeResult;
    if (!runtimeResult) {
      throw new OperatorError(
        "The mission has no authoritative completed result to replay.",
        409,
        "OPERATOR_COMPLETED_REPLAY_STATE_MISMATCH",
      );
    }
    if (execution.currentState !== "completed") {
      throw new OperatorError(
        "The mission durable execution is not completed.",
        409,
        "OPERATOR_COMPLETED_REPLAY_STATE_MISMATCH",
      );
    }
    const durableApprovedBy = mission.approvedBy;
    if (!durableApprovedBy || durableApprovedBy !== replayApprovedBy) {
      throw new OperatorError(
        "Replay approval identity does not match the durable approval binding.",
        409,
        "OPERATOR_APPROVAL_BINDING_MISMATCH",
      );
    }
    const request = this.buildRuntimeRequest(mission, durableApprovedBy);
    if (createRuntimeMissionPayloadHash(request) !== execution.missionPayloadHash) {
      throw new OperatorError(
        "The completed mission payload no longer matches its durable payload hash.",
        409,
        "OPERATOR_MISSION_PAYLOAD_MISMATCH",
      );
    }
    if (runtimeResult.missionId !== mission.missionId || runtimeResult.action !== mission.action) {
      throw new OperatorError(
        "The Runtime result mission/action binding does not match Operator truth.",
        409,
        "OPERATOR_REPLAY_SCOPE_MISMATCH",
      );
    }
  }

  private ledgerContext(missionId: string, updatedAt: string): GenericMissionLedgerContext {
    const mission = this.getMission(missionId);
    const initial = mission.executionJournal[0];
    if (!initial) {
      throw new OperatorError(
        "Runtime mission has no initial execution attempt for ledger lineage.",
        409,
        "MISSION_LEDGER_ATTEMPT_MISSING",
      );
    }
    const approval = mission.executionJournal.find((transition) => transition.newState === "approved");
    const runtimeStarted = mission.executionJournal.some((transition) =>
      transition.newState === "execution_started"
      || transition.newState === "recovery_in_progress");
    return {
      missionId: mission.missionId,
      traceId: mission.traceId,
      attemptId: initial.executionAttemptId,
      startedAt: mission.createdAt,
      updatedAt,
      approvalActor: approval?.actor ?? null,
      approvalTimestamp: approval?.timestamp ?? null,
      runtimeStarted,
    };
  }

  private requireSerializedRuntimeResult(missionId: string): string {
    const row = this.database.prepare(
      "SELECT runtime_result_json FROM operator_missions WHERE mission_id = ?",
    ).get(missionId) as { runtime_result_json: string | null } | undefined;
    if (!row?.runtime_result_json) {
      throw new OperatorError(
        "Runtime mission has no persisted result for completed ledger evidence.",
        409,
        "MISSION_LEDGER_RESULT_MISSING",
      );
    }
    return row.runtime_result_json;
  }

  private assertRecoveryActionAllowed(
    execution: GenericMissionExecutionRecord,
    action: GenericMissionRecoveryAction,
  ): void {
    if (!permittedGenericRecoveryActions(execution).includes(action)) {
      throw new OperatorError(
        `${action} is not accepted from durable state ${execution.currentState}.`,
        409,
        "RECOVERY_ACTION_NOT_PERMITTED",
      );
    }
  }

  private assertContainsNoProtectedValue(values: string[]): void {
    if (
      this.protectedValues.some((protectedValue) =>
        values.some((value) => value.includes(protectedValue)))
    ) {
      throw new OperatorError(
        "Mission input must not contain protected configuration data.",
        400,
      );
    }
  }

  private missionRowBy(column: "mission_id" | "trace_id" | "idempotency_key", value: string): MissionRow | null {
    return (this.database
      .prepare(`SELECT * FROM operator_missions WHERE ${column} = ?`)
      .get(value) as MissionRow | undefined) ?? null;
  }

  private assertExistingCreateBinding(row: MissionRow, input: CanonicalSubmitInput): void {
    const mismatch = (code: string, message: string): never => {
      throw new OperatorError(message, 409, code);
    };
    if (input.idempotencyKey !== row.idempotency_key) {
      mismatch(
        "OPERATOR_IDEMPOTENCY_MISMATCH",
        "The supplied idempotency identity does not match its durable binding.",
      );
    }
    if (input.traceId !== row.trace_id) {
      mismatch(
        "OPERATOR_TRACE_MISMATCH",
        "The supplied trace identity does not match its durable binding.",
      );
    }
    if (
      input.registered.product !== row.product
      || input.registered.action !== row.action
      || input.tenantUserId !== row.tenant_user_id
      || input.workspaceId !== row.workspace_id
      || input.accountId !== row.account_id
      || input.actorId !== row.actor_id
    ) {
      mismatch(
        "OPERATOR_MISSION_SCOPE_MISMATCH",
        "The mission scope does not match its durable binding.",
      );
    }
    if (input.payloadHash !== row.payload_hash) {
      mismatch(
        "OPERATOR_MISSION_PAYLOAD_MISMATCH",
        "The mission is already bound to a different exact payload hash.",
      );
    }
  }

  private assertIdentifiersAvailable(input: CanonicalSubmitInput): void {
    const conflictingTrace = this.missionRowBy("trace_id", input.traceId);
    if (conflictingTrace && conflictingTrace.mission_id !== input.missionId) {
      throw new OperatorError(
        "The supplied trace identity is already bound to another mission.",
        409,
        "OPERATOR_TRACE_MISMATCH",
      );
    }
    const conflictingKey = this.missionRowBy("idempotency_key", input.idempotencyKey);
    if (conflictingKey && conflictingKey.mission_id !== input.missionId) {
      throw new OperatorError(
        "The supplied idempotency identity is already bound to another mission.",
        409,
        "OPERATOR_IDEMPOTENCY_MISMATCH",
      );
    }
  }

  private injectFailure(boundary: GenericMissionFailureBoundary, missionId: string): void {
    this.failureInjector?.(boundary, missionId);
  }
}
