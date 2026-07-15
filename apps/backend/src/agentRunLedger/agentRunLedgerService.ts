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
              payload_hash, scope_hash
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
