import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import { createAgentRunLedgerEntry } from "chanter-agent-runtime";

const execFileAsync = promisify(execFile);
const CHILD_PROCESS_TIMEOUT_MS = 15_000;
const CHILD_PROCESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const originalEnvironment = {
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  operatorLedgerTimeout: process.env.OPERATOR_LEDGER_TIMEOUT_MS,
};

const missionSubmitToken = `phase2b2-submit-${randomUUID()}`;
const missionControlToken = `phase2b2-control-${randomUUID()}`;
const ledgerToken = `phase2b2-ledger-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = missionSubmitToken;
process.env.OPERATOR_CONTROL_TOKEN = missionControlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;
process.env.OPERATOR_LEDGER_TIMEOUT_MS = "5000";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { MockRunner },
  { OperatorService },
  { ensureWorkspace },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
]);

interface RunningOperator {
  appBaseUrl: string;
  database: DatabaseSync;
  databasePath: string;
  ledger: InstanceType<typeof AgentRunLedgerService>;
  server: Server;
}

const operatorRoot = path.resolve(import.meta.dirname, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const reorderScript = path.join(governorRoot, "scripts", "agent_run_ledger_reorder_demo.py");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const approvalActor = "founder-phase2b2-harness";

async function startOperator(root: string, databasePath: string): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const operatorService = new OperatorService(
    database,
    new AuditLogger(path.join(root, "operator-audit.jsonl")),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [missionSubmitToken, missionControlToken, ledgerToken];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const app = createApp(operatorService, undefined, ledger);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    appBaseUrl: `http://127.0.0.1:${address.port}`,
    database,
    databasePath,
    ledger,
    server,
  };
}

async function stopOperator(running: RunningOperator): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => (error ? reject(error) : resolve()));
  });
  running.database.close();
}

function restoreEnvironment(): void {
  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.missionSubmitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.missionControlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
  restore("OPERATOR_LEDGER_TIMEOUT_MS", originalEnvironment.operatorLedgerTimeout);
}

test.after(() => {
  restoreEnvironment();
});

function countsForRun(database: DatabaseSync, runId: string) {
  const summary = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_runs WHERE run_id = ?",
  ).get(runId) as { count: number };
  const transitions = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_transitions WHERE run_id = ?",
  ).get(runId) as { count: number };
  const ingestAccepted = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_ingest_events WHERE run_id = ? AND ingest_outcome = 'accepted'",
  ).get(runId) as { count: number };
  return {
    summaries: Number(summary.count),
    transitions: Number(transitions.count),
    ingestAccepted: Number(ingestAccepted.count),
  };
}

function assertNoSecretBytes(databasePath: string, canary: string) {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) {
      assert.equal(readFileSync(candidate).includes(Buffer.from(canary, "utf8")), false);
    }
  }
}

interface ReorderDeliveryResult {
  submitted_sequence: number;
  accepted?: boolean;
  applied?: boolean;
  replayed?: boolean;
  gap_state?: string;
  sequence?: number;
  error?: boolean;
  code?: string;
}

async function emitReordered(
  root: string,
  operatorBaseUrl: string,
  runId: string,
  order: string,
  outputName: string,
) {
  const stateDir = path.join(root, "governor-state");
  const outputPath = path.join(root, outputName);
  await execFileAsync(
    python,
    [
      reorderScript,
      "--state-dir", stateDir,
      "--output", outputPath,
      "--run-id", runId,
      "--approval-actor", approvalActor,
      "--operator-base-url", operatorBaseUrl,
      "--order", order,
    ],
    {
      cwd: governorRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
        OPERATOR_LEDGER_TIMEOUT_MS: "5000",
      },
      timeout: CHILD_PROCESS_TIMEOUT_MS,
      maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
      windowsHide: true,
    },
  );
  const payload = JSON.parse(readFileSync(outputPath, "utf8")) as {
    run_id: string;
    order: number[];
    delivery_results: ReorderDeliveryResult[];
  };
  return payload;
}

