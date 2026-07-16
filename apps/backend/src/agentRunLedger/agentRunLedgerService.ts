import type { DatabaseSync } from "node:sqlite";
import {
  AgentRunLedgerReplayMismatchError,
  AgentRunLedgerTransitionError,
  AgentRunLedgerValidationError,
  assertAgentRunLedgerExactReplay,
  assertAgentRunLedgerTransition,
  validateAgentRunLedgerEntry,
  type AgentRunLedgerEntry,
} from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";

const MAX_FILTER_LENGTH = 256;
const MAX_LIMIT = 100;
const CANONICAL_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface AgentRunLedgerFilters {
  product?: string;
  workflow?: string;
  provider?: string;
  model?: string;
  status?: string;
  approvalStatus?: string;
  validationResult?: string;
  outcome?: string;
  from?: string;
  to?: string;
  limit: number;
}

export interface AgentRunLedgerFilterInput {
  product?: unknown;
  workflow?: unknown;
  provider?: unknown;
  model?: unknown;
  status?: unknown;
  approvalStatus?: unknown;
  validationResult?: unknown;
  outcome?: unknown;
  from?: unknown;
  to?: unknown;
  limit?: unknown;
}

export interface AgentRunLedgerRunDetail {
  entry: AgentRunLedgerEntry;
  transitions: AgentRunLedgerEntry[];
}

export interface AgentRunLedgerAppendResult {
  replayed: boolean;
  run: AgentRunLedgerRunDetail;
}

export interface AgentRunLedgerListResult {
  runs: AgentRunLedgerEntry[];
  filters: AgentRunLedgerFilters;
}

interface SummaryBindingRow {
  run_id: string;
  current_event_id: string;
  current_sequence: number;
  product_id: string;
  workflow_id: string;
  agent_id: string;
  attempt_id: string;
  parent_run_id: string | null;
  trace_id: string | null;
  status: string;
  provider: string;
  model: string;
  payload_hash: string;
  scope_hash: string;
  updated_at: string;
}

interface IngestEventRow {
  event_id: string;
  run_id: string;
  sequence: number;
  contract_version: string;
  producer: string;
  mission_id: string | null;
  occurred_at: string;
  received_at: string;
  event_type: string;
  correlation_id: string | null;
  causation_id: string | null;
  payload_hash: string;
  entry_json: string;
  ingest_outcome: "accepted" | "conflicted";
  applied: number;
  applied_at: string | null;
  created_at: string;
}

export interface AgentRunLedgerIngestAppliedResult {
  kind: "applied";
  replayed: boolean;
  run: AgentRunLedgerRunDetail;
}

export interface AgentRunLedgerIngestPendingResult {
  kind: "pending";
  run_id: string;
  event_id: string;
  sequence: number;
  payload_hash: string;
  last_applied_sequence: number;
  last_received_sequence: number;
  gap_state: "open";
}

export type AgentRunLedgerIngestResult =
  | AgentRunLedgerIngestAppliedResult
  | AgentRunLedgerIngestPendingResult;

export interface AgentRunLedgerIngestProjection {
  run_id: string;
  last_applied_sequence: number;
  last_received_sequence: number;
  gap_state: "open" | "closed";
  conflict_state: "none" | "conflicted";
  run_status: string | null;
  latest_event_type: string | null;
  updated_at: string | null;
}

interface TransitionBindingRow {
  event_id: string;
  run_id: string;
  sequence: number;
  attempt_id: string;
  product_id: string;
  workflow_id: string;
  agent_id: string;
  provider: string;
  model: string;
  status: string;
  payload_hash: string;
  scope_hash: string;
}

interface JsonRow {
  entry_json: string;
}

