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

const execFileAsync = promisify(execFile);
const CHILD_PROCESS_TIMEOUT_MS = 15_000;
const CHILD_PROCESS_MAX_BUFFER_BYTES = 10 * 1024 * 1024;

const originalEnvironment = {
  operatorBaseUrl: process.env.OPERATOR_BASE_URL,
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  operatorLedgerTimeout: process.env.OPERATOR_LEDGER_TIMEOUT_MS,
};

const missionSubmitToken = `phase2b1-submit-${randomUUID()}`;
const missionControlToken = `phase2b1-control-${randomUUID()}`;
const ledgerToken = `phase2b1-ledger-${randomUUID()}`;
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
const governorScript = path.join(governorRoot, "scripts", "agent_run_ledger_demo.py");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const runId = "loop-governor-phase2b1-controlled-run";
const approvalActor = "founder-phase2b1-harness";

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
  restore("OPERATOR_BASE_URL", originalEnvironment.operatorBaseUrl);
  restore("OPERATOR_MISSION_SUBMIT_TOKEN", originalEnvironment.missionSubmitToken);
  restore("OPERATOR_CONTROL_TOKEN", originalEnvironment.missionControlToken);
  restore("OPERATOR_LEDGER_INGEST_TOKEN", originalEnvironment.ledgerToken);
  restore("OPERATOR_LEDGER_TIMEOUT_MS", originalEnvironment.operatorLedgerTimeout);
}

function countsForRun(database: DatabaseSync, selectedRunId: string) {
  const summary = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_runs WHERE run_id = ?",
  ).get(selectedRunId) as { count: number };
  const transitions = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_transitions WHERE run_id = ?",
  ).get(selectedRunId) as { count: number };
  return {
    summaries: Number(summary.count),
    transitions: Number(transitions.count),
  };
}

async function emitGovernor(
  root: string,
  operatorBaseUrl: string,
  outputName: string,
  extraEnv: Record<string, string> = {},
) {
  const stateDir = path.join(root, "governor-state");
  const outputPath = path.join(root, outputName);
  const { stdout } = await execFileAsync(
    python,
    [
      governorScript,
      "--state-dir", stateDir,
      "--output", outputPath,
      "--run-id", runId,
      "--approval-actor", approvalActor,
      "--transport", "operator",
      "--operator-base-url", operatorBaseUrl,
    ],
    {
      cwd: governorRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
        OPERATOR_LEDGER_TIMEOUT_MS: "5000",
        ...extraEnv,
      },
      timeout: CHILD_PROCESS_TIMEOUT_MS,
      maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
      windowsHide: true,
    },
  );
  return {
    stdout: stdout.trim(),
    payload: JSON.parse(readFileSync(outputPath, "utf8")) as {
      metadata: {
        reconstructed_from_outbox: boolean;
        provider_calls: number;
        transition_count: number;
        delivery_results?: Array<{ replayed: boolean; status: string; sequence: number }>;
      };
      events: Array<{ status: string; run_id: string }>;
    },
  };
}

test.after(() => {
  restoreEnvironment();
});

async function emitPartialGovernor(root: string, operatorBaseUrl: string) {
  const stateDir = path.join(root, "governor-state");
  const code = `
import os
import sys
from pathlib import Path

sys.path.insert(0, os.environ["GOVERNOR_ROOT"])
from governor.agent_run_ledger import emit_controlled_agent_run
from governor.operator_ledger_port import OperatorAgentRunLedgerHttpPort, OperatorLedgerTransportError

class FailAfterThree:
    def __init__(self, delegate):
        self.delegate = delegate
        self.count = 0
    def append_entry(self, entry):
        if self.count >= 3:
            raise OperatorLedgerTransportError(
                "OPERATOR_LEDGER_TRANSPORT_NETWORK",
                "simulated partial failure",
            )
        self.count += 1
        return self.delegate.append_entry(entry)

delegate = OperatorAgentRunLedgerHttpPort(base_url=os.environ["OPERATOR_BASE_URL"])
try:
    emit_controlled_agent_run(
        state_dir=Path(os.environ["STATE_DIR"]),
        run_id=os.environ["RUN_ID"],
        approval_actor=os.environ["APPROVAL_ACTOR"],
        port=FailAfterThree(delegate),
    )
except OperatorLedgerTransportError:
    pass
else:
    raise SystemExit("expected partial failure")
`.trim();
  await execFileAsync(python, ["-c", code], {
    cwd: governorRoot,
    env: {
      ...process.env,
      GOVERNOR_ROOT: governorRoot,
      STATE_DIR: stateDir,
      RUN_ID: runId,
      APPROVAL_ACTOR: approvalActor,
      OPERATOR_BASE_URL: operatorBaseUrl,
      OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
      OPERATOR_LEDGER_TIMEOUT_MS: "5000",
    },
    timeout: CHILD_PROCESS_TIMEOUT_MS,
    maxBuffer: CHILD_PROCESS_MAX_BUFFER_BYTES,
    windowsHide: true,
  });
}

function assertNoSecretBytes(databasePath: string, canary: string) {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) {
      assert.equal(readFileSync(candidate).includes(Buffer.from(canary, "utf8")), false);
    }
  }
}

