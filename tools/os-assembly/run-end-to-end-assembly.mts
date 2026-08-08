/**
 * CHANTER OS — end-to-end operational assembly proof.
 *
 * One canonical, repeatable, locally verified mission path:
 *
 *   chanter.mission.v1 envelope
 *   -> real Operator HTTP server process (apps/backend/src/server.ts, i.e. the
 *      production createRuntime() wiring — not a hand-built harness)
 *   -> durable operator_missions spine (201 approval_required)
 *   -> persisted, signed human approval bound to an exact repository revision
 *   -> real chanter-agent-runtime executeMission + Loop Governor adapter
 *   -> real `python -m governor.mission_intake` child process (no shell)
 *   -> exactly one Loop Governor manual (agent-frozen) task + relay loop
 *   -> abrupt process kill, restart, replay, and typed payload refusal.
 *
 * Everything runs against disposable temporary directories. Nothing publishes,
 * deploys, or touches a live product checkout. Real coding-agent execution
 * stays frozen end to end.
 *
 * Usage:
 *   npm run os:assembly
 *   npm run os:assembly -- --out <dir> --keep
 */
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const serverEntry = path.join(operatorRoot, "apps", "backend", "src", "server.ts");
const envelopeExample = path.join(here, "mission-envelope.example.json");

const APPROVER = "founder";
const ISSUER_AUTHORITY_ID = "chanter.operator.os-assembly";
const ISSUER_KEY_ID = "os-assembly-key-1";
/** The approval policy id Operator's seam mints by default. */
const AUTHORIZED_POLICY_IDS = ["chanter.operator.human-approval.v1"];
const HEALTH_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const keepArtifacts = argv.includes("--keep");
const outputDir = path.resolve(argValue("--out") ?? path.join(operatorRoot, "var", "os-assembly"));

// ---------------------------------------------------------------------------
// Step recording — every claim in the terminal result is an observation
// ---------------------------------------------------------------------------

interface StepRecord {
  step: number;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  error?: string;
}

const steps: StepRecord[] = [];
let stepNumber = 0;

async function step(
  name: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  stepNumber += 1;
  const current = stepNumber;
  try {
    const observed = await run();
    steps.push({ step: current, name, outcome: "passed", observed });
    console.log(`  [${String(current).padStart(2, "0")}] PASS  ${name}`);
    return observed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ step: current, name, outcome: "failed", observed: {}, error: message });
    console.error(`  [${String(current).padStart(2, "0")}] FAIL  ${name}`);
    console.error(`        ${message.split("\n")[0]}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

function git(repositoryRoot: string, args: readonly string[]): void {
  execFileSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
}

/**
 * The Runtime binds every approval to a real repository identity, an exact
 * committed HEAD, and a strictly clean worktree, so the proof needs a real
 * Git checkout. A disposable one is used on purpose: binding directly to a
 * live product checkout is permanently fail-closed under the Runtime's
 * `tracked_and_untracked` clean-state policy.
 */
function createApprovalRepository(root: string): { repositoryRoot: string; head: string } {
  const repositoryRoot = path.join(root, "approval-authority-repo");
  mkdirSync(repositoryRoot, { recursive: true });
  git(repositoryRoot, ["init", "--quiet"]);
  git(repositoryRoot, ["config", "user.name", "CHANTER OS Assembly"]);
  git(repositoryRoot, ["config", "user.email", "os-assembly@invalid.local"]);
  git(repositoryRoot, ["config", "commit.gpgsign", "false"]);
  writeFileSync(path.join(repositoryRoot, "APPROVAL_AUTHORITY.md"), "os assembly approval authority\n", "utf8");
  git(repositoryRoot, ["add", "--", "APPROVAL_AUTHORITY.md"]);
  git(repositoryRoot, ["commit", "--quiet", "-m", "approval authority"]);
  const head = execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  return { repositoryRoot, head };
}

/** A disposable Ed25519 signing identity, supplied exactly as a deployment does. */
function createIssuer(root: string): { privateKeyFile: string; trustedIssuersFile: string } {
  const issuerDir = path.join(root, "approval-issuer");
  mkdirSync(issuerDir, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const privateKeyFile = path.join(issuerDir, "issuer.key.pem");
  writeFileSync(privateKeyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
    encoding: "utf8",
    mode: 0o600,
  });
  const trustedIssuersFile = path.join(issuerDir, "trusted-issuers.json");
  writeFileSync(
    trustedIssuersFile,
    JSON.stringify({
      issuers: [{
        authorityId: ISSUER_AUTHORITY_ID,
        authorizedPolicyIds: AUTHORIZED_POLICY_IDS,
        keys: [{
          keyId: ISSUER_KEY_ID,
          publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        }],
      }],
    }),
    "utf8",
  );
  return { privateKeyFile, trustedIssuersFile };
}

function resolvePython(): string {
  const configured = process.env.LOOP_GOVERNOR_PYTHON?.trim();
  if (configured && path.isAbsolute(configured)) return configured;
  const probe = spawnSync(process.platform === "win32" ? "where" : "which", [configured || "python"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const found = probe.stdout
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0 && path.isAbsolute(line));
  assert.ok(found, "An absolute python executable is required for the assembly proof.");
  return found;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error("No free port available."))));
    });
  });
}

// ---------------------------------------------------------------------------
// Operator server process control
// ---------------------------------------------------------------------------

interface OperatorProcess {
  child: ChildProcess;
  baseUrl: string;
  pid: number;
}

async function startOperator(environment: Record<string, string>, port: number): Promise<OperatorProcess> {
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: operatorRoot,
    env: { ...process.env, ...environment, OPERATOR_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  let exited = false;
  child.once("exit", () => (exited = true));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`Operator server exited before becoming healthy.\n${logs.join("")}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return { child, baseUrl, pid: child.pid ?? -1 };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`Operator server did not become healthy within ${HEALTH_TIMEOUT_MS}ms.\n${logs.join("")}`);
}