function containsProtectedValue(
  value: unknown,
  protectedValues: readonly string[],
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") {
    return protectedValues.some((protectedValue) => value.includes(protectedValue));
  }
  if (value === null || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((item) => containsProtectedValue(item, protectedValues, seen));
  }
  return Object.entries(value).some(([key, item]) =>
    containsProtectedValue(key, protectedValues, seen)
    || containsProtectedValue(item, protectedValues, seen),
  );
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function requiredExactFilter(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (
    typeof value !== "string"
    || value.length > MAX_FILTER_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new OperatorError(`${name} must be an exact nonblank string of at most ${MAX_FILTER_LENGTH} characters.`, 400, "AGENT_RUN_LEDGER_FILTER_INVALID");
  }
  return value;
}

function canonicalDate(value: unknown, name: "from" | "to"): string | undefined {
  const candidate = requiredExactFilter(value, name);
  if (candidate === undefined) return undefined;
  if (!CANONICAL_ISO_PATTERN.test(candidate) || Number.isNaN(Date.parse(candidate))) {
    throw new OperatorError(`${name} must be a canonical UTC ISO-8601 timestamp.`, 400, "AGENT_RUN_LEDGER_DATE_FILTER_INVALID");
  }
  return candidate;
}

function normalizeFilters(input: AgentRunLedgerFilterInput): AgentRunLedgerFilters {
  const parsedLimit = input.limit === undefined || input.limit === ""
    ? 50
    : Number(input.limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
    throw new OperatorError("limit must be a positive integer.", 400, "AGENT_RUN_LEDGER_FILTER_INVALID");
  }
  const filters: AgentRunLedgerFilters = {
    limit: Math.min(parsedLimit, MAX_LIMIT),
  };
  const values = {
    product: requiredExactFilter(input.product, "product"),
    workflow: requiredExactFilter(input.workflow, "workflow"),
    provider: requiredExactFilter(input.provider, "provider"),
    model: requiredExactFilter(input.model, "model"),
    status: requiredExactFilter(input.status, "status"),
    approvalStatus: requiredExactFilter(input.approvalStatus, "approvalStatus"),
    validationResult: requiredExactFilter(input.validationResult, "validationResult"),
    outcome: requiredExactFilter(input.outcome, "outcome"),
    from: canonicalDate(input.from, "from"),
    to: canonicalDate(input.to, "to"),
  };
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) Object.assign(filters, { [key]: value });
  }
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new OperatorError("from must not be later than to.", 400, "AGENT_RUN_LEDGER_DATE_FILTER_INVALID");
  }
  return filters;
}

function translateContractError(error: unknown): never {
  if (error instanceof AgentRunLedgerValidationError) {
    throw new OperatorError(error.message, 400, error.code);
  }
  if (
    error instanceof AgentRunLedgerTransitionError
    || error instanceof AgentRunLedgerReplayMismatchError
  ) {
    throw new OperatorError(error.message, 409, error.code);
  }
  throw error;
}

function parseStoredEntry(value: string): AgentRunLedgerEntry {
  try {
    return validateAgentRunLedgerEntry(JSON.parse(value) as unknown);
  } catch {
    throw new OperatorError(
      "A stored Agent Run Ledger entry failed canonical validation.",
      500,
      "AGENT_RUN_LEDGER_STORED_ENTRY_INVALID",
    );
  }
}

function scopeMatches(row: SummaryBindingRow | TransitionBindingRow, entry: AgentRunLedgerEntry): boolean {
  return row.run_id === entry.run_id
    && row.product_id === entry.product_id
    && row.workflow_id === entry.workflow_id
    && row.agent_id === entry.agent_id
    && row.attempt_id === entry.attempt_id
    && row.provider === entry.provider
    && row.model === entry.model
    && row.scope_hash === entry.scope_hash;
}

function assertSummaryScope(row: SummaryBindingRow, entry: AgentRunLedgerEntry): void {
  if (
    !scopeMatches(row, entry)
    || row.parent_run_id !== entry.parent_run_id
    || row.trace_id !== entry.trace_id
  ) {
    throw new OperatorError(
      "The Agent Run Ledger write does not match the durable run scope.",
      409,
      "AGENT_RUN_LEDGER_SCOPE_MISMATCH",
    );
  }
}

