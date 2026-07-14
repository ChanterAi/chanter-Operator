import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentRunLedgerEntry,
  type AgentRunLedgerEntry,
} from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../src/agentRunLedger/agentRunLedgerService.js";
import { createApp } from "../src/app.js";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { OperatorError, OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

type LedgerDraft = Parameters<typeof createAgentRunLedgerEntry>[0];

const RUN_ID = "lg-controlled-run-001";
const STARTED_AT = "2026-07-14T10:00:00.000Z";
const APPROVED_AT = "2026-07-14T10:02:00.000Z";

function isoMinute(minute: number): string {
  return `2026-07-14T10:${String(minute).padStart(2, "0")}:00.000Z`;
}

function buildEntry(
  sequence: number,
  status: AgentRunLedgerEntry["status"],
  overrides: Partial<LedgerDraft> = {},
): AgentRunLedgerEntry {
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  const completed = status === "completed";
  const failed = status === "failed";
  return createAgentRunLedgerEntry({
    schema_version: "1.0",
    run_id: RUN_ID,
    event_id: `${RUN_ID}:event:${sequence}`,
    sequence,
    product_id: "loop_governor",
    workflow_id: "controlled_p0",
    agent_id: "loop-governor-local",
    attempt_id: `${RUN_ID}:attempt:1`,
    parent_run_id: null,
    trace_id: `${RUN_ID}:trace`,
    status,
    outcome: completed
      ? "success"
      : failed
        ? "failure"
        : status === "cancelled"
          ? "cancelled"
          : status === "blocked"
            ? "blocked"
            : status === "reconciliation_required"
              ? "reconciliation_required"
              : "pending",
    started_at: STARTED_AT,
    completed_at: terminal ? isoMinute(sequence) : null,
    provider: "not_applicable",
    model: "not_applicable",
    input_summary: "Controlled local Loop Governor P0 lifecycle.",
    actions_taken: sequence >= 4 ? [{
      action_id: "local-validation",
      action_type: "local_controlled_run",
      summary: "Executed deterministic local validation without a provider.",
      outcome: completed ? "succeeded" : failed ? "failed" : "pending",
    }] : [],
    tools_used: sequence >= 4 ? [{
      tool_id: "loop-governor-local",
      name: "Loop Governor local harness",
      version: "1.0",
    }] : [],
    latency_ms: terminal ? sequence * 60_000 : null,
    cost_estimate: {
      kind: "not_applicable",
      amount_micros: null,
      currency: null,
    },
    approval_status: sequence >= 3 ? "approved" : "required",
    approval_actor: sequence >= 3 ? "founder-local" : null,
    approval_timestamp: sequence >= 3 ? APPROVED_AT : null,
    risk_level: "high",
    production_impact: true,
    validation_result: completed ? "passed" : failed ? "failed" : "not_run",
    validation_summary: completed
      ? "All deterministic local checks passed."
      : failed
        ? "The controlled failure remained visible."
        : null,
    failure_reason: failed ? "Controlled local failure." : null,
    failure_code: failed ? "CONTROLLED_FAILURE" : null,
    evidence_refs: completed ? [{
      evidence_id: `${RUN_ID}:evidence:1`,
      kind: "artifact",
      uri: "artifact://loop-governor/controlled-p0/result",
      sha256: "a".repeat(64),
      captured_at: isoMinute(sequence),
    }] : [],
    evidence_count: completed ? 1 : 0,
    evidence_integrity_status: completed ? "verified" : "not_present",
    created_at: STARTED_AT,
    updated_at: isoMinute(sequence),
    source_subsystem: "chanter-loop-governor",
    ...overrides,
  });
}

function successfulLifecycle(): AgentRunLedgerEntry[] {
  return [
    buildEntry(1, "created"),
    buildEntry(2, "approval_required"),
    buildEntry(3, "approved"),
    buildEntry(4, "running"),
    buildEntry(5, "validating"),
    buildEntry(6, "completed"),
  ];
}

function recreatedEntry(
  entry: AgentRunLedgerEntry,
  overrides: Partial<LedgerDraft>,
): AgentRunLedgerEntry {
  const draft = { ...entry } as AgentRunLedgerEntry & {
    payload_hash?: string;
    scope_hash?: string;
  };
  delete draft.payload_hash;
  delete draft.scope_hash;
  return createAgentRunLedgerEntry({ ...draft, ...overrides } as LedgerDraft);
}

interface Harness {
  root: string;
  databasePath: string;
  database: DatabaseSync;
  ledger: AgentRunLedgerService;
  app: ReturnType<typeof createApp>;
}

const openDatabases = new Set<DatabaseSync>();
const roots: string[] = [];

function createHarness(databasePath?: string): Harness {
  const root = databasePath
    ? path.dirname(databasePath)
    : mkdtempSync(path.join(os.tmpdir(), "operator-agent-run-ledger-"));
  if (!databasePath) roots.push(root);
  const resolvedDatabasePath = databasePath ?? path.join(root, "operator.sqlite");
  const database = createDatabase(resolvedDatabasePath);
  openDatabases.add(database);
  const operator = new OperatorService(
    database,
    new AuditLogger(path.join(root, "audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const ledger = new AgentRunLedgerService(database);
  return {
    root,
    databasePath: resolvedDatabasePath,
    database,
    ledger,
    app: createApp(operator, undefined, ledger),
  };
}

function close(database: DatabaseSync): void {
  database.close();
  openDatabases.delete(database);
}

function expectOperatorCode(operation: () => unknown, code: string): void {
  try {
    operation();
    throw new Error(`Expected OperatorError ${code}.`);
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorError);
    expect((error as OperatorError).code).toBe(code);
  }
}

afterEach(() => {
  for (const database of openDatabases) {
    try { database.close(); } catch { /* already closed */ }
  }
  openDatabases.clear();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Agent Run Ledger durable authority", () => {
  it("materializes one run, orders history, replays without writes, and reconstructs after restart", () => {
    const first = createHarness();
    const lifecycle = successfulLifecycle();
    for (const entry of lifecycle) {
      expect(first.ledger.appendEntry(entry).replayed).toBe(false);
    }
    const beforeReplay = first.ledger.getRun(RUN_ID);
    expect(beforeReplay.entry.status).toBe("completed");
    expect(beforeReplay.entry.evidence_count).toBe(1);
    expect(beforeReplay.transitions.map((entry) => entry.status)).toEqual([
      "created",
      "approval_required",
      "approved",
      "running",
      "validating",
      "completed",
    ]);
    expect(first.ledger.appendEntry(lifecycle.at(-1)).replayed).toBe(true);
    expect(first.database.prepare("SELECT COUNT(*) AS count FROM agent_run_ledger_runs").get()).toEqual({ count: 1 });
    expect(first.database.prepare("SELECT COUNT(*) AS count FROM agent_run_ledger_transitions").get()).toEqual({ count: 6 });

    close(first.database);
    const restarted = createHarness(first.databasePath);
    const afterRestart = restarted.ledger.getRun(RUN_ID);
    expect(afterRestart).toEqual(beforeReplay);
    expect(restarted.ledger.appendEntry(lifecycle.at(-1)).replayed).toBe(true);
    expect(restarted.database.prepare("SELECT COUNT(*) AS count FROM agent_run_ledger_transitions").get()).toEqual({ count: 6 });
  });

  it("rejects scope, payload, and event identifier mismatches before returning prior evidence", () => {
    const harness = createHarness();
    const lifecycle = successfulLifecycle();
    for (const entry of lifecycle) harness.ledger.appendEntry(entry);
    const completed = lifecycle.at(-1)!;
    const evidenceId = completed.evidence_refs[0]!.evidence_id;

    const scopeMismatch = recreatedEntry(completed, { product_id: "another_product" });
    expectOperatorCode(
      () => harness.ledger.appendEntry(scopeMismatch),
      "AGENT_RUN_LEDGER_SCOPE_MISMATCH",
    );

    const payloadMismatch = recreatedEntry(completed, { input_summary: "Changed payload." });
    expectOperatorCode(
      () => harness.ledger.appendEntry(payloadMismatch),
      "AGENT_RUN_LEDGER_PAYLOAD_MISMATCH",
    );

    const idempotencyMismatch = recreatedEntry(completed, { event_id: `${RUN_ID}:different-event` });
    expectOperatorCode(
      () => harness.ledger.appendEntry(idempotencyMismatch),
      "AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH",
    );

    for (const candidate of [scopeMismatch, payloadMismatch, idempotencyMismatch]) {
      try {
        harness.ledger.appendEntry(candidate);
      } catch (error) {
        expect(String(error)).not.toContain(evidenceId);
      }
    }
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM agent_run_ledger_transitions").get()).toEqual({ count: 6 });
  });

  it("rolls back the materialized summary when the journal append fails", () => {
    const harness = createHarness();
    const [created, approvalRequired] = successfulLifecycle();
    harness.ledger.appendEntry(created);
    harness.database.exec(`
      CREATE TRIGGER reject_agent_run_ledger_sequence_two
      BEFORE INSERT ON agent_run_ledger_transitions
      WHEN NEW.sequence = 2
      BEGIN
        SELECT RAISE(ABORT, 'atomicity probe');
      END;
    `);
    expect(() => harness.ledger.appendEntry(approvalRequired)).toThrow();
    const durable = harness.ledger.getRun(RUN_ID);
    expect(durable.entry.sequence).toBe(1);
    expect(durable.transitions).toHaveLength(1);
  });

  it("keeps failed runs visible and supports every exact filter with inclusive dates", () => {
    const harness = createHarness();
    const lifecycle = successfulLifecycle().slice(0, 4);
    for (const entry of lifecycle) harness.ledger.appendEntry(entry);
    harness.ledger.appendEntry(buildEntry(5, "failed"));

    const filters = {
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "failed",
      approvalStatus: "approved",
      validationResult: "failed",
      outcome: "failure",
      from: STARTED_AT,
      to: STARTED_AT,
      limit: 10,
    };
    const result = harness.ledger.listRuns(filters);
    expect(result.filters).toEqual(filters);
    expect(result.runs).toHaveLength(1);
    expect(result.runs[0]).toMatchObject({
      run_id: RUN_ID,
      status: "failed",
      failure_code: "CONTROLLED_FAILURE",
    });
  });

  it("rejects evidence-less completion, missing production approval metadata, and raw secrets without persistence", () => {
    const cases: Array<{ value: unknown; code: string }> = [
      {
        value: {
          ...buildEntry(6, "completed"),
          evidence_refs: [],
          evidence_count: 0,
          evidence_integrity_status: "not_present",
        },
        code: "COMPLETED_REQUIRES_EVIDENCE",
      },
      {
        value: {
          ...buildEntry(6, "completed"),
          approval_status: "approved",
          approval_actor: null,
          approval_timestamp: null,
        },
        code: "APPROVAL_METADATA_MISMATCH",
      },
      {
        value: {
          ...buildEntry(1, "created"),
          input_summary: "Authorization: Bearer raw-secret-canary",
        },
        code: "FREE_TEXT_REQUIRES_REDACTION",
      },
    ];

    for (const { value, code } of cases) {
      const harness = createHarness();
      expectOperatorCode(() => harness.ledger.appendEntry(value), code);
      expect(harness.database.prepare("SELECT COUNT(*) AS count FROM agent_run_ledger_runs").get()).toEqual({ count: 0 });
      for (const file of [harness.databasePath, `${harness.databasePath}-wal`, `${harness.databasePath}-shm`]) {
        if (existsSync(file)) {
          expect(readFileSync(file).toString("utf8")).not.toContain("raw-secret-canary");
        }
      }
    }
  });

  it("exposes typed ingest/read/filter APIs and a typed 413 without weakening existing app wiring", async () => {
    const harness = createHarness();
    for (const entry of successfulLifecycle()) {
      const response = await request(harness.app)
        .post("/api/agent-run-ledger/entries")
        .send(entry);
      expect(response.status).toBe(201);
      expect(response.body.replayed).toBe(false);
    }
    const replay = await request(harness.app)
      .post("/api/agent-run-ledger/entries")
      .send(successfulLifecycle().at(-1));
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);

    const query = new URLSearchParams({
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "completed",
      approvalStatus: "approved",
      validationResult: "passed",
      outcome: "success",
      from: STARTED_AT,
      to: STARTED_AT,
      limit: "25",
    });
    const listed = await request(harness.app).get(`/api/agent-run-ledger/runs?${query}`);
    expect(listed.status).toBe(200);
    expect(listed.body.filters).toEqual({
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "completed",
      approvalStatus: "approved",
      validationResult: "passed",
      outcome: "success",
      from: STARTED_AT,
      to: STARTED_AT,
      limit: 25,
    });
    expect(listed.body.runs).toHaveLength(1);
    const detail = await request(harness.app).get(`/api/agent-run-ledger/runs/${RUN_ID}`);
    expect(detail.status).toBe(200);
    expect(detail.body.transitions).toHaveLength(6);

    const oversized = await request(harness.app)
      .post("/api/agent-run-ledger/entries")
      .set("Content-Type", "application/json")
      .send(JSON.stringify({ input_summary: "x".repeat(140_000) }));
    expect(oversized.status).toBe(413);
    expect(oversized.body.code).toBe("AGENT_RUN_LEDGER_REQUEST_TOO_LARGE");
  });
});
