import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAgentRunLedgerEntry } from "chanter-agent-runtime";
import { AgentRunLedgerService } from "../../apps/backend/src/agentRunLedger/agentRunLedgerService.ts";
import { createDatabase } from "../../apps/backend/src/db/database.ts";

if (process.env.CHANTER_CLEAN_SOURCE !== "1" || !process.env.CHANTER_FRESH_RUNTIME_ENTRY) {
  throw new Error("The Agent Run Ledger demonstration must run through clean-source-validation.mjs.");
}

const operatorRoot = path.resolve(import.meta.dirname, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const governorScript = path.join(governorRoot, "scripts", "agent_run_ledger_demo.py");
const python = process.env.PYTHON ?? (process.platform === "win32" ? "python" : "python3");
const root = mkdtempSync(path.join(os.tmpdir(), "chanter-agent-run-ledger-demo-"));
const stateDir = path.join(root, "governor-state");
const databasePath = path.join(root, "operator.sqlite");
const runId = "loop-governor-ledger-p0-controlled";
const failedRunId = `${runId}-failed`;
const approvalActor = "founder-controlled-local";
let database;

function emit(outputName, selectedRunId, failed = false) {
  const outputPath = path.join(root, outputName);
  const args = [
    governorScript,
    "--state-dir", stateDir,
    "--output", outputPath,
    "--run-id", selectedRunId,
    "--approval-actor", approvalActor,
  ];
  if (failed) args.push("--failed");
  execFileSync(python, args, {
    cwd: governorRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  return JSON.parse(readFileSync(outputPath, "utf8"));
}

function countsForRun(selectedRunId) {
  const summary = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_runs WHERE run_id = ?",
  ).get(selectedRunId);
  const transitions = database.prepare(
    "SELECT COUNT(*) AS count FROM agent_run_ledger_transitions WHERE run_id = ?",
  ).get(selectedRunId);
  return {
    summaries: Number(summary.count),
    transitions: Number(transitions.count),
  };
}

function recreatedEntry(entry, overrides) {
  const draft = structuredClone(entry);
  delete draft.payload_hash;
  delete draft.scope_hash;
  return createAgentRunLedgerEntry({ ...draft, ...overrides });
}

function expectCode(operation, expectedCode, protectedEvidence) {
  try {
    operation();
    assert.fail(`Expected ${expectedCode}.`);
  } catch (error) {
    assert.equal(error?.code, expectedCode);
    const publicFailure = `${error?.name ?? ""} ${error?.message ?? ""} ${error?.code ?? ""}`;
    assert.equal(publicFailure.includes(protectedEvidence.evidence_id), false);
    assert.equal(publicFailure.includes(protectedEvidence.uri), false);
    return expectedCode;
  }
}

function assertNoSecretBytes(canary) {
  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(candidate)) {
      assert.equal(readFileSync(candidate).includes(Buffer.from(canary, "utf8")), false);
    }
  }
}