function assertTransitionBinding(row: TransitionBindingRow, entry: AgentRunLedgerEntry): void {
  if (
    row.event_id !== entry.event_id
    || Number(row.sequence) !== entry.sequence
    || row.status !== entry.status
  ) {
    throw new OperatorError(
      "The Agent Run Ledger event identifier does not match its durable binding.",
      409,
      "AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH",
    );
  }
  if (!scopeMatches(row, entry)) {
    throw new OperatorError(
      "The Agent Run Ledger write does not match the durable transition scope.",
      409,
      "AGENT_RUN_LEDGER_SCOPE_MISMATCH",
    );
  }
  if (row.payload_hash !== entry.payload_hash) {
    throw new OperatorError(
      "The Agent Run Ledger payload does not match the durable transition payload.",
      409,
      "AGENT_RUN_LEDGER_PAYLOAD_MISMATCH",
    );
  }
}

export class AgentRunLedgerService {
  private readonly protectedValues: string[];

  constructor(
    private readonly database: DatabaseSync,
    protectedValues: readonly string[] = [],
  ) {
    this.protectedValues = protectedValues.map((value) => value.trim()).filter(Boolean);
  }

  appendEntry(value: unknown): AgentRunLedgerAppendResult {
    if (containsProtectedValue(value, this.protectedValues)) {
      throw new OperatorError(
        "Agent Run Ledger entries must not contain protected configuration data.",
        400,
        "AGENT_RUN_LEDGER_PROTECTED_VALUE",
      );
    }
    let entry: AgentRunLedgerEntry;
    try {
      entry = validateAgentRunLedgerEntry(value);
    } catch (error) {
      translateContractError(error);
    }

    try {
      if (this.database.isTransaction) return this.appendValidatedEntry(entry);
      return withTransaction(this.database, () => this.appendValidatedEntry(entry));
    } catch (error) {
      translateContractError(error);
    }
  }

  /**
   * Phase 2B2 durable ingest: every event is durably received (idempotent by
   * event_id, conflict-checked by payload_hash) before the unmodified
   * `appendEntry` ordered-application path ever sees it. A strictly future
   * sequence is held pending rather than rejected, and closes automatically
   * once the missing predecessor arrives.
   */
  ingestEntry(value: unknown): AgentRunLedgerIngestResult {
    if (containsProtectedValue(value, this.protectedValues)) {
      throw new OperatorError(
        "Agent Run Ledger entries must not contain protected configuration data.",
        400,
        "AGENT_RUN_LEDGER_PROTECTED_VALUE",
      );
    }
    let entry: AgentRunLedgerEntry;
    try {
      entry = validateAgentRunLedgerEntry(value);
    } catch (error) {
      translateContractError(error);
    }

    // Conflict evidence must durably persist even though this request then
    // fails, so it is detected and committed in its own step before the
    // typed error is ever thrown (a rollback later must not erase it).
    const conflict = this.database.isTransaction
      ? this.detectAndRecordIngestConflict(entry)
      : withTransaction(this.database, () => this.detectAndRecordIngestConflict(entry));
    if (conflict) {
      throw new OperatorError(conflict.message, 409, conflict.code);
    }

    try {
      if (this.database.isTransaction) return this.ingestValidatedEntry(entry);
      return withTransaction(this.database, () => this.ingestValidatedEntry(entry));
    } catch (error) {
      translateContractError(error);
    }
  }

