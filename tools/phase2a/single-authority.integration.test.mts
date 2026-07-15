import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  AutoPosterOperationsPort,
  AutoPosterScheduleParams,
  RuntimeMissionResult,
} from "chanter-agent-runtime";

const originalEnvironment = {
  operatorBaseUrl: process.env.OPERATOR_BASE_URL,
  missionSubmitToken: process.env.OPERATOR_MISSION_SUBMIT_TOKEN,
  missionControlToken: process.env.OPERATOR_CONTROL_TOKEN,
  ledgerToken: process.env.OPERATOR_LEDGER_INGEST_TOKEN,
  operatorTimeout: process.env.OPERATOR_TIMEOUT_MS,
};

const missionSubmitToken = `phase2a-submit-${randomUUID()}`;
const missionControlToken = `phase2a-control-${randomUUID()}`;
const ledgerToken = `phase2a-ledger-${randomUUID()}`;
const providerToken = `phase2a-provider-${randomUUID()}`;
process.env.OPERATOR_MISSION_SUBMIT_TOKEN = missionSubmitToken;
process.env.OPERATOR_CONTROL_TOKEN = missionControlToken;
process.env.OPERATOR_LEDGER_INGEST_TOKEN = ledgerToken;
process.env.OPERATOR_TIMEOUT_MS = "5000";

const [
  { createApp },
  { AuditLogger },
  { AgentRunLedgerService },
  { createDatabase },
  { MockRunner },
  { AutoPosterMissionService },
  { createAutoPosterRuntimeMissionExecutor },
  { OperatorService },
  { ensureWorkspace },
  { handleAutoposterSchedulePost },
  { configureOperatorClientForTestingMcp },
] = await Promise.all([
  import("../../apps/backend/src/app.js"),
  import("../../apps/backend/src/audit/auditLogger.js"),
  import("../../apps/backend/src/agentRunLedger/agentRunLedgerService.js"),
  import("../../apps/backend/src/db/database.js"),
  import("../../apps/backend/src/runners/mockRunner.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterMissionService.js"),
  import("../../apps/backend/src/runtimeMissions/autoPosterRuntime.js"),
  import("../../apps/backend/src/services/operatorService.js"),
  import("../../apps/backend/src/workspace/pathGuard.js"),
  import("../../../chanter-mcp-server/src/tools/autoposterRuntimeTools.js"),
  import("../../../chanter-mcp-server/src/runtime/autoposterGateway.js"),
]);

interface RunningOperator {
  appBaseUrl: string;
  auditPath: string;
  database: DatabaseSync;
  ledger: InstanceType<typeof AgentRunLedgerService>;
  missionService: InstanceType<typeof AutoPosterMissionService>;
  server: Server;
}

interface HttpObservation {
  method: string;
  path: string;
  source: "mcp" | "operator-control" | "capability-probe";
  status: number;
}

const scheduleCalls: AutoPosterScheduleParams[] = [];
const canonicalWorkspaceId = "workspace-phase2a-0001";
const canonicalAccountId = "account-phase2a-0001";
const queueDraftId = "phase2a-queue-draft-0001";

function connectedAccount(provider: "tiktok" | "youtube") {
  return {
    connectedAccountId: `${provider}:${canonicalAccountId}`,
    accountId: canonicalAccountId,
    provider,
    providerDisplayName: provider === "youtube" ? "YouTube" : "TikTok",
    username: "phase2a_creator",
    displayName: "Phase 2A Creator",
    connectionStatus: "connected" as const,
    publishingReady: true,
    readinessBlockers: [],
    lastVerifiedAt: "2026-07-15T08:00:00.000Z",
  };
}