/**
 * An abrupt kill, not a graceful shutdown: durable state must survive a real
 * interruption, which is exactly the property under test.
 */
function killOperator(operator: OperatorProcess): Promise<void> {
  return new Promise((resolve) => {
    if (operator.child.exitCode !== null || operator.child.signalCode !== null) {
      resolve();
      return;
    }
    operator.child.once("exit", () => resolve());
    operator.child.kill();
  });
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(
  baseUrl: string,
  route: string,
  token: string | null,
  body: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function getJson(baseUrl: string, route: string): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${route}`);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

// ---------------------------------------------------------------------------
// Loop Governor state observation (read directly from its isolated data dir)
// ---------------------------------------------------------------------------

function governorTaskIds(governorDataDir: string): string[] {
  const tasksDir = path.join(governorDataDir, "tasks");
  if (!existsSync(tasksDir)) return [];
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function governorLoopCount(governorDataDir: string): number {
  const loopsFile = path.join(governorDataDir, "loops.json");
  if (!existsSync(loopsFile)) return 0;
  const parsed = JSON.parse(readFileSync(loopsFile, "utf8")) as unknown;
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") return Object.keys(parsed).length;
  return 0;
}

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object.");
  return value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-assembly-"));
let operator: OperatorProcess | null = null;
let verdict: "PASS" | "FAIL" = "FAIL";
let failure: string | null = null;

const startedAt = new Date().toISOString();
const missionId = `chanter-os-assembly-${Date.now().toString(36)}`;
const submitToken = `os-assembly-submit-${Math.random().toString(36).slice(2)}`;
const controlToken = `os-assembly-control-${Math.random().toString(36).slice(2)}`;
const ledgerToken = `os-assembly-ledger-${Math.random().toString(36).slice(2)}`;

const governorDataDir = path.join(temporaryRoot, "governor-data");
const approvalStateDir = path.join(temporaryRoot, "approval-state");
mkdirSync(governorDataDir, { recursive: true });
mkdirSync(approvalStateDir, { recursive: true });

const envelopeTemplate = JSON.parse(readFileSync(envelopeExample, "utf8")) as Record<string, unknown>;
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...envelopeTemplate,
    missionId,
    traceId: `${missionId}-trace`,
    idempotencyKey: `${missionId}-key`,
    requestedAt: new Date().toISOString(),
    ...overrides,
  };
}

const observedIds: Record<string, unknown> = { missionId };

try {
  console.log("CHANTER OS — end-to-end operational assembly proof");
  console.log(`  temporary root: ${temporaryRoot}`);

  const python = resolvePython();
  const { repositoryRoot, head } = createApprovalRepository(temporaryRoot);
  const { privateKeyFile, trustedIssuersFile } = createIssuer(temporaryRoot);
  observedIds.approvalRepositoryHead = head;

  const environment: Record<string, string> = {
    OPERATOR_DATABASE_PATH: path.join(temporaryRoot, "operator.sqlite"),
    OPERATOR_AUDIT_PATH: path.join(temporaryRoot, "audit.jsonl"),
    OPERATOR_WORKSPACE_ROOT: path.join(temporaryRoot, "workspace"),
    OPERATOR_EVIDENCE_DIR: path.join(temporaryRoot, "evidence"),
    OPERATOR_MISSION_SUBMIT_TOKEN: submitToken,
    OPERATOR_CONTROL_TOKEN: controlToken,
    OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
    LOOP_GOVERNOR_PYTHON: python,
    LOOP_GOVERNOR_ROOT: governorRoot,
    LOOP_GOVERNOR_MISSION_DATA_DIR: governorDataDir,
    LOOP_GOVERNOR_TIMEOUT_MS: "60000",
    OPERATOR_APPROVAL_AUTHORITY_STATE_DIR: approvalStateDir,
    OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT: repositoryRoot,
    OPERATOR_APPROVAL_AUTHORITY_ISSUER_ID: ISSUER_AUTHORITY_ID,
    OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_ID: ISSUER_KEY_ID,
    OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_FILE: privateKeyFile,
    OPERATOR_APPROVAL_AUTHORITY_TRUSTED_ISSUERS_FILE: trustedIssuersFile,
  };

  const port = await freePort();
  operator = await startOperator(environment, port);
  const firstPid = operator.pid;
  observedIds.firstOperatorPid = firstPid;

  // -- 1. Submit the mission -------------------------------------------------
  await step("Submit mission envelope through the canonical intake route", async () => {
    const created = await postJson(operator!.baseUrl, "/api/runtime-missions", submitToken, envelope());
    assert.equal(created.status, 201, `Expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
    assert.equal(created.body.missionId, missionId);
    assert.equal(created.body.replayed, false);
    assert.equal(governorTaskIds(governorDataDir).length, 0, "Submission must not create any downstream side effect.");
    return {
      httpStatus: created.status,
      missionId: created.body.missionId,
      status: created.body.status,
      governorTasksAfterSubmit: 0,
    };
  });

  // -- 2. Approval-required state is durable and readable ---------------------
  const payloadHash = await step("Verify approval-required state on the canonical read route", async () => {
    const read = await getJson(operator!.baseUrl, `/api/runtime-missions/${missionId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "approval_required");
    assert.equal(read.body.approvalRequired, true);
    assert.equal(read.body.approvedBy, null);
    const execution = record(read.body.execution);
    assert.equal(execution.state, "approval_required");
    observedIds.missionPayloadHash = execution.missionPayloadHash;
    observedIds.downstreamOperationType = execution.downstreamOperationType;
    return {
      status: read.body.status,
      executionState: execution.state,
      missionPayloadHash: execution.missionPayloadHash,
      downstreamOperationType: execution.downstreamOperationType,
    };
  }).then((observed) => String(observed.missionPayloadHash));

  // -- 3. Approval is refused without the control capability ------------------
  await step("Refuse approval without the independent control capability", async () => {
    const withSubmit = await postJson(
      operator!.baseUrl, `/api/runtime-missions/${missionId}/approve`, submitToken, { approvedBy: APPROVER });
    assert.equal(withSubmit.status, 401, "The submit capability must not be able to approve.");
    const anonymous = await postJson(
      operator!.baseUrl, `/api/runtime-missions/${missionId}/approve`, null, { approvedBy: APPROVER });
    assert.equal(anonymous.status, 401);
    assert.equal(governorTaskIds(governorDataDir).length, 0, "A refused approval must not execute.");
    return { submitTokenStatus: withSubmit.status, anonymousStatus: anonymous.status };
  });

  // -- 4/5. Persist approval, execute, create exactly one task + loop ---------
  const terminal = await step(
    "Persist approval and execute through Agent Runtime into exactly one Governor task/loop",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/runtime-missions/${missionId}/approve`, controlToken, { approvedBy: APPROVER });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      assert.equal(approved.body.status, "succeeded", `Runtime result: ${JSON.stringify(approved.body.runtimeResult)}`);
      assert.equal(approved.body.approvedBy, APPROVER);

      const execution = record(approved.body.execution);
      assert.equal(execution.state, "completed");
      assert.equal(execution.evidenceStatus, "authoritative");
      assert.equal(execution.typedError, null);

      const downstream = record(execution.downstreamIds);
      assert.equal(downstream.created, true);
      assert.ok(String(downstream.taskId).length > 0, "A task id must be observed.");
      assert.ok(String(downstream.loopId).length > 0, "A loop id must be observed.");

      const runtimeResult = record(approved.body.runtimeResult);
      assert.equal(runtimeResult.status, "succeeded");
      const output = record(runtimeResult.output);
      assert.equal(output.realAgentExecution, false, "Real coding-agent execution must stay frozen.");

      // The task and loop genuinely exist in the isolated Loop Governor state.
      const taskIds = governorTaskIds(governorDataDir);
      assert.deepEqual(taskIds, [String(downstream.taskId)], "Exactly one Governor task must exist.");
      assert.equal(governorLoopCount(governorDataDir), 1, "Exactly one Governor loop must exist.");
      const taskJson = JSON.parse(
        readFileSync(path.join(governorDataDir, "tasks", String(downstream.taskId), "task.json"), "utf8"),
      ) as Record<string, unknown>;
      assert.ok(
        String(taskJson.scope).includes(`[chanter-mission:${missionId}]`),
        "The Governor task must carry its exact mission marker.",
      );
      assert.equal(taskJson.loop_id, downstream.loopId);

      observedIds.taskId = downstream.taskId;
      observedIds.loopId = downstream.loopId;
      observedIds.authoritativeLoopId = execution.authoritativeLoopId;

      return {
        httpStatus: approved.status,
        status: approved.body.status,
        approvedBy: approved.body.approvedBy,
        executionState: execution.state,
        evidenceStatus: execution.evidenceStatus,
        taskId: downstream.taskId,
        loopId: downstream.loopId,
        created: downstream.created,
        realAgentExecution: false,
        governorTaskCount: taskIds.length,
        governorLoopCount: 1,
      };
    },
  );

  // -- 6. Terminal result on the canonical read route -------------------------
  await step("Read the terminal result from the canonical read route", async () => {
    const read = await getJson(operator!.baseUrl, `/api/runtime-missions/${missionId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.status, "succeeded");
    const execution = record(read.body.execution);
    assert.equal(execution.state, "completed");
    assert.equal(String(execution.missionPayloadHash), payloadHash, "The payload hash must stay stable.");
    return {
      status: read.body.status,
      executionState: execution.state,
      authoritativeLoopId: execution.authoritativeLoopId,
      missionPayloadHash: execution.missionPayloadHash,
    };
  });

  // -- 7. Abrupt restart of the Operator process ------------------------------
  await step("Restart the Operator process abruptly against the same durable state", async () => {
    await killOperator(operator!);
    const restartPort = await freePort();
    operator = await startOperator(environment, restartPort);
    assert.notEqual(operator.pid, firstPid, "A genuinely new process must serve the replay.");
    observedIds.secondOperatorPid = operator.pid;
    return { killedPid: firstPid, restartedPid: operator.pid, sameDurableState: true };
  });

  // -- 8/9. Replay proves no duplicate task or loop ---------------------------
  await step("Replay the same mission after restart and prove no duplicate task or loop", async () => {
    const resubmitted = await postJson(operator!.baseUrl, "/api/runtime-missions", submitToken, envelope());
    assert.equal(resubmitted.status, 200, "A duplicate submission must return the same durable mission identity.");
    assert.equal(resubmitted.body.replayed, true);
    assert.equal(resubmitted.body.missionId, missionId);

    const reapproved = await postJson(
      operator!.baseUrl, `/api/runtime-missions/${missionId}/approve`, controlToken, { approvedBy: APPROVER });
    assert.equal(reapproved.status, 200);
    assert.equal(reapproved.body.status, "succeeded");
    const execution = record(reapproved.body.execution);
    const downstream = record(execution.downstreamIds);
    assert.equal(downstream.taskId, terminal.taskId, "Replay must return the same task identity.");
    assert.equal(downstream.loopId, terminal.loopId, "Replay must return the same loop identity.");

    const taskIds = governorTaskIds(governorDataDir);
    assert.deepEqual(taskIds, [String(terminal.taskId)], "Replay must not create a second Governor task.");
    assert.equal(governorLoopCount(governorDataDir), 1, "Replay must not create a second Governor loop.");

    return {
      resubmitStatus: resubmitted.status,
      replayed: resubmitted.body.replayed,
      reapproveStatus: reapproved.status,
      taskId: downstream.taskId,
      loopId: downstream.loopId,
      governorTaskCount: taskIds.length,
      governorLoopCount: 1,
    };
  });

  // -- 10. Typed refusal for the same identity with a different payload -------
  await step("Refuse the same mission ID carrying a different payload with a typed conflict", async () => {
    const conflicting = await postJson(
      operator!.baseUrl,
      "/api/runtime-missions",
      submitToken,
      envelope({
        input: {
          ...(envelopeTemplate.input as Record<string, unknown>),
          goal: "A different goal that changes the exact payload hash.",
        },
      }),
    );
    assert.equal(conflicting.status, 409, `Expected 409, got ${conflicting.status}.`);
    assert.equal(conflicting.body.code, "OPERATOR_MISSION_PAYLOAD_MISMATCH");

    const taskIds = governorTaskIds(governorDataDir);
    assert.deepEqual(taskIds, [String(terminal.taskId)], "A refused payload must not create a Governor task.");
    assert.equal(governorLoopCount(governorDataDir), 1);

    return {
      httpStatus: conflicting.status,
      code: conflicting.body.code,
      governorTaskCount: taskIds.length,
      governorLoopCount: 1,
    };
  });

  verdict = "PASS";
} catch (error) {
  verdict = "FAIL";
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
} finally {
  if (operator) await killOperator(operator);
}

// ---------------------------------------------------------------------------
// Machine-readable terminal result + evidence artifact
// ---------------------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });

const terminalResult = {
  schema: "chanter.os.assembly.result.v1",
  verdict,
  startedAt,
  completedAt: new Date().toISOString(),
  missionPath:
    "operator submission -> persisted human approval -> agent runtime execution -> loop governor manual loop -> durable evidence -> replay without duplication",
  observedIds,
  realAgentExecution: false,
  steps,
  ...(failure ? { failure } : {}),
};

const resultPath = path.join(outputDir, "terminal-result.json");
writeFileSync(resultPath, `${JSON.stringify(terminalResult, null, 2)}\n`, "utf8");

const evidenceLines = [
  "# CHANTER OS — End-to-End Operational Assembly Evidence",
  "",
  `- Verdict: **${verdict}**`,
  `- Started: ${terminalResult.startedAt}`,
  `- Completed: ${terminalResult.completedAt}`,
  `- Mission ID: \`${missionId}\``,
  `- Task ID: \`${observedIds.taskId ?? "(not observed)"}\``,
  `- Loop ID: \`${observedIds.loopId ?? "(not observed)"}\``,
  `- Payload hash: \`${observedIds.missionPayloadHash ?? "(not observed)"}\``,
  `- Real coding-agent execution: frozen (\`false\`)`,
  "",
  "| # | Step | Outcome |",
  "| --- | --- | --- |",
  ...steps.map((entry) => `| ${entry.step} | ${entry.name} | ${entry.outcome.toUpperCase()} |`),
  "",
  ...(failure ? ["## Failure", "", "```", failure, "```", ""] : []),
];
const evidencePath = path.join(outputDir, "assembly-evidence.md");
writeFileSync(evidencePath, `${evidenceLines.join("\n")}\n`, "utf8");

if (!keepArtifacts) {
  try {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } catch {
    // A disposable temp root Windows still holds open is inert.
  }
}

console.log("");
console.log(`Verdict: ${verdict}`);
console.log(`Terminal result: ${resultPath}`);
console.log(`Evidence: ${evidencePath}`);
if (keepArtifacts) console.log(`Retained working state: ${temporaryRoot}`);
if (failure) console.error(`\n${failure}`);

process.exit(verdict === "PASS" ? 0 : 1);