  getIngestProjection(runId: string): AgentRunLedgerIngestProjection {
    if (!runId || runId.length > 256 || containsControlCharacter(runId)) {
      throw new OperatorError("runId must be an exact nonblank identifier.", 400, "AGENT_RUN_LEDGER_RUN_ID_INVALID");
    }
    const summary = this.getSummaryBinding(runId);
    const latest = this.database.prepare(
      `SELECT event_type, received_at FROM agent_run_ledger_ingest_events
        WHERE run_id = ? AND ingest_outcome = 'accepted'
        ORDER BY sequence DESC LIMIT 1`,
    ).get(runId) as { event_type: string; received_at: string } | undefined;
    if (!summary && !latest) {
      throw new OperatorError("Agent Run Ledger run was not found.", 404, "AGENT_RUN_LEDGER_RUN_NOT_FOUND");
    }
    const lastApplied = summary ? Number(summary.current_sequence) : 0;
    const lastReceived = this.getLastReceivedSequence(runId);
    const conflictRow = this.database.prepare(
      `SELECT 1 AS present FROM agent_run_ledger_ingest_events
        WHERE run_id = ? AND ingest_outcome = 'conflicted' LIMIT 1`,
    ).get(runId) as { present: number } | undefined;
    const updatedCandidates = [summary?.updated_at, latest?.received_at].filter(
      (candidate): candidate is string => typeof candidate === "string",
    );
    return {
      run_id: runId,
      last_applied_sequence: lastApplied,
      last_received_sequence: lastReceived,
      gap_state: lastReceived > lastApplied ? "open" : "closed",
      conflict_state: conflictRow ? "conflicted" : "none",
      run_status: summary?.status ?? null,
      latest_event_type: latest?.event_type ?? null,
      updated_at: updatedCandidates.length > 0 ? updatedCandidates.sort().at(-1)! : null,
    };
  }

  /**
   * Returns a typed conflict descriptor (and durably records the conflicting
   * receipt as evidence) without throwing, so the caller can commit the
   * evidence in its own transaction before deciding whether to throw.
   */
  private detectAndRecordIngestConflict(
    entry: AgentRunLedgerEntry,
  ): { code: string; message: string } | null {
    const existingByEvent = this.getIngestEventByEventId(entry.event_id);
    if (existingByEvent) {
      if (existingByEvent.payload_hash !== entry.payload_hash) {
        this.insertIngestEvent(entry, "conflicted");
        return {
          code: "AGENT_RUN_LEDGER_INGEST_EVENT_CONFLICT",
          message: "The Agent Run Ledger event identifier is already durably received with a different payload.",
        };
      }
      return null;
    }
    const slotOwner = this.getIngestEventBySequence(entry.run_id, entry.sequence);
    if (slotOwner && slotOwner.event_id !== entry.event_id) {
      this.insertIngestEvent(entry, "conflicted");
      return {
        code: "AGENT_RUN_LEDGER_INGEST_SEQUENCE_CONFLICT",
        message: "The Agent Run Ledger sequence is already durably received under another event identifier.",
      };
    }
    return null;
  }

  private ingestValidatedEntry(entry: AgentRunLedgerEntry): AgentRunLedgerIngestResult {
    if (!this.getIngestEventByEventId(entry.event_id)) {
      this.insertIngestEvent(entry, "accepted");
    }

    const summary = this.getSummaryBinding(entry.run_id);
    const expectedNext = summary ? Number(summary.current_sequence) + 1 : 1;

    if (entry.sequence <= expectedNext) {
      const applied = this.appendEntry(entry);
      this.markIngestApplied(entry.event_id);
      this.drainRun(entry.run_id);
      return { kind: "applied", replayed: applied.replayed, run: applied.run };
    }

    return this.pendingResult(entry);
  }

  private drainRun(runId: string): void {
    for (;;) {
      const summary = this.getSummaryBinding(runId);
      const nextSequence = summary ? Number(summary.current_sequence) + 1 : 1;
      const pending = this.getPendingIngestEvent(runId, nextSequence);
      if (!pending) return;
      const entry = parseStoredEntry(pending.entry_json);
      this.appendEntry(entry);
      this.markIngestApplied(entry.event_id);
    }
  }

  private pendingResult(entry: AgentRunLedgerEntry): AgentRunLedgerIngestPendingResult {
    const summary = this.getSummaryBinding(entry.run_id);
    return {
      kind: "pending",
      run_id: entry.run_id,
      event_id: entry.event_id,
      sequence: entry.sequence,
      payload_hash: entry.payload_hash,
      last_applied_sequence: summary ? Number(summary.current_sequence) : 0,
      last_received_sequence: this.getLastReceivedSequence(entry.run_id),
      gap_state: "open",
    };
  }