const fakeAutoPosterPort: AutoPosterOperationsPort = {
  async listConnectedAccounts(params) {
    const account = connectedAccount("tiktok");
    return {
      ok: true,
      workspaceId: params.workspaceId,
      accounts: [account],
      count: 1,
    };
  },
  async validateConnectedAccount(params) {
    return {
      ok: true,
      workspaceId: params.workspaceId ?? canonicalWorkspaceId,
      account: connectedAccount(params.provider as "tiktok" | "youtube"),
    };
  },
  async listQueue() {
    return { ok: true, items: [], count: 0, scope: { accountId: "all" } };
  },
  async getPostStatus(params) {
    return {
      ok: true,
      post: {
        id: params.postId,
        accountId: params.accountId ?? canonicalAccountId,
        username: "phase2a_creator",
        status: "scheduled",
        scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
        approved: false,
        mediaType: "video",
        captionSummary: "",
        createdAt: null,
        updatedAt: null,
        approvedAt: null,
        approvedBy: "",
        postedAt: null,
        publishId: "",
        claimAttempts: 0,
        lastErrorMessage: "",
      },
    };
  },
  async validateMedia() {
    return {
      ok: true,
      valid: true,
      classification: "video",
      policy: { videoOnly: true, allowedExtensions: [".mp4"] },
    };
  },
  async schedulePost(params) {
    scheduleCalls.push(params);
    return {
      ok: true,
      duplicate: false,
      post: {
        id: queueDraftId,
        accountId: params.accountId,
        provider: params.provider ?? "tiktok",
        status: "scheduled",
        scheduledAt: params.scheduledAt,
        approved: false,
      },
    };
  },
  async reconcileSchedule() {
    return {
      ok: true,
      outcome: "not_found",
      count: 0,
      unique: true,
      safeToReuse: false,
      approvalState: "not_started",
      publishingState: "not_started",
      evidenceStatus: "not_found",
    };
  },
};

