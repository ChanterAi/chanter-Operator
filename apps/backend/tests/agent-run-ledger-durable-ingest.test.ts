const LEDGER_INGEST_TOKEN = "test-ledger-ingest-token";

function withLedgerAuth(req: ReturnType<typeof request>) {
  return req.set("Authorization", `Bearer ${LEDGER_INGEST_TOKEN}`);
}

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import express from "express";
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
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";

type LedgerDraft = Parameters<typeof createAgentRunLedgerEntry>[0];

const RUN_ID = "lg-durable-ingest-run-001";
const STARTED_AT = "2026-07-16T09:00:00.000Z";
const APPROVED_AT = "2026-07-16T09:02:00.000Z";

function isoMinute(minute: number): string {
  return `2026-07-16T09:${String(minute).padStart(2, "0")}:00.000Z`;
}

function buildEntry(
  runId: string,
  sequence: number,
  status: AgentRunLedgerEntry["status"],
  overrides: Partial<LedgerDraft> = {},
): AgentRunLedgerEntry {
  const terminal = ["completed", "failed", "cancelled"].includes(status);
  const completed = status === "completed";
  return createAgentRunLedgerEntry({
    schema_version: "1.0",
    run_id: runId,
    event_id: `${runId}:event:${sequence}`,
    sequence,
    product_id: "loop_governor",
    workflow_id: "durable_ingest_2b2",
    agent_id: "loop-governor-local",
    attempt_id: `${runId}:attempt:1`,
    parent_run_id: null,
    trace_id: `${runId}:trace`,
    status,
    outcome: completed ? "success" : "pending",
    started_at: STARTED_AT,
    completed_at: terminal ? isoMinute(sequence) : null,
    provider: "not_applicable",
    model: "not_applicable",
    input_summary: "Controlled local Phase 2B2 durable ingest lifecycle.",
    actions_taken: [],
    tools_used: [],
    latency_ms: terminal ? sequence * 60_000 : null,
    cost_estimate: { kind: "not_applicable", amount_micros: null, currency: null },
    approval_status: sequence >= 3 ? "approved" : "required",
    approval_actor: sequence >= 3 ? "founder-local" : null,
    approval_timestamp: sequence >= 3 ? APPROVED_AT : null,
    risk_level: "high",
    production_impact: true,
    validation_result: completed ? "passed" : "not_run",
    validation_summary: completed ? "All deterministic local checks passed." : null,
    failure_reason: null,
    failure_code: null,
    evidence_refs: completed ? [{
      evidence_id: `${runId}:evidence:1`,
      kind: "artifact",
      uri: "artifact://loop-governor/durable-ingest-2b2/result",
      sha256: "b".repeat(64),
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

function lifecycle(runId: string): AgentRunLedgerEntry[] {
  return [
    buildEntry(runId, 1, "created"),
    buildEntry(runId, 2, "approval_required"),
    buildEntry(runId, 3, "approved"),
    buildEntry(runId, 4, "running"),
    buildEntry(runId, 5, "validating"),
    buildEntry(runId, 6, "completed"),
  ];
}

function recreatedEntry(entry: AgentRunLedgerEntry, overrides: Partial<LedgerDraft>): AgentRunLedgerEntry {
  const draft = { ...entry } as AgentRunLedgerEntry & { payload_hash?: string; scope_hash?: string };
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
  const root = databasePath ? path.dirname(databasePath) : mkdtempSync(path.join(os.tmpdir(), "operator-agent-run-ledger-2b2-"));
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
  const ledger = new AgentRunLedgerService(database, [LEDGER_INGEST_TOKEN]);
  const rawApp = createApp(operator, undefined, ledger);
  const testApp = express();
  testApp.use((req, _res, next) => {
    if (!req.headers["authorization"] && !req.headers["x-chanter-capability-token"]) {
      req.headers["authorization"] = `Bearer ${LEDGER_INGEST_TOKEN}`;
    }
    next();
  });
  testApp.use(rawApp);
  return { root, databasePath: resolvedDatabasePath, database, ledger, app: testApp };
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

describe("Agent Run Ledger Phase 2B2 durable ingest", () => {
  it("preserves the exact contiguous applied shape (200/201, replayed) for in-order delivery", () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);
    for (const entry of events) {
      const result = harness.ledger.ingestEntry(entry);
      expect(result.kind).toBe("applied");
      if (result.kind === "applied") expect(result.replayed).toBe(false);
    }
    const replay = harness.ledger.ingestEntry(events.at(-1));
    expect(replay.kind).toBe("applied");
    if (replay.kind === "applied") expect(replay.replayed).toBe(true);
  });

  it("holds a future sequence pending instead of rejecting it, then closes the gap on arrival", () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);

    expect(harness.ledger.ingestEntry(events[0]).kind).toBe("applied");
    // Skip sequence 2; submit 3, 4, 5, 6 out of order.
    for (const entry of [events[2], events[3], events[4], events[5]]) {
      const result = harness.ledger.ingestEntry(entry);
      expect(result.kind).toBe("pending");
      if (result.kind === "pending") {
        expect(result.gap_state).toBe("open");
        expect(result.last_applied_sequence).toBe(1);
      }
    }
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_run_ledger_transitions",
    ).get()).toEqual({ count: 1 });

    const projectionBeforeClose = harness.ledger.getIngestProjection(RUN_ID);
    expect(projectionBeforeClose.gap_state).toBe("open");
    expect(projectionBeforeClose.last_applied_sequence).toBe(1);
    expect(projectionBeforeClose.last_received_sequence).toBe(6);

    const closing = harness.ledger.ingestEntry(events[1]);
    expect(closing.kind).toBe("applied");

    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_run_ledger_transitions",
    ).get()).toEqual({ count: 6 });
    const projectionAfterClose = harness.ledger.getIngestProjection(RUN_ID);
    expect(projectionAfterClose.gap_state).toBe("closed");
    expect(projectionAfterClose.last_applied_sequence).toBe(6);
    expect(projectionAfterClose.run_status).toBe("completed");
  });

  it("treats an exact duplicate pending receipt as idempotent without a second row", () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);
    harness.ledger.ingestEntry(events[0]);
    harness.ledger.ingestEntry(events[2]);
    const again = harness.ledger.ingestEntry(events[2]);
    expect(again.kind).toBe("pending");
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_run_ledger_ingest_events WHERE run_id = ? AND ingest_outcome = 'accepted'",
    ).get(RUN_ID)).toEqual({ count: 2 });
  });

  it("rejects a conflicting duplicate event_id as explicit evidence, not silent repair", () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);
    harness.ledger.ingestEntry(events[0]);
    harness.ledger.ingestEntry(events[2]);

    const conflicting = recreatedEntry(events[2], { input_summary: "A different payload for the same event_id." });
    expect(() => harness.ledger.ingestEntry(conflicting)).toThrowError(
      expect.objectContaining({ code: "AGENT_RUN_LEDGER_INGEST_EVENT_CONFLICT" }),
    );
    const projection = harness.ledger.getIngestProjection(RUN_ID);
    expect(projection.conflict_state).toBe("conflicted");
    // The original accepted receipt for sequence 3 must remain untouched.
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_run_ledger_ingest_events WHERE run_id = ? AND ingest_outcome = 'accepted' AND sequence = 3",
    ).get(RUN_ID)).toEqual({ count: 1 });
  });

  it("rejects a different event_id claiming an already-received sequence slot", () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);
    harness.ledger.ingestEntry(events[0]);
    harness.ledger.ingestEntry(events[2]);

    const impostor = recreatedEntry(events[2], { event_id: `${RUN_ID}:impostor-event` });
    expect(() => harness.ledger.ingestEntry(impostor)).toThrowError(
      expect.objectContaining({ code: "AGENT_RUN_LEDGER_INGEST_SEQUENCE_CONFLICT" }),
    );
  });

  it("rejects protected configuration data before any ingest row can persist", () => {
    const harness = createHarness();
    const entry = { ...buildEntry(RUN_ID, 1, "created"), input_summary: `Never persist ${LEDGER_INGEST_TOKEN}` };
    expect(() => harness.ledger.ingestEntry(entry)).toThrowError(
      expect.objectContaining({ code: "AGENT_RUN_LEDGER_PROTECTED_VALUE" }),
    );
    expect(harness.database.prepare(
      "SELECT COUNT(*) AS count FROM agent_run_ledger_ingest_events",
    ).get()).toEqual({ count: 0 });
  });

  it("survives restart with an open gap and closes it deterministically after reopen", () => {
    const first = createHarness();
    const events = lifecycle(RUN_ID);
    first.ledger.ingestEntry(events[0]);
    first.ledger.ingestEntry(events[2]);
    first.ledger.ingestEntry(events[3]);
    const beforeRestart = first.ledger.getIngestProjection(RUN_ID);
    expect(beforeRestart.gap_state).toBe("open");
    expect(beforeRestart.last_applied_sequence).toBe(1);
    expect(beforeRestart.last_received_sequence).toBe(4);

    first.database.close();
    openDatabases.delete(first.database);

    const restarted = createHarness(first.databasePath);
    const afterRestart = restarted.ledger.getIngestProjection(RUN_ID);
    expect(afterRestart).toEqual(beforeRestart);

    const closing = restarted.ledger.ingestEntry(events[1]);
    expect(closing.kind).toBe("applied");
    const closed = restarted.ledger.getIngestProjection(RUN_ID);
    // Sequence 2 fills the only hole; 3 and 4 were already durably received
    // and drain automatically, so the gap closes even though 5 and 6 (never
    // submitted at all) leave the run incomplete.
    expect(closed.gap_state).toBe("closed");
    expect(closed.last_applied_sequence).toBe(4);
    expect(closed.last_received_sequence).toBe(4);
    expect(closed.run_status).toBe("running");
  });

  it("returns 202 accepted-but-unapplied over HTTP for a genuine gap, and 404 for an unknown ingest-status run", async () => {
    const harness = createHarness();
    const events = lifecycle(RUN_ID);

    const first = await withLedgerAuth(request(harness.app).post("/api/agent-run-ledger/entries")).send(events[0]);
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ replayed: false, run: expect.any(Object) });

    const gap = await withLedgerAuth(request(harness.app).post("/api/agent-run-ledger/entries")).send(events[2]);
    expect(gap.status).toBe(202);
    expect(gap.body).toMatchObject({
      accepted: true,
      applied: false,
      gap_state: "open",
      run_id: RUN_ID,
      sequence: 3,
      last_applied_sequence: 1,
      last_received_sequence: 3,
    });

    const status = await request(harness.app).get(`/api/agent-run-ledger/runs/${RUN_ID}/ingest-status`);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({
      run_id: RUN_ID,
      gap_state: "open",
      conflict_state: "none",
      last_applied_sequence: 1,
      last_received_sequence: 3,
    });

    const missing = await request(harness.app).get("/api/agent-run-ledger/runs/never-seen-run/ingest-status");
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe("AGENT_RUN_LEDGER_RUN_NOT_FOUND");
  });
});