test("Phase 2B1 live ledger transport survives Operator and Governor restart with exact replay", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b1-ledger-"));
  const databasePath = path.join(root, "operator.sqlite");
  let running = await startOperator(root, databasePath);
  try {
    const first = await emitGovernor(root, running.appBaseUrl, "first-delivery.json");
    assert.equal(first.payload.metadata.reconstructed_from_outbox, false);
    assert.equal(first.payload.metadata.provider_calls, 0);
    assert.equal(first.payload.metadata.transition_count, 6);
    assert.deepEqual(
      first.payload.events.map((entry) => entry.status),
      ["created", "approval_required", "approved", "running", "validating", "completed"],
    );
    assert.equal(first.payload.metadata.delivery_results?.every((item) => item.replayed === false), true);
    assert.deepEqual(countsForRun(running.database, runId), { summaries: 1, transitions: 6 });
    const beforeRestart = running.ledger.getRun(runId);
    assert.equal(beforeRestart.entry.status, "completed");
    assert.equal(beforeRestart.transitions.length, 6);

    await stopOperator(running);
    running = await startOperator(root, databasePath);
    const replay = await emitGovernor(root, running.appBaseUrl, "restart-replay.json");
    assert.equal(replay.payload.metadata.reconstructed_from_outbox, true);
    assert.equal(replay.payload.metadata.provider_calls, 0);
    assert.deepEqual(replay.payload.events, first.payload.events);
    assert.equal(replay.payload.metadata.delivery_results?.every((item) => item.replayed === true), true);
    assert.deepEqual(countsForRun(running.database, runId), { summaries: 1, transitions: 6 });
    assert.deepEqual(running.ledger.getRun(runId), beforeRestart);
    assertNoSecretBytes(databasePath, ledgerToken);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 2B1 partial delivery replays delivered transitions and appends the remainder", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b1-partial-"));
  const databasePath = path.join(root, "operator.sqlite");
  let running = await startOperator(root, databasePath);
  try {
    await emitPartialGovernor(root, running.appBaseUrl);
    assert.deepEqual(countsForRun(running.database, runId), { summaries: 1, transitions: 3 });

    await stopOperator(running);
    running = await startOperator(root, databasePath);
    const recovery = await emitGovernor(root, running.appBaseUrl, "partial-recovery.json");
    assert.equal(recovery.payload.metadata.reconstructed_from_outbox, true);
    assert.equal(recovery.payload.metadata.delivery_results?.slice(0, 3).every((item) => item.replayed), true);
    assert.equal(recovery.payload.metadata.delivery_results?.slice(3).every((item) => item.replayed === false), true);
    assert.deepEqual(countsForRun(running.database, runId), { summaries: 1, transitions: 6 });
    assert.equal(running.ledger.getRun(runId).entry.status, "completed");
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});

test("Phase 2B1 ledger capability isolation remains fail-closed on the live router", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2b1-security-"));
  const databasePath = path.join(root, "operator.sqlite");
  const running = await startOperator(root, databasePath);
  try {
    const entry = {
      schema_version: "1.0",
      run_id: "security-probe-run",
      event_id: "security-probe-run:event:1:created",
      sequence: 1,
      product_id: "loop_governor",
      workflow_id: "controlled_agent_run_ledger_p0",
      agent_id: "loop-governor-manual-core",
      attempt_id: "security-probe-run:attempt:1",
      parent_run_id: null,
      trace_id: "security-probe-run:trace:1",
      status: "created",
      outcome: "pending",
      started_at: "2026-07-15T12:00:00.000Z",
      completed_at: null,
      provider: "not_applicable",
      model: "not_applicable",
      input_summary: "Security probe.",
      actions_taken: [],
      tools_used: [],
      latency_ms: null,
      cost_estimate: { kind: "not_applicable", amount_micros: null, currency: null },
      approval_status: "required",
      approval_actor: null,
      approval_timestamp: null,
      risk_level: "medium",
      production_impact: false,
      validation_result: "not_run",
      validation_summary: null,
      failure_reason: null,
      failure_code: null,
      evidence_refs: [],
      evidence_count: 0,
      evidence_integrity_status: "not_present",
      created_at: "2026-07-15T12:00:00.000Z",
      updated_at: "2026-07-15T12:00:00.000Z",
      source_subsystem: "chanter-loop-governor",
    };

    const missing = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/entries`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(entry),
    });
    assert.equal(missing.status, 401);
    const missingBody = await missing.json() as { code: string };
    assert.equal(missingBody.code, "CAPABILITY_TOKEN_INVALID");

    const wrongSubmit = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${missionSubmitToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry),
    });
    assert.equal(wrongSubmit.status, 401);

    const wrongControl = await fetch(`${running.appBaseUrl}/api/agent-run-ledger/entries`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${missionControlToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(entry),
    });
    assert.equal(wrongControl.status, 401);

    const ledgerCannotSubmit = await fetch(`${running.appBaseUrl}/api/runtime-missions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ledgerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    assert.equal(ledgerCannotSubmit.status, 401);

    assert.deepEqual(countsForRun(running.database, "security-probe-run"), { summaries: 0, transitions: 0 });
    assertNoSecretBytes(databasePath, ledgerToken);
  } finally {
    await stopOperator(running);
    rmSync(root, { recursive: true, force: true });
  }
});