async function startOperator(root: string, databasePath: string): Promise<RunningOperator> {
  const database = createDatabase(databasePath);
  const auditPath = path.join(root, "operator-audit.jsonl");
  const operatorService = new OperatorService(
    database,
    new AuditLogger(auditPath),
    new MockRunner(),
    ensureWorkspace(path.join(root, "workspace")),
  );
  const protectedValues = [
    providerToken,
    missionSubmitToken,
    missionControlToken,
    ledgerToken,
  ];
  const ledger = new AgentRunLedgerService(database, protectedValues);
  const executor = createAutoPosterRuntimeMissionExecutor(
    {
      baseUrl: "https://autoposter.phase2a.test",
      serviceToken: providerToken,
      userId: "owner",
      timeoutValid: true,
    },
    { port: fakeAutoPosterPort },
  );
  const missionService = new AutoPosterMissionService(database, executor, {
    agentRunLedgerService: ledger,
    protectedValues,
  });
  const app = createApp(operatorService, missionService, ledger);
  const server = await new Promise<Server>((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  const address = server.address() as AddressInfo;
  return {
    appBaseUrl: `http://127.0.0.1:${address.port}`,
    auditPath,
    database,
    ledger,
    missionService,
    server,
  };
}

async function stopOperator(running: RunningOperator): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    running.server.close((error) => error ? reject(error) : resolve());
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
  restore("OPERATOR_TIMEOUT_MS", originalEnvironment.operatorTimeout);
}

function countRows(database: DatabaseSync, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return Number(row.count);
}

function runtimePost(result: RuntimeMissionResult): {
  id?: string;
  approved?: boolean;
  publishing?: string;
} {
  const output = result.output as {
    post?: { id?: string; approved?: boolean };
    publishing?: string;
  } | null;
  return {
    id: output?.post?.id,
    approved: output?.post?.approved,
    publishing: output?.publishing,
  };
}

test("Phase 2A: one authoritative mission survives MCP and Operator recreation", { timeout: 30_000 }, async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "chanter-phase2a-authority-"));
  const databasePath = path.join(root, "operator.sqlite");
  let running: RunningOperator | undefined;
  const originalGlobalFetch = globalThis.fetch;

  context.after(async () => {
    globalThis.fetch = originalGlobalFetch;
    configureOperatorClientForTestingMcp(null);
    if (running) await stopOperator(running);
    restoreEnvironment();
    rmSync(root, { recursive: true, force: true });
  });

  running = await startOperator(root, databasePath);
  process.env.OPERATOR_BASE_URL = running.appBaseUrl;
  const httpObservations: HttpObservation[] = [];
  const observingFetch = (
    source: HttpObservation["source"],
  ): typeof fetch => async (input, init) => {
      const response = await originalGlobalFetch(input, init);
      const url = new URL(String(input));
      httpObservations.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        source,
        status: response.status,
      });
      return response;
    };
  configureOperatorClientForTestingMcp({
    config: { baseUrl: running.appBaseUrl, token: missionSubmitToken, timeoutMs: 5_000 },
    fetchImpl: observingFetch("mcp"),
  });

  const missionId = "phase2a-stable-mission-0001";
  const traceId = "phase2a-stable-trace-0001";
  const idempotencyKey = "phase2a-stable-key-0001";
  const scheduledAtUtc = new Date(Date.now() + 3_600_000).toISOString();
  const request = {
    accountId: canonicalAccountId,
    provider: "tiktok",
    mediaUrl: "https://cdn.example.com/phase2a-proof.mp4",
    scheduledAtUtc,
    idempotencyKey,
    caption: "Phase 2A single-authority proof",
    hashtags: "#chanter #phase2a",
    requestedBy: "chanter-mcp-server",
    missionId,
    traceId,
  };

  const approvalRequired = await handleAutoposterSchedulePost(request);
  assert.equal(approvalRequired.status, "approval_required");
  assert.equal(approvalRequired.missionId, missionId);
  assert.equal(approvalRequired.traceId, traceId);
  assert.equal(approvalRequired.output, null);
  assert.equal(approvalRequired.evidence, null);
  assert.equal(scheduleCalls.length, 0);
  assert.equal(countRows(running.database, "autoposter_runtime_missions"), 1);
  assert.deepEqual(
    running.ledger.getRun(missionId).transitions.map((entry) => entry.status),
    ["created", "approval_required"],
  );

  const approvalUrl = `${running.appBaseUrl}/api/runtime-missions/${missionId}/approve`;
  const requestApproval = async (
    token: string | undefined,
    source: HttpObservation["source"],
  ) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (token) headers.authorization = `Bearer ${token}`;
    const response = await observingFetch(source)(approvalUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({ approvedBy: "founder-phase2a" }),
      redirect: "error",
    });
    return { response, body: await response.json() as Record<string, unknown> };
  };

  const missingControlApproval = await requestApproval(undefined, "capability-probe");
  const submitTokenApproval = await requestApproval(missionSubmitToken, "capability-probe");
  const ledgerTokenApproval = await requestApproval(ledgerToken, "capability-probe");
  const providerTokenApproval = await requestApproval(providerToken, "capability-probe");
  for (const denied of [
    missingControlApproval,
    submitTokenApproval,
    ledgerTokenApproval,
    providerTokenApproval,
  ]) {
    assert.equal(denied.response.status, 401);
  }
  assert.equal(scheduleCalls.length, 0);
  assert.deepEqual(
    running.ledger.getRun(missionId).transitions.map((entry) => entry.status),
    ["created", "approval_required"],
  );

  const independentApproval = await requestApproval(
    missionControlToken,
    "operator-control",
  );
  assert.equal(independentApproval.response.status, 200);
  assert.equal(independentApproval.body.status, "succeeded");
  assert.equal(independentApproval.body.approvedBy, "founder-phase2a");
  const firstExecution = independentApproval.body.runtimeResult as RuntimeMissionResult;
  assert.ok(firstExecution);
  assert.equal(firstExecution.status, "succeeded");
  assert.deepEqual(runtimePost(firstExecution), {
    id: queueDraftId,
    approved: false,
    publishing: "blocked_until_human_approval",
  });
  assert.equal(firstExecution.idempotency.outcome, "first_execution");
  assert.equal(scheduleCalls.length, 1);
  const ledgerAfterApproval = running.ledger.getRun(missionId);
  const journalAfterApproval = running.database.prepare(
    "SELECT new_state, actor FROM autoposter_mission_journal WHERE mission_id = ? ORDER BY sequence",
  ).all(missionId);

  const exactReplay = await handleAutoposterSchedulePost(request);
  assert.equal(exactReplay.status, "duplicate");
  assert.equal(exactReplay.missionId, missionId);
  assert.equal(exactReplay.idempotency.outcome, "duplicate");
  assert.equal(exactReplay.idempotency.originalMissionId, missionId);
  assert.equal(scheduleCalls.length, 1);
  assert.deepEqual(running.ledger.getRun(missionId), ledgerAfterApproval);
  assert.deepEqual(
    running.database.prepare(
      "SELECT new_state, actor FROM autoposter_mission_journal WHERE mission_id = ? ORDER BY sequence",
    ).all(missionId),
    journalAfterApproval,
  );

  configureOperatorClientForTestingMcp(null);
  configureOperatorClientForTestingMcp(undefined);
  globalThis.fetch = observingFetch("mcp");
  const afterMcpRecreation = await handleAutoposterSchedulePost(request);
  assert.equal(afterMcpRecreation.status, "duplicate");
  assert.equal(afterMcpRecreation.missionId, missionId);
  assert.equal(scheduleCalls.length, 1);

  await stopOperator(running);
  running = undefined;
  running = await startOperator(root, databasePath);
  process.env.OPERATOR_BASE_URL = running.appBaseUrl;
  configureOperatorClientForTestingMcp(undefined);
  const afterOperatorRestart = await handleAutoposterSchedulePost(request);
  assert.equal(afterOperatorRestart.status, "duplicate");
  assert.equal(afterOperatorRestart.missionId, missionId);
  assert.equal(scheduleCalls.length, 1);
  assert.equal(countRows(running.database, "autoposter_runtime_missions"), 1);
  globalThis.fetch = originalGlobalFetch;

  configureOperatorClientForTestingMcp({
    config: { baseUrl: running.appBaseUrl, token: missionSubmitToken, timeoutMs: 5_000 },
    fetchImpl: observingFetch("mcp"),
  });
  const mismatch = await handleAutoposterSchedulePost({
    ...request,
    caption: "Changed caption must conflict",
  });
  assert.equal(mismatch.status, "validation_failed");
  assert.equal(mismatch.idempotency.outcome, "mismatch");
  assert.equal(mismatch.errors[0]?.code, "OPERATOR_MISSION_PAYLOAD_MISMATCH");
  assert.equal(mismatch.output, null);
  assert.equal(mismatch.evidence, null);
  assert.equal(JSON.stringify(mismatch).includes(queueDraftId), false);
  assert.equal(scheduleCalls.length, 1);

  const protectedMissionBody = {
    accountId: canonicalAccountId,
    provider: "tiktok",
    mediaUrl: request.mediaUrl,
    caption: request.caption,
    hashtags: request.hashtags,
    scheduledAt: scheduledAtUtc,
    idempotencyKey: "phase2a-token-probe-key",
    missionId: "phase2a-token-probe-mission",
    traceId: "phase2a-token-probe-trace",
    requestedBy: "phase2a-token-probe",
  };
  const missingSubmitToken = await fetch(
    `${running.appBaseUrl}/api/runtime-missions/autoposter/schedule`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(protectedMissionBody),
      redirect: "error",
    },
  );
  const missingSubmitTokenBody = await missingSubmitToken.json();
  const wrongSubmitToken = await fetch(
    `${running.appBaseUrl}/api/runtime-missions/autoposter/schedule`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-phase2a-submit-token",
        "content-type": "application/json",
      },
      body: JSON.stringify(protectedMissionBody),
      redirect: "error",
    },
  );
  const wrongSubmitTokenBody = await wrongSubmitToken.json();
  assert.equal(missingSubmitToken.status, 401);
  assert.equal(wrongSubmitToken.status, 401);

  const missingLedgerToken = await fetch(
    `${running.appBaseUrl}/api/agent-run-ledger/entries`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      redirect: "error",
    },
  );
  const missingLedgerTokenBody = await missingLedgerToken.json();
  const wrongLedgerToken = await fetch(
    `${running.appBaseUrl}/api/agent-run-ledger/entries`,
    {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-phase2a-ledger-token",
        "content-type": "application/json",
      },
      body: "{}",
      redirect: "error",
    },
  );
  const wrongLedgerTokenBody = await wrongLedgerToken.json();
  assert.equal(missingLedgerToken.status, 401);
  assert.equal(wrongLedgerToken.status, 401);

  const ledgerBeforeReplay = running.ledger.getRun(missionId);
  const acceptedLedgerReplay = await fetch(
    `${running.appBaseUrl}/api/agent-run-ledger/entries`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${ledgerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(ledgerBeforeReplay.entry),
      redirect: "error",
    },
  );
  const acceptedLedgerReplayBody = await acceptedLedgerReplay.json() as {
    replayed?: boolean;
  };
  assert.equal(acceptedLedgerReplay.status, 200);
  assert.equal(acceptedLedgerReplayBody.replayed, true);
  assert.deepEqual(running.ledger.getRun(missionId), ledgerBeforeReplay);

  const storedMission = running.database.prepare(
    "SELECT runtime_result_json FROM autoposter_runtime_missions WHERE mission_id = ?",
  ).get(missionId) as { runtime_result_json: string };
  const expectedRuntimeResultSha256 = createHash("sha256")
    .update(storedMission.runtime_result_json, "utf8")
    .digest("hex");
  const ledgerRun = running.ledger.getRun(missionId);
  assert.deepEqual(ledgerRun, ledgerAfterApproval);
  assert.deepEqual(
    ledgerRun.transitions.map((entry) => entry.status),
    ["created", "approval_required", "approved", "running", "validating", "completed"],
  );
  assert.equal(ledgerRun.entry.run_id, missionId);
  assert.equal(ledgerRun.entry.trace_id, traceId);
  assert.equal(ledgerRun.entry.approval_actor, "founder-phase2a");
  assert.equal(ledgerRun.entry.evidence_refs[0]?.sha256, expectedRuntimeResultSha256);
  assert.equal(new Set(ledgerRun.transitions.map((entry) => entry.attempt_id)).size, 1);

  const journalRows = running.database.prepare(
    "SELECT new_state, actor FROM autoposter_mission_journal WHERE mission_id = ? ORDER BY sequence",
  ).all(missionId) as unknown as Array<{ new_state: string; actor: string }>;
  assert.equal(journalRows.filter((row) => row.new_state === "approved").length, 1);
  assert.equal(journalRows.find((row) => row.new_state === "approved")?.actor, "founder-phase2a");
  assert.deepEqual(journalRows, journalAfterApproval);
  assert.equal(countRows(running.database, "autoposter_runtime_missions"), 1);
  assert.equal(scheduleCalls.length, 1);

  const mcpHttpObservations = httpObservations.filter(({ source }) => source === "mcp");
  assert.deepEqual(
    mcpHttpObservations.map(({ path, status }) => ({ path, status })),
    [
      { path: "/api/runtime-missions/autoposter/schedule", status: 201 },
      { path: "/api/runtime-missions/autoposter/schedule", status: 200 },
      { path: "/api/runtime-missions/autoposter/schedule", status: 200 },
      { path: "/api/runtime-missions/autoposter/schedule", status: 200 },
      { path: "/api/runtime-missions/autoposter/schedule", status: 409 },
    ],
  );
  assert.equal(
    mcpHttpObservations.some(({ path }) => path.endsWith("/approve")),
    false,
  );
  assert.deepEqual(
    httpObservations
      .filter(({ source }) => source === "operator-control")
      .map(({ path, status }) => ({ path, status })),
    [{ path: `/api/runtime-missions/${missionId}/approve`, status: 200 }],
  );
  assert.deepEqual(
    httpObservations
      .filter(({ source }) => source === "capability-probe")
      .map(({ path, status }) => ({ path, status })),
    Array.from({ length: 4 }, () => ({
      path: `/api/runtime-missions/${missionId}/approve`,
      status: 401,
    })),
  );
  const auditText = existsSync(running.auditPath)
    ? readFileSync(running.auditPath, "utf8")
    : "";
  const tokenSafetySurface = JSON.stringify({
    approvalRequired,
    independentApproval: independentApproval.body,
    firstExecution,
    exactReplay,
    afterMcpRecreation,
    afterOperatorRestart,
    mismatch,
    ledgerRun,
    storedMission,
    journalRows,
    missingSubmitTokenBody,
    wrongSubmitTokenBody,
    missingControlApprovalBody: missingControlApproval.body,
    submitTokenApprovalBody: submitTokenApproval.body,
    ledgerTokenApprovalBody: ledgerTokenApproval.body,
    providerTokenApprovalBody: providerTokenApproval.body,
    missingLedgerTokenBody,
    wrongLedgerTokenBody,
    acceptedLedgerReplayBody,
    auditText,
  });
  for (const token of [
    missionSubmitToken,
    missionControlToken,
    ledgerToken,
    providerToken,
  ]) {
    assert.equal(tokenSafetySurface.includes(token), false);
  }

  const evidence = {
    missionId,
    traceId,
    idempotencyKey,
    durableOperatorRecords: 1,
    firstRequest: {
      operatorHttpStatus: 201,
      mcpStatus: approvalRequired.status,
      approvalRequired: true,
      downstreamWrites: 0,
    },
    independentControlApproval: {
      operatorHttpStatus: independentApproval.response.status,
      operatorMissionStatus: independentApproval.body.status,
      mcpApprovalRequests: mcpHttpObservations.filter(({ path }) => path.endsWith("/approve")).length,
      downstreamWrites: 1,
      queueDraftId,
      approved: false,
      publishing: runtimePost(firstExecution).publishing,
    },
    exactReplay: {
      operatorHttpStatus: 200,
      mcpStatus: exactReplay.status,
      idempotencyOutcome: exactReplay.idempotency.outcome,
      approvalEventsAppended: 0,
      ledgerEventsAppended: 0,
      downstreamWrites: 1,
    },
    mcpRecreation: {
      mcpStatus: afterMcpRecreation.status,
      sameMissionId: afterMcpRecreation.missionId === missionId,
      downstreamWrites: 1,
    },
    operatorRestart: {
      sqliteReopened: true,
      mcpStatus: afterOperatorRestart.status,
      sameMissionId: afterOperatorRestart.missionId === missionId,
      downstreamWrites: 1,
    },
    mismatch: {
      operatorHttpStatus: 409,
      mcpStatus: mismatch.status,
      code: mismatch.errors[0]?.code,
      output: mismatch.output,
      evidence: mismatch.evidence,
      downstreamWrites: 1,
    },
    approval: {
      actor: ledgerRun.entry.approval_actor,
      durableApprovalTransitions: 1,
    },
    capabilityTokens: {
      missingSubmitTokenStatus: missingSubmitToken.status,
      wrongSubmitTokenStatus: wrongSubmitToken.status,
      missingControlTokenApprovalStatus: missingControlApproval.response.status,
      submitTokenApprovalStatus: submitTokenApproval.response.status,
      ledgerTokenApprovalStatus: ledgerTokenApproval.response.status,
      autoPosterServiceTokenApprovalStatus: providerTokenApproval.response.status,
      missingLedgerTokenStatus: missingLedgerToken.status,
      wrongLedgerTokenStatus: wrongLedgerToken.status,
      validLedgerExactReplayStatus: acceptedLedgerReplay.status,
      tokensAbsentFromResultsEvidenceAndAudit: true,
    },
    ledger: {
      runId: ledgerRun.entry.run_id,
      traceId: ledgerRun.entry.trace_id,
      statuses: ledgerRun.transitions.map((entry) => entry.status),
      runtimeResultSha256: expectedRuntimeResultSha256,
    },
  };
  console.log(`PHASE2A_SINGLE_AUTHORITY_EVIDENCE ${JSON.stringify(evidence)}`);
});