  private getLastReceivedSequence(runId: string): number {
    const row = this.database.prepare(
      `SELECT MAX(sequence) AS max_sequence FROM agent_run_ledger_ingest_events
        WHERE run_id = ? AND ingest_outcome = 'accepted'`,
    ).get(runId) as { max_sequence: number | null } | undefined;
    return row?.max_sequence ?? 0;
  }

  private getIngestEventByEventId(eventId: string): IngestEventRow | null {
    return (this.database.prepare(
      `SELECT * FROM agent_run_ledger_ingest_events WHERE event_id = ? AND ingest_outcome = 'accepted'`,
    ).get(eventId) as IngestEventRow | undefined) ?? null;
  }

  private getIngestEventBySequence(runId: string, sequence: number): IngestEventRow | null {
    return (this.database.prepare(
      `SELECT * FROM agent_run_ledger_ingest_events WHERE run_id = ? AND sequence = ? AND ingest_outcome = 'accepted'`,
    ).get(runId, sequence) as IngestEventRow | undefined) ?? null;
  }

  private getPendingIngestEvent(runId: string, sequence: number): IngestEventRow | null {
    return (this.database.prepare(
      `SELECT * FROM agent_run_ledger_ingest_events
        WHERE run_id = ? AND sequence = ? AND ingest_outcome = 'accepted' AND applied = 0`,
    ).get(runId, sequence) as IngestEventRow | undefined) ?? null;
  }

  private markIngestApplied(eventId: string): void {
    this.database.prepare(
      `UPDATE agent_run_ledger_ingest_events SET applied = 1, applied_at = ?
         WHERE event_id = ? AND ingest_outcome = 'accepted'`,
    ).run(nowIso(), eventId);
  }