test("Phase 2B2 real out-of-order delivery through Loop Governor's transport exposes an open gap and drains it on closure", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b2-gap-"));
  const databasePath = path.join(root, "operator.sqlite");
  const runId = "loop-governor-phase2b2-gap-run";
  const running = await startOperator(root, databasePath);
  try {
    const first = await emitReordered(root, running.appBaseUrl, runId, "1,3,4,5,6", "gap-open.json");
    assert.equal(first.delivery_results[0].applied, true);
    assert.equal(first.delivery_results[0].sequence, 1);
    for (const result of first.delivery_results.slice(1)) {
      assert.equal(result.accepted, true);
      assert.equal(result.applied, false);
      assert.equal(result.gap_state, "open");
    }
    assert.deepEqual(countsForRun(running.database, runId), { summaries: 1, transitions: 1, ingestAccepted: 5 });

    const status = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/runs/${runId}/ingest-status`);
    assert.equal(status.status, 200);
    const statusBody = await status.json() as { gap_state: string; last_applied_sequence: number; last_received_sequence: number };
    assert.equal(statusBody.gap_state, "open");
    assert.equal(statusBody.last_applied_sequence, 1);
    assert.equal(statusBody.last_received_sequence, 6);

    const closing = await emitReordered(root, running.appBaseUrl, runId, "2", "gap-close.json");
    assert.equal(closing.delivery_results[0].applied, true);
    assert.equal(countsForRun(running.database, runId).transitions, 6);
    assert.equal(running.ledger.getRun(runId).entry.status, "completed");

    const closedStatus = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/runs/${runId}/ingest-status`);
    const closedBody = await closedStatus.json() as { gap_state: string; conflict_state: string; run_status: string };
    assert.equal(closedBody.gap_state, "closed");
    assert.equal(closedBody.conflict_state, "none");
    assert.equal(closedBody.run_status, "completed");
    assertNoSecretBytes(databasePath, ledgerToken);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 2B2 restart preserves an open gap exactly and still closes it afterward", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b2-restart-"));
  const databasePath = path.join(root, "operator.sqlite");
  const runId = "loop-governor-phase2b2-restart-run";
  let running = await startOperator(root, databasePath);
  try {
    await emitReordered(root, running.appBaseUrl, runId, "1,4", "restart-gap.json");
    const before = countsForRun(running.database, runId);
    assert.deepEqual(before, { summaries: 1, transitions: 1, ingestAccepted: 2 });
    const beforeStatus = running.ledger.getIngestProjection(runId);
    assert.equal(beforeStatus.gap_state, "open");

    await stopOperator(running);
    running = await startOperator(root, databasePath);

    const afterRestartStatus = running.ledger.getIngestProjection(runId);
    assert.deepEqual(afterRestartStatus, beforeStatus);
    assert.deepEqual(countsForRun(running.database, runId), before);

    await emitReordered(root, running.appBaseUrl, runId, "2,3", "restart-gap-close.json");
    assert.equal(countsForRun(running.database, runId).transitions, 4);
    assert.equal(running.ledger.getIngestProjection(runId).gap_state, "closed");
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 2B2 a conflicting duplicate delivered through the live router is rejected as explicit evidence", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b2-conflict-"));
  const databasePath = path.join(root, "operator.sqlite");
  const runId = "loop-governor-phase2b2-conflict-run";
  const running = await startOperator(root, databasePath);
  try {
    await emitReordered(root, running.appBaseUrl, runId, "1", "conflict-first.json");
    const firstRun = running.ledger.getRun(runId);
    const originalEntry = firstRun.entry as Record<string, unknown> & { payload_hash?: string; scope_hash?: string };

    // A genuinely valid entry (correct, recomputed hashes) for the exact same
    // event_id/run_id/sequence, but a different input_summary — the real
    // shape a misbehaving or duplicate producer could actually send.
    const draft = { ...originalEntry };
    delete draft.payload_hash;
    delete draft.scope_hash;
    const conflicting = createAgentRunLedgerEntry({
      ...draft,
      input_summary: "A conflicting payload for the same event_id.",
    } as Parameters<typeof createAgentRunLedgerEntry>[0]);

    const response = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ledgerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(conflicting),
    });
    assert.equal(response.status, 409);
    const responseBody = await response.json() as { code: string };
    assert.equal(responseBody.code, "AGENT_RUN_LEDGER_INGEST_EVENT_CONFLICT");

    const status = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/runs/${runId}/ingest-status`);
    const statusBody = await status.json() as { conflict_state: string };
    assert.equal(statusBody.conflict_state, "conflicted");
    // The original accepted receipt for sequence 1 must remain untouched.
    assert.equal(running.ledger.getRun(runId).entry.input_summary, originalEntry.input_summary);
    assertNoSecretBytes(databasePath, ledgerToken);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});