test("Phase 2A: the loopback UI proxy separates submit and control capabilities server-side", { timeout: 30_000 }, async (context) => {
  const proxySubmitToken = `phase2a-ui-submit-${randomUUID()}`;
  const proxyControlToken = `phase2a-ui-control-${randomUUID()}`;
  const previousSubmitToken = process.env.OPERATOR_MISSION_SUBMIT_TOKEN;
  const previousControlToken = process.env.OPERATOR_CONTROL_TOKEN;
  process.env.OPERATOR_MISSION_SUBMIT_TOKEN = proxySubmitToken;
  process.env.OPERATOR_CONTROL_TOKEN = proxyControlToken;
  const observed: Array<{
    authorization: string | null;
    method: string | undefined;
    origin: string | null;
    url: string | undefined;
  }> = [];
  const target = createHttpServer((request, response) => {
    observed.push({
      authorization: request.headers.authorization ?? null,
      method: request.method,
      origin: request.headers.origin ?? null,
      url: request.url,
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  await new Promise<void>((resolve, reject) => {
    target.once("error", reject);
    target.listen(3001, "127.0.0.1", resolve);
  });
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    configFile: path.resolve("apps/frontend/vite.config.ts"),
    logLevel: "silent",
  });
  context.after(async () => {
    await vite.close();
    await new Promise<void>((resolve, reject) => {
      target.close((error) => error ? reject(error) : resolve());
    });
    if (previousSubmitToken === undefined) delete process.env.OPERATOR_MISSION_SUBMIT_TOKEN;
    else process.env.OPERATOR_MISSION_SUBMIT_TOKEN = previousSubmitToken;
    if (previousControlToken === undefined) delete process.env.OPERATOR_CONTROL_TOKEN;
    else process.env.OPERATOR_CONTROL_TOKEN = previousControlToken;
  });
  await vite.listen();

  const page = await fetch("http://127.0.0.1:5173/");
  const pageText = await page.text();
  const postProxy = async (pathname: string, origin?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (origin) headers.origin = origin;
    await fetch(`http://127.0.0.1:5173${pathname}`, {
      method: "POST",
      headers,
      body: "{}",
    });
  };

  await fetch("http://127.0.0.1:5173/api/health");
  await fetch("http://127.0.0.1:5173/api/runtime-missions", {
    headers: { origin: "http://127.0.0.1:5173" },
  });
  await postProxy("/api/runtime-missions", "http://127.0.0.1:5173");
  await postProxy("/api/runtime-missions/autoposter/schedule", "http://127.0.0.1:5173");
  for (const action of ["approve", "reconcile", "resume", "stop"]) {
    await postProxy(`/api/runtime-missions/example/${action}`, "http://127.0.0.1:5173");
  }
  await postProxy("/api/tasks", "http://127.0.0.1:5173");
  await postProxy("/api/runtime-missions/autoposter/schedule", "https://example.invalid");
  await postProxy("/api/runtime-missions/example/approve", "https://example.invalid");
  await postProxy("/api/runtime-missions/autoposter/schedule");
  await postProxy("/api/runtime-missions/example/approve");

  assert.equal(observed.length, 13);
  assert.deepEqual(
    observed.map(({ authorization }) => authorization),
    [
      null,
      null,
      `Bearer ${proxySubmitToken}`,
      `Bearer ${proxySubmitToken}`,
      `Bearer ${proxyControlToken}`,
      `Bearer ${proxyControlToken}`,
      `Bearer ${proxyControlToken}`,
      `Bearer ${proxyControlToken}`,
      null,
      null,
      null,
      null,
      null,
    ],
  );
  assert.equal(pageText.includes(proxySubmitToken), false);
  assert.equal(pageText.includes(proxyControlToken), false);
  console.log(`PHASE2A_UI_PROXY_EVIDENCE ${JSON.stringify({
    requests: observed.length,
    submitRoutesInjected: 2,
    controlRoutesInjected: 4,
    readUnmodified: true,
    unrelatedWriteUnmodified: true,
    foreignOriginUnmodified: true,
    originlessProtectedWriteUnmodified: true,
    tokensReturnedToBrowser: false,
  })}`);
});