try {
  const firstEmission = emit("completed-first.json", runId);
  assert.equal(firstEmission.metadata.run_id, runId);
  assert.equal(firstEmission.metadata.reconstructed_from_outbox, false);
  assert.equal(firstEmission.metadata.provider_calls, 0);
  assert.equal(firstEmission.metadata.transition_count, 6);
  assert.equal(existsSync(firstEmission.metadata.evidence_path), true);
  assert.deepEqual(
    firstEmission.events.map((entry) => entry.status),
    ["created", "approval_required", "approved", "running", "validating", "completed"],
  );
  assert.equal(firstEmission.events.every((entry) => entry.run_id === runId), true);
  assert.equal(firstEmission.events.every((entry) => entry.provider === "not_applicable"), true);
  assert.equal(firstEmission.events.every((entry) => entry.model === "not_applicable"), true);
  assert.equal(firstEmission.events.every((entry) => entry.cost_estimate.kind === "not_applicable"), true);

  database = createDatabase(databasePath);
  let ledger = new AgentRunLedgerService(database);
  const initialWrites = firstEmission.events.map((entry) => ledger.appendEntry(entry));
  assert.equal(initialWrites.every((result) => result.replayed === false), true);
  assert.deepEqual(countsForRun(runId), { summaries: 1, transitions: 6 });
  const beforeRestart = ledger.getRun(runId);
  assert.equal(beforeRestart.entry.status, "completed");
  assert.equal(beforeRestart.entry.validation_result, "passed");
  assert.equal(beforeRestart.entry.evidence_count, 1);
  assert.equal(beforeRestart.entry.evidence_integrity_status, "verified");

  database.close();
  database = undefined;

  const replayEmission = emit("completed-replay.json", runId);
  assert.equal(replayEmission.metadata.reconstructed_from_outbox, true);
  assert.equal(replayEmission.metadata.provider_calls, 0);
  assert.deepEqual(replayEmission.events, firstEmission.events);

  database = createDatabase(databasePath);
  ledger = new AgentRunLedgerService(database);
  const replayWrites = replayEmission.events.map((entry) => ledger.appendEntry(entry));
  assert.equal(replayWrites.every((result) => result.replayed === true), true);
  assert.deepEqual(countsForRun(runId), { summaries: 1, transitions: 6 });
  assert.deepEqual(ledger.getRun(runId), beforeRestart);

  const completed = replayEmission.events.at(-1);
  const evidence = completed.evidence_refs[0];
  const mismatchCodes = {
    scope: expectCode(
      () => ledger.appendEntry(recreatedEntry(completed, { product_id: "scope-mutation" })),
      "AGENT_RUN_LEDGER_SCOPE_MISMATCH",
      evidence,
    ),
    payload: expectCode(
      () => ledger.appendEntry(recreatedEntry(completed, { input_summary: "Changed controlled payload." })),
      "AGENT_RUN_LEDGER_PAYLOAD_MISMATCH",
      evidence,
    ),
    event: expectCode(
      () => ledger.appendEntry(recreatedEntry(completed, { event_id: `${runId}:changed-event` })),
      "AGENT_RUN_LEDGER_IDEMPOTENCY_MISMATCH",
      evidence,
    ),
  };
  assert.deepEqual(countsForRun(runId), { summaries: 1, transitions: 6 });

  const rejectionCodes = {
    evidence: expectCode(
      () => ledger.appendEntry({
        ...completed,
        evidence_refs: [],
        evidence_count: 0,
        evidence_integrity_status: "not_present",
      }),
      "COMPLETED_REQUIRES_EVIDENCE",
      evidence,
    ),
  };
  const productionImpact = recreatedEntry(completed, {
    production_impact: true,
    risk_level: "high",
  });
  rejectionCodes.approval = expectCode(
    () => ledger.appendEntry({
      ...productionImpact,
      approval_actor: null,
      approval_timestamp: null,
    }),
    "APPROVAL_METADATA_MISMATCH",
    evidence,
  );
  const secretCanary = "raw-secret-canary-cross-repository";
  rejectionCodes.secret = expectCode(
    () => ledger.appendEntry({
      ...replayEmission.events[0],
      input_summary: `Authorization: Bearer ${secretCanary}`,
    }),
    "FREE_TEXT_REQUIRES_REDACTION",
    evidence,
  );
  assertNoSecretBytes(secretCanary);
  assert.deepEqual(countsForRun(runId), { summaries: 1, transitions: 6 });

  const failedEmission = emit("failed.json", failedRunId, true);
  assert.equal(failedEmission.metadata.provider_calls, 0);
  assert.equal(failedEmission.events.at(-1).status, "failed");
  for (const entry of failedEmission.events) ledger.appendEntry(entry);
  assert.deepEqual(countsForRun(failedRunId), { summaries: 1, transitions: 5 });

  const exactFilters = {
    product: completed.product_id,
    workflow: completed.workflow_id,
    provider: completed.provider,
    model: completed.model,
    status: "completed",
    approvalStatus: "approved",
    validationResult: "passed",
    outcome: "success",
    from: completed.started_at,
    to: completed.started_at,
    limit: 10,
  };
  const filtered = ledger.listRuns(exactFilters);
  assert.deepEqual(filtered.filters, exactFilters);
  assert.deepEqual(filtered.runs.map((entry) => entry.run_id), [runId]);
  const failedFiltered = ledger.listRuns({
    status: "failed",
    validationResult: "failed",
    outcome: "failure",
    limit: 10,
  });
  assert.deepEqual(failedFiltered.runs.map((entry) => entry.run_id), [failedRunId]);

  const report = {
    scenario: "Agent Run Ledger P0 cross-repository demonstration",
    verdict: "PASS",
    runId,
    product: completed.product_id,
    workflow: completed.workflow_id,
    provider: completed.provider,
    model: completed.model,
    transitionSequence: beforeRestart.transitions.map((entry) => `${entry.sequence}:${entry.status}`),
    finalStatus: completed.status,
    evidenceCount: completed.evidence_count,
    authoritativeSummaryCount: countsForRun(runId).summaries,
    authoritativeTransitionCount: countsForRun(runId).transitions,
    replayedTransitions: replayWrites.filter((result) => result.replayed).length,
    duplicateCount: countsForRun(runId).summaries - 1,
    producerRestartReconstructedFromOutbox: replayEmission.metadata.reconstructed_from_outbox,
    operatorRestartReconstructedExactly: true,
    mismatchCodes,
    rejectionCodes,
    failedRunVisible: failedFiltered.runs[0].failure_code,
    allMandatoryFiltersMatched: filtered.runs.length === 1,
    providerEndpointInvocations:
      firstEmission.metadata.provider_calls
      + replayEmission.metadata.provider_calls
      + failedEmission.metadata.provider_calls,
    secretPersisted: false,
    temporaryOperatorDatabase: true,
    cleanRuntimeEntry: path.resolve(process.env.CHANTER_FRESH_RUNTIME_ENTRY),
  };
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (database) database.close();
  rmSync(root, { recursive: true, force: true });
}