  private insertIngestEvent(entry: AgentRunLedgerEntry, outcome: "accepted" | "conflicted"): void {
    const receivedAt = nowIso();
    const causationId = outcome === "accepted"
      ? this.getIngestEventBySequence(entry.run_id, entry.sequence - 1)?.event_id ?? null
      : null;
    this.database.prepare(
      `INSERT INTO agent_run_ledger_ingest_events (
        event_id, run_id, sequence, contract_version, producer, mission_id,
        occurred_at, received_at, event_type, correlation_id, causation_id,
        payload_hash, entry_json, ingest_outcome, applied, applied_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
    ).run(
      entry.event_id,
      entry.run_id,
      entry.sequence,
      entry.schema_version,
      entry.source_subsystem,
      null,
      entry.updated_at,
      receivedAt,
      entry.status,
      entry.trace_id,
      causationId,
      entry.payload_hash,
      JSON.stringify(entry),
      outcome,
      receivedAt,
    );
  }

  getRun(runId: string): AgentRunLedgerRunDetail {
    if (!runId || runId.length > 256 || /[\u0000-\u001f\u007f]/.test(runId)) {
      throw new OperatorError("runId must be an exact nonblank identifier.", 400, "AGENT_RUN_LEDGER_RUN_ID_INVALID");
    }
    if (this.database.isTransaction) return this.readRun(runId);
    this.database.exec("BEGIN;");
    try {
      const result = this.readRun(runId);
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try { this.database.exec("ROLLBACK;"); } catch { /* transaction already closed */ }
      throw error;
    }
  }

  private readRun(runId: string): AgentRunLedgerRunDetail {
    const summary = this.database
      .prepare("SELECT entry_json FROM agent_run_ledger_runs WHERE run_id = ?")
      .get(runId) as JsonRow | undefined;
    if (!summary) {
      throw new OperatorError("Agent Run Ledger run was not found.", 404, "AGENT_RUN_LEDGER_RUN_NOT_FOUND");
    }
    const transitions = this.database
      .prepare("SELECT entry_json FROM agent_run_ledger_transitions WHERE run_id = ? ORDER BY sequence ASC")
      .all(runId) as unknown as JsonRow[];
    return {
      entry: parseStoredEntry(summary.entry_json),
      transitions: transitions.map((row) => parseStoredEntry(row.entry_json)),
    };
  }

  listRuns(input: AgentRunLedgerFilterInput = {}): AgentRunLedgerListResult {
    const filters = normalizeFilters(input);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (column: string, value: string | undefined, operator = "=") => {
      if (value === undefined) return;
      clauses.push(`${column} ${operator} ?`);
      parameters.push(value);
    };
    add("product_id", filters.product);
    add("workflow_id", filters.workflow);
    add("provider", filters.provider);
    add("model", filters.model);
    add("status", filters.status);
    add("approval_status", filters.approvalStatus);
    add("validation_result", filters.validationResult);
    add("outcome", filters.outcome);
    add("started_at", filters.from, ">=");
    add("started_at", filters.to, "<=");
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    parameters.push(filters.limit);
    const rows = this.database
      .prepare(`SELECT entry_json FROM agent_run_ledger_runs${where} ORDER BY started_at DESC, run_id ASC LIMIT ?`)
      .all(...parameters) as unknown as JsonRow[];
    return {
      runs: rows.map((row) => parseStoredEntry(row.entry_json)),
      filters,
    };
  }

  private appendValidatedEntry(entry: AgentRunLedgerEntry): AgentRunLedgerAppendResult {
    const summary = this.getSummaryBinding(entry.run_id);
    if (summary) assertSummaryScope(summary, entry);

    const eventBinding = this.getTransitionByEvent(entry.event_id);
    if (eventBinding) {
      if (eventBinding.run_id !== entry.run_id) {
        throw new OperatorError(
          "The Agent Run Ledger event identifier is already bound to another run.",
          409,
          "AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH",
        );
      }
      assertTransitionBinding(eventBinding, entry);
      const existing = this.requireTransitionEntry(entry.event_id);
      assertAgentRunLedgerExactReplay(existing, entry);
      return { replayed: true, run: this.getRun(entry.run_id) };
    }

    const sequenceBinding = this.getTransitionBySequence(entry.run_id, entry.sequence);
    if (sequenceBinding) {
      assertTransitionBinding(sequenceBinding, entry);
      throw new OperatorError(
        "The Agent Run Ledger sequence is already bound to another event identifier.",
        409,
        "AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH",
      );
    }

    if (!summary) {
      assertAgentRunLedgerTransition(null, entry);
      this.insertSummary(entry);
      this.insertTransition(entry);
      return { replayed: false, run: this.getRun(entry.run_id) };
    }

    if (entry.sequence !== Number(summary.current_sequence) + 1) {
      throw new OperatorError(
        "The Agent Run Ledger sequence must append exactly after the durable current sequence.",
        409,
        "AGENT_RUN_LEDGER_SEQUENCE_MISMATCH",
      );
    }
    const current = this.requireTransitionEntry(summary.current_event_id);
    assertAgentRunLedgerTransition(current, entry);
    this.updateSummary(entry, Number(summary.current_sequence));
    this.insertTransition(entry);
    return { replayed: false, run: this.getRun(entry.run_id) };
  }

  private getSummaryBinding(runId: string): SummaryBindingRow | null {
    return (this.database.prepare(
      `SELECT run_id, current_event_id, current_sequence, product_id, workflow_id,
              agent_id, attempt_id, parent_run_id, trace_id, status, provider, model,
              payload_hash, scope_hash, updated_at
         FROM agent_run_ledger_runs WHERE run_id = ?`,
    ).get(runId) as SummaryBindingRow | undefined) ?? null;
  }

  private getTransitionByEvent(eventId: string): TransitionBindingRow | null {
    return (this.database.prepare(
      `SELECT event_id, run_id, sequence, attempt_id, product_id, workflow_id,
              agent_id, provider, model, status, payload_hash, scope_hash
         FROM agent_run_ledger_transitions WHERE event_id = ?`,
    ).get(eventId) as TransitionBindingRow | undefined) ?? null;
  }

  private getTransitionBySequence(runId: string, sequence: number): TransitionBindingRow | null {
    return (this.database.prepare(
      `SELECT event_id, run_id, sequence, attempt_id, product_id, workflow_id,
              agent_id, provider, model, status, payload_hash, scope_hash
         FROM agent_run_ledger_transitions WHERE run_id = ? AND sequence = ?`,
    ).get(runId, sequence) as TransitionBindingRow | undefined) ?? null;
  }

  private requireTransitionEntry(eventId: string): AgentRunLedgerEntry {
    const row = this.database
      .prepare("SELECT entry_json FROM agent_run_ledger_transitions WHERE event_id = ?")
      .get(eventId) as JsonRow | undefined;
    if (!row) {
      throw new OperatorError(
        "The Agent Run Ledger summary references a missing transition.",
        500,
        "AGENT_RUN_LEDGER_TRANSITION_MISSING",
      );
    }
    return parseStoredEntry(row.entry_json);
  }

  private insertSummary(entry: AgentRunLedgerEntry): void {
    this.database.prepare(
      `INSERT INTO agent_run_ledger_runs (
        run_id, schema_version, current_event_id, current_sequence,
        product_id, workflow_id, agent_id, attempt_id, parent_run_id, trace_id,
        status, outcome, started_at, completed_at, provider, model,
        approval_status, validation_result, failure_reason, failure_code,
        evidence_count, evidence_integrity_status, production_impact,
        payload_hash, scope_hash, entry_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(...this.summaryValues(entry));
  }

  private updateSummary(entry: AgentRunLedgerEntry, expectedSequence: number): void {
    const values = this.summaryValues(entry);
    const result = this.database.prepare(
      `UPDATE agent_run_ledger_runs SET
        schema_version = ?, current_event_id = ?, current_sequence = ?,
        product_id = ?, workflow_id = ?, agent_id = ?, attempt_id = ?,
        parent_run_id = ?, trace_id = ?, status = ?, outcome = ?, started_at = ?,
        completed_at = ?, provider = ?, model = ?, approval_status = ?,
        validation_result = ?, failure_reason = ?, failure_code = ?,
        evidence_count = ?, evidence_integrity_status = ?, production_impact = ?,
        payload_hash = ?, scope_hash = ?, entry_json = ?, created_at = ?, updated_at = ?
       WHERE run_id = ? AND current_sequence = ?`,
    ).run(...values.slice(1), entry.run_id, expectedSequence);
    if (Number(result.changes) !== 1) {
      throw new OperatorError(
        "The Agent Run Ledger changed before the transition could be materialized.",
        409,
        "AGENT_RUN_LEDGER_CONCURRENT_TRANSITION",
      );
    }
  }

  private summaryValues(entry: AgentRunLedgerEntry): Array<string | number | null> {
    return [
      entry.run_id,
      entry.schema_version,
      entry.event_id,
      entry.sequence,
      entry.product_id,
      entry.workflow_id,
      entry.agent_id,
      entry.attempt_id,
      entry.parent_run_id,
      entry.trace_id,
      entry.status,
      entry.outcome,
      entry.started_at,
      entry.completed_at,
      entry.provider,
      entry.model,
      entry.approval_status,
      entry.validation_result,
      entry.failure_reason,
      entry.failure_code,
      entry.evidence_count,
      entry.evidence_integrity_status,
      entry.production_impact ? 1 : 0,
      entry.payload_hash,
      entry.scope_hash,
      JSON.stringify(entry),
      entry.created_at,
      entry.updated_at,
    ];
  }

  private insertTransition(entry: AgentRunLedgerEntry): void {
    this.database.prepare(
      `INSERT INTO agent_run_ledger_transitions (
        event_id, run_id, sequence, attempt_id, product_id, workflow_id,
        agent_id, provider, model, status, outcome, payload_hash, scope_hash,
        entry_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.event_id,
      entry.run_id,
      entry.sequence,
      entry.attempt_id,
      entry.product_id,
      entry.workflow_id,
      entry.agent_id,
      entry.provider,
      entry.model,
      entry.status,
      entry.outcome,
      entry.payload_hash,
      entry.scope_hash,
      JSON.stringify(entry),
      entry.created_at,
      entry.updated_at,
    );
  }
}
