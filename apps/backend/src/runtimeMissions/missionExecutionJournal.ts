import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OperatorError } from "../services/operatorService.js";

export type MissionExecutionState =
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

export type MissionReconciliationOutcome =
  | "not_started"
  | "not_found"
  | "unique"
  | "conflict"
  | "unavailable"
  | "scope_mismatch"
  | "idempotency_mismatch"
  | "payload_mismatch"
  | "invalid";

export interface MissionTypedError {
  code: string;
  message: string;
}

export interface MissionExecutionRecord {
  missionId: string;
  executionAttemptId: string;
  missionPayloadHash: string;
  downstreamOperationType: "autoposter.queue.create_unapproved_draft";
  currentState: MissionExecutionState;
  lastConfirmedBoundary: MissionExecutionState;
  recoveryReason: string;
  recoveryClassification: string;
  reconciliationOutcome: MissionReconciliationOutcome;
  downstreamQueueId: string | null;
  finalResultStatus: string | null;
  retryCount: number;
  typedError: MissionTypedError | null;
  reconciliationResult: unknown | null;
  runtimeObservation: unknown | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionJournalTransition {
  transitionId: string;
  missionId: string;
  sequence: number;
  executionAttemptId: string;
  idempotencyKey: string;
  action: "autoposter.post.schedule";
  workspaceId: string;
  provider: "tiktok" | "youtube";
  accountId: string;
  previousState: MissionExecutionState | null;
  newState: MissionExecutionState;
  timestamp: string;
  actor: string;
  reason: string;
  evidenceReferences: string[];
  typedError: MissionTypedError | null;
}

interface ExecutionRow {
  mission_id: string;
  execution_attempt_id: string;
  mission_payload_hash: string;
  downstream_operation_type: "autoposter.queue.create_unapproved_draft";
  current_state: MissionExecutionState;
  last_confirmed_boundary: MissionExecutionState;
  recovery_reason: string;
  recovery_classification: string;
  reconciliation_outcome: MissionReconciliationOutcome;
  downstream_queue_id: string | null;
  final_result_status: string | null;
  retry_count: number;
  typed_error_json: string | null;
  reconciliation_result_json: string | null;
  runtime_observation_json: string | null;
  created_at: string;
  updated_at: string;
}

interface JournalRow {
  transition_id: string;
  mission_id: string;
  sequence: number;
  execution_attempt_id: string;
  idempotency_key: string;
  action: "autoposter.post.schedule";
  workspace_id: string;
  provider: "tiktok" | "youtube";
  account_id: string;
  previous_state: MissionExecutionState | null;
  new_state: MissionExecutionState;
  timestamp: string;
  actor: string;
  reason: string;
  evidence_refs_json: string;
  typed_error_json: string | null;
}

interface MissionScopeRow {
  mission_id: string;
  idempotency_key: string;
  action: "autoposter.post.schedule";
  workspace_id: string;
  provider: "tiktok" | "youtube";
  account_id: string;
}

const allowedTransitions = new Map<MissionExecutionState, ReadonlySet<MissionExecutionState>>([
  ["approval_required", new Set(["approved", "failed_terminal"])],
  ["approved", new Set(["execution_started", "failed_terminal"])],
  ["execution_started", new Set(["downstream_request_prepared", "failed_recoverable", "failed_terminal"])],
  ["downstream_request_prepared", new Set(["downstream_result_observed", "failed_recoverable", "failed_terminal", "recovery_in_progress"])],
  ["downstream_result_observed", new Set(["result_persisted", "failed_recoverable", "failed_terminal", "reconciliation_required", "recovery_in_progress"])],
  ["result_persisted", new Set(["completed"])],
  ["completed", new Set(["completed"])],
  ["failed_recoverable", new Set(["recovery_in_progress", "failed_terminal"])],
  ["recovery_in_progress", new Set(["downstream_request_prepared", "downstream_result_observed", "failed_recoverable", "failed_terminal", "reconciliation_required"])],
  ["reconciliation_required", new Set(["failed_terminal"])],
  ["failed_terminal", new Set()],
]);

function parseJson<T>(value: string | null): T | null {
  return value ? JSON.parse(value) as T : null;
}

function mapExecution(row: ExecutionRow): MissionExecutionRecord {
  return {
    missionId: row.mission_id,
    executionAttemptId: row.execution_attempt_id,
    missionPayloadHash: row.mission_payload_hash,
    downstreamOperationType: row.downstream_operation_type,
    currentState: row.current_state,
    lastConfirmedBoundary: row.last_confirmed_boundary,
    recoveryReason: row.recovery_reason,
    recoveryClassification: row.recovery_classification,
    reconciliationOutcome: row.reconciliation_outcome,
    downstreamQueueId: row.downstream_queue_id,
    finalResultStatus: row.final_result_status,
    retryCount: Number(row.retry_count),
    typedError: parseJson<MissionTypedError>(row.typed_error_json),
    reconciliationResult: parseJson(row.reconciliation_result_json),
    runtimeObservation: parseJson(row.runtime_observation_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTransition(row: JournalRow): MissionJournalTransition {
  return {
    transitionId: row.transition_id,
    missionId: row.mission_id,
    sequence: Number(row.sequence),
    executionAttemptId: row.execution_attempt_id,
    idempotencyKey: row.idempotency_key,
    action: row.action,
    workspaceId: row.workspace_id,
    provider: row.provider,
    accountId: row.account_id,
    previousState: row.previous_state,
    newState: row.new_state,
    timestamp: row.timestamp,
    actor: row.actor,
    reason: row.reason,
    evidenceReferences: JSON.parse(row.evidence_refs_json) as string[],
    typedError: parseJson<MissionTypedError>(row.typed_error_json),
  };
}

interface InitializeInput {
  missionId: string;
  executionAttemptId: string;
  missionPayloadHash: string;
  timestamp: string;
  actor: string;
}

interface TransitionOptions {
  actor: string;
  reason: string;
  timestamp: string;
  executionAttemptId?: string;
  lastConfirmedBoundary?: MissionExecutionState;
  recoveryReason?: string;
  recoveryClassification?: string;
  reconciliationOutcome?: MissionReconciliationOutcome;
  downstreamQueueId?: string | null;
  finalResultStatus?: string | null;
  retryCount?: number;
  typedError?: MissionTypedError | null;
  reconciliationResult?: unknown | null;
  runtimeObservation?: unknown | null;
  evidenceReferences?: string[];
}

export class MissionExecutionJournal {
  constructor(
    private readonly database: DatabaseSync,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  initialize(input: InitializeInput): MissionExecutionRecord {
    return this.withSavepoint(() => {
      this.database.prepare(
        `INSERT INTO autoposter_mission_executions (
          mission_id, execution_attempt_id, mission_payload_hash,
          downstream_operation_type, current_state, last_confirmed_boundary,
          created_at, updated_at
        ) VALUES (?, ?, ?, 'autoposter.queue.create_unapproved_draft',
          'approval_required', 'approval_required', ?, ?)`,
      ).run(
        input.missionId,
        input.executionAttemptId,
        input.missionPayloadHash,
        input.timestamp,
        input.timestamp,
      );
      this.insertTransition(input.missionId, null, "approval_required", {
        actor: input.actor,
        reason: "Mission persisted and explicit human approval is required.",
        timestamp: input.timestamp,
        evidenceReferences: [`mission:${input.missionId}`],
      });
      return this.requireExecution(input.missionId);
    });
  }

  getExecution(missionId: string): MissionExecutionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM autoposter_mission_executions WHERE mission_id = ?")
      .get(missionId) as ExecutionRow | undefined;
    return row ? mapExecution(row) : null;
  }

  requireExecution(missionId: string): MissionExecutionRecord {
    const execution = this.getExecution(missionId);
    if (!execution) {
      throw new OperatorError(
        "Runtime mission has no durable execution journal.",
        409,
        "MISSION_JOURNAL_MISSING",
      );
    }
    return execution;
  }

  listTransitions(missionId: string): MissionJournalTransition[] {
    return this.database
      .prepare("SELECT * FROM autoposter_mission_journal WHERE mission_id = ? ORDER BY sequence ASC")
      .all(missionId)
      .map((row) => mapTransition(row as unknown as JournalRow));
  }

  transition(
    missionId: string,
    newState: MissionExecutionState,
    options: TransitionOptions,
  ): MissionExecutionRecord {
    const current = this.requireExecution(missionId);
    if (!allowedTransitions.get(current.currentState)?.has(newState)) {
      throw new OperatorError(
        `Invalid durable mission transition ${current.currentState} -> ${newState}.`,
        409,
        "INVALID_MISSION_JOURNAL_TRANSITION",
      );
    }
    const next: MissionExecutionRecord = {
      ...current,
      currentState: newState,
      executionAttemptId: options.executionAttemptId ?? current.executionAttemptId,
      lastConfirmedBoundary: options.lastConfirmedBoundary ?? newState,
      recoveryReason: options.recoveryReason ?? current.recoveryReason,
      recoveryClassification:
        options.recoveryClassification ?? current.recoveryClassification,
      reconciliationOutcome:
        options.reconciliationOutcome ?? current.reconciliationOutcome,
      downstreamQueueId:
        options.downstreamQueueId === undefined
          ? current.downstreamQueueId
          : options.downstreamQueueId,
      finalResultStatus:
        options.finalResultStatus === undefined
          ? current.finalResultStatus
          : options.finalResultStatus,
      retryCount: options.retryCount ?? current.retryCount,
      typedError:
        options.typedError === undefined ? current.typedError : options.typedError,
      reconciliationResult:
        options.reconciliationResult === undefined
          ? current.reconciliationResult
          : options.reconciliationResult,
      runtimeObservation:
        options.runtimeObservation === undefined
          ? current.runtimeObservation
          : options.runtimeObservation,
      updatedAt: options.timestamp,
    };
    return this.withSavepoint(() => {
      const update = this.database.prepare(
        `UPDATE autoposter_mission_executions SET
          execution_attempt_id = ?, current_state = ?, last_confirmed_boundary = ?,
          recovery_reason = ?, recovery_classification = ?, reconciliation_outcome = ?,
          downstream_queue_id = ?, final_result_status = ?, retry_count = ?,
          typed_error_json = ?, reconciliation_result_json = ?, runtime_observation_json = ?,
          updated_at = ?
         WHERE mission_id = ? AND current_state = ?`,
      ).run(
        next.executionAttemptId,
        next.currentState,
        next.lastConfirmedBoundary,
        next.recoveryReason,
        next.recoveryClassification,
        next.reconciliationOutcome,
        next.downstreamQueueId,
        next.finalResultStatus,
        next.retryCount,
        next.typedError ? JSON.stringify(next.typedError) : null,
        next.reconciliationResult === null ? null : JSON.stringify(next.reconciliationResult),
        next.runtimeObservation === null ? null : JSON.stringify(next.runtimeObservation),
        next.updatedAt,
        missionId,
        current.currentState,
      );
      if (Number(update.changes) !== 1) {
        throw new OperatorError(
          "Durable mission state changed before the transition could be recorded.",
          409,
          "MISSION_JOURNAL_CONCURRENT_TRANSITION",
        );
      }
      this.insertTransition(missionId, current.currentState, newState, options);
      return this.requireExecution(missionId);
    });
  }

  private withSavepoint<T>(operation: () => T): T {
    this.database.exec("SAVEPOINT mission_journal_atomic");
    try {
      const result = operation();
      this.database.exec("RELEASE SAVEPOINT mission_journal_atomic");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT mission_journal_atomic");
      this.database.exec("RELEASE SAVEPOINT mission_journal_atomic");
      throw error;
    }
  }

  private insertTransition(
    missionId: string,
    previousState: MissionExecutionState | null,
    newState: MissionExecutionState,
    options: TransitionOptions,
  ): void {
    const scope = this.database
      .prepare(
        `SELECT mission_id, idempotency_key, action, workspace_id, provider, account_id
           FROM autoposter_runtime_missions WHERE mission_id = ?`,
      )
      .get(missionId) as MissionScopeRow | undefined;
    if (!scope) throw new OperatorError("Runtime mission was not found.", 404);
    const execution = this.requireExecution(missionId);
    const sequenceRow = this.database
      .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM autoposter_mission_journal WHERE mission_id = ?")
      .get(missionId) as { next_sequence: number };
    this.database.prepare(
      `INSERT INTO autoposter_mission_journal (
        transition_id, mission_id, sequence, execution_attempt_id,
        idempotency_key, action, workspace_id, provider, account_id,
        previous_state, new_state, timestamp, actor, reason,
        evidence_refs_json, typed_error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      this.idFactory(),
      missionId,
      Number(sequenceRow.next_sequence),
      execution.executionAttemptId,
      scope.idempotency_key,
      scope.action,
      scope.workspace_id,
      scope.provider,
      scope.account_id,
      previousState,
      newState,
      options.timestamp,
      options.actor,
      options.reason,
      JSON.stringify(options.evidenceReferences ?? []),
      options.typedError ? JSON.stringify(options.typedError) : null,
    );
  }
}
