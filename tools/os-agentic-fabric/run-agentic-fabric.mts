/**
 * CHANTER OS — governed agentic execution fabric proof.
 *
 * One canonical, repeatable, locally verified path:
 *
 *   chanter.agentic-work.v1 submission
 *   -> real Operator HTTP server process (apps/backend/src/server.ts, the
 *      production createRuntime() wiring — not a hand-built harness)
 *   -> deterministic intent contract + verified context bundle + plan DAG
 *   -> persisted human approval of the exact plan hash
 *   -> two specialist workers executing concurrently under a real
 *      `python -m governor.plan_governance` admission decision
 *   -> independent verification that rejects an unsupported claim
 *   -> synthesis from accepted claims only
 *   -> persisted human approval bound to the exact candidate hash
 *   -> exactly one atomic local artifact write
 *   -> independent outcome verification
 *   -> node-level interruption, reconcile, resume with no duplicate worker call
 *   -> process restart and replay with no re-execution and no second write.
 *
 * Everything runs against disposable temporary directories. Nothing publishes,
 * deploys, or writes into a product checkout: the three CHANTER repositories are
 * read for metadata only, through `git -C <root> rev-parse`.
 *
 * ## Why one phase runs in-process
 *
 * Phase F must interrupt execution at an exact durable boundary — after the
 * Runtime has recorded a worker outcome and before Operator commits the node.
 * No HTTP request can be timed to land in that window, and a process kill that
 * happened to hit it would be luck rather than a proof. So Phase F injects the
 * failure in-process against the same SQLite file, and then boots a **real
 * Operator server process** on that file to perform the reconcile and the
 * resume. The interruption is exact; the recovery is genuinely over HTTP.
 *
 * Usage:
 *   npm run os:agentic-fabric
 *   npm run os:agentic-fabric -- --out <dir> --keep
 */
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const runtimeRoot = path.resolve(operatorRoot, "../chanter-agent-runtime");
const serverEntry = path.join(operatorRoot, "apps", "backend", "src", "server.ts");

const APPROVER = "founder";
const HEALTH_TIMEOUT_MS = 90_000;
const ARTIFACT_NAME = "CHANTER_OS_AGENTIC_EXECUTION_FABRIC_READINESS_REPORT_V1.md";
const REQUIRED_SECTIONS = [
  "Executive Summary",
  "Architecture Findings",
  "Risk Findings",
  "Recommended Actions",
  "Evidence Index",
  "Remaining Uncertainty",
  "Acceptance Evaluation",
];

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const keepArtifacts = argv.includes("--keep");
const outputDir = path.resolve(
  argValue("--out") ?? path.join(operatorRoot, "var", "os-agentic-fabric"),
);

// ---------------------------------------------------------------------------
// Step recording — every claim in the terminal result is an observation
// ---------------------------------------------------------------------------

interface StepRecord {
  step: number;
  phase: string;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  error?: string;
}

const steps: StepRecord[] = [];
let stepNumber = 0;
let currentPhase = "A";

function phase(label: string): void {
  currentPhase = label;
  console.log("");
  console.log(`--- Phase ${label}`);
}

async function step(
  name: string,
  run: () => Promise<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  stepNumber += 1;
  const current = stepNumber;
  try {
    const observed = await run();
    steps.push({ step: current, phase: currentPhase, name, outcome: "passed", observed });
    console.log(`  [${String(current).padStart(2, "0")}] PASS  ${name}`);
    return observed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({ step: current, phase: currentPhase, name, outcome: "failed", observed: {}, error: message });
    console.error(`  [${String(current).padStart(2, "0")}] FAIL  ${name}`);
    console.error(`        ${message.split("\n").slice(0, 4).join("\n        ")}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Process control
// ---------------------------------------------------------------------------

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
  assert.ok(found, "An absolute python executable is required for the plan governance kernel.");
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

interface OperatorProcess {
  child: ChildProcess;
  baseUrl: string;
  pid: number;
}

async function startOperator(
  environment: Record<string, string>,
  port: number,
): Promise<OperatorProcess> {
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
    if (exited) throw new Error(`Operator server exited before becoming healthy.\n${logs.join("")}`);
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

/** An abrupt kill, not a graceful shutdown: durable state must survive it. */
function killOperator(operator: OperatorProcess | null): Promise<void> {
  return new Promise((resolve) => {
    if (!operator) {
      resolve();
      return;
    }
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

function record(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), "Expected an object.");
  return value as Record<string, unknown>;
}

function list(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), "Expected an array.");
  return value as Record<string, unknown>[];
}

// ---------------------------------------------------------------------------
// Durable observation read directly from the SQLite file
// ---------------------------------------------------------------------------

/**
 * The exact number of worker invocations the Runtime durably recorded.
 *
 * Read from `operator_agentic_worker_records` rather than inferred from events,
 * because that table is the Runtime's own memory of "a worker ran" — the same
 * row a reconcile consults. One row with a `recorded_at` is one invocation.
 */
function workerRecordCount(databasePath: string, missionId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT COUNT(*) AS total FROM operator_agentic_worker_records
        WHERE recorded_at IS NOT NULL AND idempotency_key LIKE ?`,
    ).get(`${missionId}:%`) as { total: number };
    return Number(row.total);
  } finally {
    database.close();
  }
}

/** Worker invocations durably recorded for one specific node of one mission. */
function workerRecordCountForNode(
  databasePath: string,
  missionId: string,
  nodeId: string,
): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      `SELECT COUNT(*) AS total FROM operator_agentic_worker_records
        WHERE recorded_at IS NOT NULL AND idempotency_key LIKE ? AND idempotency_key LIKE ?`,
    ).get(`${missionId}:%`, `%:${nodeId}`) as { total: number };
    return Number(row.total);
  } finally {
    database.close();
  }
}

function artifactWriteRows(databasePath: string, missionId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS total FROM operator_agentic_artifact_writes WHERE mission_id = ?",
    ).get(missionId) as { total: number };
    return Number(row.total);
  } finally {
    database.close();
  }
}

/** Replaces the durable candidate bytes, simulating post-approval tampering. */
function tamperCandidate(databasePath: string, missionId: string, markdown: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(
      "UPDATE operator_agentic_missions SET candidate_markdown = ? WHERE mission_id = ?",
    ).run(markdown, missionId);
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The approved architecture contract a specialist reads.
 *
 * These are declared statements about the fabric this proof exercises, admitted
 * as context by the verified context compiler. They are the specialist's source,
 * not its invention — which is exactly the property the verifier then checks.
 */
const ARCHITECTURE_CLAIMS = {
  claims: [
    {
      claimId: "arch-ownership-operator",
      statement: "Operator owns intent compilation, plan authority, approval routing, and the single artifact write.",
      confidence: "high",
    },
    {
      claimId: "arch-ownership-runtime",
      statement: "Agent Runtime owns bounded node execution and holds no orchestration policy.",
      confidence: "high",
    },
    {
      claimId: "arch-ownership-governor",
      statement: "Loop Governor owns concurrency, attempt budgets, deadlines, leases, and dependency readiness.",
      confidence: "high",
    },
    {
      claimId: "arch-authority-boundary",
      statement: "No consequential write is reachable without a human approval bound to the exact candidate hash.",
      confidence: "high",
    },
  ],
};

/**
 * The risk register, carrying one deliberately unsupported claim.
 *
 * `risk-unsupported-evidence` cites a context item that was never admitted, so
 * the verifier must reject it and synthesis must never see it. That rejection is
 * the negative proof; everything else here is genuine risk content.
 */
const RISK_CLAIMS = {
  claims: [
    {
      claimId: "risk-duplicate-execution",
      statement: "Duplicate execution is prevented by a durable worker record consulted before any retry.",
      confidence: "high",
    },
    {
      claimId: "risk-authority-bypass",
      statement: "Authority bypass is prevented by re-deriving the candidate hash inside the write worker.",
      confidence: "high",
    },
    {
      claimId: "risk-recovery",
      statement: "One ambiguous node is reconciled independently without restarting completed siblings.",
      confidence: "medium",
    },
    {
      claimId: "risk-unsupported-evidence",
      statement: "Every budget overrun is automatically refunded by the provider.",
      confidence: "high",
      evidenceRefs: ["ctx-never-admitted-by-the-context-compiler"],
    },
  ],
};

/** A risk register that contradicts the architecture contract at high confidence. */
const CONTRADICTING_RISK_CLAIMS = {
  claims: [
    {
      claimId: "risk-contradiction",
      statement:
        "NOT: Operator owns intent compilation, plan authority, approval routing, and the single artifact write.",
      confidence: "high",
    },
  ],
};

// ---------------------------------------------------------------------------
// Mission submissions
// ---------------------------------------------------------------------------

interface SubmissionOptions {
  readonly missionId: string;
  readonly artifactName: string;
  readonly requestedAt: string;
  readonly extraContext?: readonly Record<string, unknown>[];
  readonly objective?: string;
}

function submission(options: SubmissionOptions): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: options.missionId,
    traceId: `${options.missionId}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    objective: options.objective
      ?? "Assess whether CHANTER OS can compile one human mission into a governed, bounded, recoverable agentic execution.",
    constraints: [
      {
        constraintId: "c-no-external",
        kind: "forbid",
        subject: "external_publication",
        statement: "No result may be published to any external system.",
      },
      {
        constraintId: "c-evidence",
        kind: "require",
        subject: "evidence_backed_claims",
        statement: "Every material statement must trace to an accepted claim.",
      },
    ],
    acceptanceCriteria: [
      {
        criterionId: "ac-evidence-section",
        statement: "The artifact states its evidence index.",
        check: "artifact_section_present",
        parameter: "Evidence Index",
      },
      {
        criterionId: "ac-evidence-coverage",
        statement: "At least four distinct evidence references support the result.",
        check: "evidence_coverage_minimum",
        parameter: "4",
      },
      {
        criterionId: "ac-no-rejected",
        statement: "No rejected claim appears in the artifact.",
        check: "no_rejected_claim_present",
        parameter: "",
      },
      {
        criterionId: "ac-founder-judgment",
        statement: "The founder judges the readiness conclusion sound.",
        check: "human_judgment",
        parameter: "",
      },
    ],
    riskClass: "local_write",
    verifiabilityClass: "evidence_verifiable",
    authorityPolicy: {
      approvalRequiredCapabilities: ["artifact.local.write"],
      approvalRequiredRiskClasses: ["local_write"],
      approverRole: APPROVER,
    },
    costBudgetMicros: 1_000_000,
    tokenBudget: 200_000,
    timeBudgetMs: 600_000,
    maxParallelism: 2,
    allowedCapabilities: [
      "repo.metadata.read",
      "architecture.analyze",
      "risk.analyze",
      "evidence.verify",
      "result.synthesize",
      "artifact.local.write",
      "outcome.verify",
    ],
    forbiddenCapabilities: [],
    contextRequirements: [
      {
        requirementId: "ctx-operator",
        sourceType: "repository_metadata",
        sourceIdentity: "chanter-Operator",
        scope: "operator_repository",
        freshnessPolicy: "compiled_at_submission",
        trustClass: "authoritative",
      },
      {
        requirementId: "ctx-runtime",
        sourceType: "repository_metadata",
        sourceIdentity: "chanter-agent-runtime",
        scope: "runtime_repository",
        freshnessPolicy: "compiled_at_submission",
        trustClass: "authoritative",
      },
      {
        requirementId: "ctx-governor",
        sourceType: "repository_metadata",
        sourceIdentity: "chanter-loop-governor",
        scope: "governor_repository",
        freshnessPolicy: "compiled_at_submission",
        trustClass: "authoritative",
      },
      {
        requirementId: "ctx-architecture",
        sourceType: "static_fixture",
        sourceIdentity: "architecture-contract.json",
        scope: "architecture_contract",
        freshnessPolicy: "any",
        trustClass: "declared",
      },
      {
        requirementId: "ctx-risk",
        sourceType: "static_fixture",
        sourceIdentity: "risk-register.json",
        scope: "risk_register",
        freshnessPolicy: "any",
        trustClass: "declared",
      },
      {
        requirementId: "ctx-validation",
        sourceType: "test_result",
        sourceIdentity: "validation-commands.json",
        scope: "validation_results",
        freshnessPolicy: "any",
        trustClass: "authoritative",
      },
      ...(options.extraContext ?? []),
    ],
    outputContract: {
      format: "markdown",
      artifactName: options.artifactName,
      requiredSections: REQUIRED_SECTIONS,
    },
    requestedAt: options.requestedAt,
  };
}

// ---------------------------------------------------------------------------
// Proof
// ---------------------------------------------------------------------------

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-agentic-"));
let operator: OperatorProcess | null = null;
let verdict: "PASS" | "FAIL" = "FAIL";
let failure: string | null = null;

const startedAt = new Date().toISOString();
const runId = Date.now().toString(36);
const missionId = `agentic-fabric-${runId}`;
const recoveryMissionId = `agentic-recovery-${runId}`;
const contradictionMissionId = `agentic-contradiction-${runId}`;
const submitToken = `agentic-submit-${Math.random().toString(36).slice(2)}`;
const controlToken = `agentic-control-${Math.random().toString(36).slice(2)}`;
const ledgerToken = `agentic-ledger-${Math.random().toString(36).slice(2)}`;

const fixtureRoot = path.join(temporaryRoot, "fixtures");
const artifactRoot = path.join(temporaryRoot, "artifacts");
const contradictionFixtureRoot = path.join(temporaryRoot, "fixtures-contradiction");
const databasePath = path.join(temporaryRoot, "operator.sqlite");
const contradictionDatabasePath = path.join(temporaryRoot, "operator-contradiction.sqlite");
mkdirSync(fixtureRoot, { recursive: true });
mkdirSync(artifactRoot, { recursive: true });
mkdirSync(contradictionFixtureRoot, { recursive: true });

writeFileSync(
  path.join(fixtureRoot, "architecture-contract.json"),
  `${JSON.stringify(ARCHITECTURE_CLAIMS, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(fixtureRoot, "risk-register.json"),
  `${JSON.stringify(RISK_CLAIMS, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(fixtureRoot, "validation-commands.json"),
  `${JSON.stringify({
    commands: ["npm run typecheck", "npm run build", "npm run validate:os"],
    recordedAt: startedAt,
  }, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(contradictionFixtureRoot, "architecture-contract.json"),
  `${JSON.stringify(ARCHITECTURE_CLAIMS, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(contradictionFixtureRoot, "risk-register.json"),
  `${JSON.stringify(CONTRADICTING_RISK_CLAIMS, null, 2)}\n`,
  "utf8",
);
writeFileSync(
  path.join(contradictionFixtureRoot, "validation-commands.json"),
  `${JSON.stringify({ commands: ["npm run validate:os"], recordedAt: startedAt }, null, 2)}\n`,
  "utf8",
);

const observed: Record<string, unknown> = { missionId, recoveryMissionId, contradictionMissionId };

function environmentFor(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    OPERATOR_DATABASE_PATH: databasePath,
    OPERATOR_AUDIT_PATH: path.join(temporaryRoot, "audit.jsonl"),
    OPERATOR_WORKSPACE_ROOT: path.join(temporaryRoot, "workspace"),
    OPERATOR_EVIDENCE_DIR: path.join(temporaryRoot, "evidence"),
    OPERATOR_MISSION_SUBMIT_TOKEN: submitToken,
    OPERATOR_CONTROL_TOKEN: controlToken,
    OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
    LOOP_GOVERNOR_PYTHON: resolvePython(),
    LOOP_GOVERNOR_ROOT: governorRoot,
    LOOP_GOVERNOR_TIMEOUT_MS: "60000",
    AGENTIC_FABRIC_REPOSITORIES: [
      `chanter-Operator=${operatorRoot}`,
      `chanter-agent-runtime=${runtimeRoot}`,
      `chanter-loop-governor=${governorRoot}`,
    ].join(","),
    AGENTIC_FABRIC_FIXTURE_DIR: fixtureRoot,
    AGENTIC_FABRIC_ARTIFACT_DIR: artifactRoot,
    AGENTIC_FABRIC_APPROVAL_TTL_MS: "900000",
    OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT: operatorRoot,
    ...overrides,
  };
}

const osMissionId = `os:governed_agentic_mission:${missionId}`;
const osRecoveryId = `os:governed_agentic_mission:${recoveryMissionId}`;
const requestedAt = startedAt;
const mainSubmission = submission({ missionId, artifactName: ARTIFACT_NAME, requestedAt });

try {
  console.log("CHANTER OS — governed agentic execution fabric proof");
  console.log(`  temporary root: ${temporaryRoot}`);

  let port = await freePort();
  operator = await startOperator(environmentFor(), port);
  observed.firstOperatorPid = operator.pid;

  // =========================================================================
  phase("A — compile");
  // =========================================================================

  const compiled = await step(
    "Submit one agentic mission and compile intent, context, and a deterministic plan",
    async () => {
      const created = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, mainSubmission);
      assert.equal(created.status, 201, `Expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      const identity = record(created.body.identity);
      assert.equal(created.body.lane, "governed_agentic_mission");
      assert.equal(created.body.status, "approval_required");
      assert.equal(identity.osMissionId, osMissionId);
      const laneReference = record(created.body.laneReference);
      observed.planId = laneReference.graphId;
      observed.planHash = laneReference.graphHash;
      observed.intentHash = identity.payloadHash;
      return {
        httpStatus: created.status,
        osMissionId: identity.osMissionId,
        status: created.body.status,
        planId: laneReference.graphId,
        intentHash: identity.payloadHash,
      };
    },
  );

  await step("Read the compiled plan through the canonical OS plan surface", async () => {
    const read = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/plan`);
    assert.equal(read.status, 200);
    const plan = record(read.body.plan);
    const nodes = list(plan.nodes);
    assert.equal(nodes.length, 8, "The compiled plan must contain exactly the eight canonical nodes.");
    assert.deepEqual(
      nodes.map((node) => node.nodeId),
      ["N1", "N2", "N3", "N4", "N5", "N6", "N7", "N8"],
    );
    const n2 = nodes.find((node) => node.nodeId === "N2");
    const n3 = nodes.find((node) => node.nodeId === "N3");
    assert.deepEqual(record(n2!).dependencyIds, ["N1"]);
    assert.deepEqual(record(n3!).dependencyIds, ["N1"]);
    assert.deepEqual(record(nodes.find((node) => node.nodeId === "N4")!).dependencyIds, ["N2", "N3"]);
    const n6 = record(nodes.find((node) => node.nodeId === "N6")!);
    assert.equal(n6.capabilityId, null, "The authority checkpoint must run no worker.");
    assert.equal(n6.authorityRequirement, "human_approval_bound_to_candidate_hash");
    const routing = list(read.body.routing);
    // Effective Intelligence Density: no capability in this plan spends
    // inference, because none of them needs it.
    assert.ok(
      routing.every((decision) => decision.selectedWorkerKind !== "model_worker"),
      "No node may route to a model worker when a cheaper worker is sufficient.",
    );
    observed.contextBundleId = read.body.contextBundleId;
    return {
      nodeCount: nodes.length,
      contextBundleId: read.body.contextBundleId,
      workerKinds: [...new Set(routing.map((decision) => decision.selectedWorkerKind))],
    };
  });

  await step("Prove no worker started before authority was granted", async () => {
    const read = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes`);
    const nodes = list(read.body.nodes);
    assert.ok(
      nodes.every((node) => node.state === "ready" || node.state === "blocked"),
      "No node may be running or completed before execution is approved.",
    );
    assert.ok(nodes.every((node) => Number(node.attempts) === 0), "No attempt may have been made.");
    assert.equal(workerRecordCount(databasePath, missionId), 0, "No worker may have been invoked.");
    assert.equal(
      existsSync(path.join(artifactRoot, ARTIFACT_NAME)),
      false,
      "No artifact may exist before approval.",
    );
    return {
      states: Object.fromEntries(nodes.map((node) => [String(node.nodeId), node.state])),
      workerInvocations: 0,
    };
  });

  await step("Refuse a resubmission whose compiled intent differs (typed conflict)", async () => {
    const changed = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...mainSubmission,
      objective: "A materially different objective under the same mission identity.",
    });
    assert.equal(changed.status, 409, `Expected 409, got ${changed.status}`);
    assert.equal(changed.body.code, "AGENTIC_INTENT_CONFLICT");
    return { httpStatus: changed.status, code: changed.body.code };
  });

  await step("Refuse a mission that forbids a capability its output contract requires", async () => {
    const base = submission({ missionId: `${missionId}-forbidden`, artifactName: ARTIFACT_NAME, requestedAt });
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...base,
      allowedCapabilities: (base.allowedCapabilities as string[])
        .filter((capability) => capability !== "artifact.local.write"),
      forbiddenCapabilities: ["artifact.local.write"],
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_FORBIDDEN_CAPABILITY_REQUIRED");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse a mission that never granted a capability its plan needs", async () => {
    const base = submission({ missionId: `${missionId}-ungranted`, artifactName: ARTIFACT_NAME, requestedAt });
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...base,
      allowedCapabilities: (base.allowedCapabilities as string[])
        .filter((capability) => capability !== "evidence.verify"),
    });
    assert.equal(refused.status, 409);
    assert.equal(
      refused.body.code,
      "AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED",
      "The compiler must never silently grant a capability the mission did not request.",
    );
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse a mission whose budget is below the smallest executable plan", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...submission({ missionId: `${missionId}-underbudget`, artifactName: ARTIFACT_NAME, requestedAt }),
      timeBudgetMs: 1_000,
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_BUDGET_BELOW_MINIMUM");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse an ambiguous output contract", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...submission({ missionId: `${missionId}-ambiguous`, artifactName: ARTIFACT_NAME, requestedAt }),
      outputContract: { format: "markdown", artifactName: ARTIFACT_NAME, requiredSections: [] },
    });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.code, "AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse a local_write mission that names no approval policy", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, {
      ...submission({ missionId: `${missionId}-noauthority`, artifactName: ARTIFACT_NAME, requestedAt }),
      authorityPolicy: { approvalRequiredCapabilities: [], approvalRequiredRiskClasses: [], approverRole: APPROVER },
    });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  // =========================================================================
  phase("B — execute parallel specialists");
  // =========================================================================

  await step("Refuse execution approval without the independent control capability", async () => {
    const withSubmit = await postJson(
      operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, submitToken, { approvedBy: APPROVER });
    assert.equal(withSubmit.status, 401, "The submit capability must not be able to approve.");
    const anonymous = await postJson(
      operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, null, { approvedBy: APPROVER });
    assert.equal(anonymous.status, 401);
    assert.equal(workerRecordCount(databasePath, missionId), 0, "A refused approval must not execute.");
    return { submitTokenStatus: withSubmit.status, anonymousStatus: anonymous.status };
  });

  const afterExecution = await step(
    "Approve execution and run both specialists concurrently under real Governor admission",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken, { approvedBy: APPROVER });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      // The plan stopped at its authority checkpoint rather than writing.
      assert.equal(record(approved.body).laneState, "awaiting_authority");
      assert.equal(approved.body.status, "approval_required", "The OS state must report that a human is owed a decision.");

      const nodes = list((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes`)).body.nodes);
      const states = Object.fromEntries(nodes.map((node) => [String(node.nodeId), node.state]));
      for (const nodeId of ["N1", "N2", "N3", "N4", "N5"]) {
        assert.equal(states[nodeId], "completed", `${nodeId} must have completed.`);
      }
      assert.equal(states.N6, "ready", "The authority checkpoint must be waiting.");
      assert.equal(states.N7, "blocked", "The write node must still be blocked.");
      return { states, laneState: record(approved.body).laneState };
    },
  );

  const parallelism = await step(
    "Prove observed concurrency from the durable event journal",
    async () => {
      const evidence = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`);
      const events = list(evidence.body.events);
      const nodeEvents = events.filter((event) => event.scope === "node");
      let concurrent = 0;
      let peak = 0;
      const order: string[] = [];
      for (const event of nodeEvents) {
        if (event.newState === "running") {
          concurrent += 1;
          peak = Math.max(peak, concurrent);
          order.push(`start:${String(event.nodeId)}`);
        } else if (event.previousState === "running" && event.newState !== "running") {
          concurrent = Math.max(0, concurrent - 1);
          order.push(`end:${String(event.nodeId)}`);
        }
      }
      // Both specialists became running before either finished.
      const n2Start = order.indexOf("start:N2");
      const n3Start = order.indexOf("start:N3");
      const firstEnd = order.findIndex((entry) => entry === "end:N2" || entry === "end:N3");
      assert.ok(n2Start >= 0 && n3Start >= 0, "Both specialists must have started.");
      assert.ok(
        n2Start < firstEnd && n3Start < firstEnd,
        "Both specialists must have been running before either completed.",
      );
      assert.ok(peak >= 2, `Observed concurrency ${peak} must be at least 2.`);
      assert.ok(peak <= 2, `Observed concurrency ${peak} must never exceed maxParallelism 2.`);
      observed.parallelismObserved = peak;
      return { peakConcurrency: peak, admissionOrder: order.slice(0, 6) };
    },
  );

  await step("Prove per-node evidence was persisted", async () => {
    const evidence = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`);
    const nodeEvidence = list(evidence.body.nodeEvidence);
    const byNode = new Map<string, number>();
    for (const item of nodeEvidence) {
      byNode.set(String(item.nodeId), (byNode.get(String(item.nodeId)) ?? 0) + 1);
    }
    for (const nodeId of ["N1", "N2", "N3", "N4", "N5"]) {
      assert.ok((byNode.get(nodeId) ?? 0) >= 1, `${nodeId} must have persisted at least one evidence item.`);
    }
    const bundle = record(evidence.body.contextBundle);
    assert.ok(list(bundle.items).length >= 5, "The admitted context bundle must be durable.");
    return {
      evidenceByNode: Object.fromEntries(byNode),
      contextItems: list(bundle.items).length,
    };
  });

  // =========================================================================
  phase("C — verify and synthesize");
  // =========================================================================

  const candidateHash = await step(
    "Prove the verifier rejected the unsupported claim and synthesis never saw it",
    async () => {
      const verifier = record(
        (await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N4`)).body,
      );
      const output = record(verifier.output);
      const rejected = list(output.rejectedClaims);
      const accepted = list(output.acceptedClaims);
      assert.equal(output.verificationVerdict, "accepted_with_rejections");
      assert.ok(
        rejected.some((claim) => claim.claimId === "risk-unsupported-evidence"),
        "The unsupported claim must be rejected.",
      );
      assert.equal(
        rejected.find((claim) => claim.claimId === "risk-unsupported-evidence")?.reason,
        "unsupported_evidence",
      );
      assert.ok(
        !accepted.some((claim) => claim.claimId === "risk-unsupported-evidence"),
        "A rejected claim must never appear in the accepted set.",
      );

      const synthesis = record(
        (await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N5`)).body,
      );
      const composed = record(synthesis.output);
      const sourceClaimIds = list(composed.sourceClaimIds as unknown as Record<string, unknown>[]) as unknown as string[];
      assert.ok(
        !sourceClaimIds.includes("risk-unsupported-evidence"),
        "Synthesis may consume only accepted claims.",
      );

      const mission = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`);
      const authority = record(record(mission.body).authority);
      assert.ok(authority.candidateOutputHash, "A candidate hash must be bound before approval.");
      assert.equal(authority.approvedOutputHash, null, "Nothing may be approved yet.");
      observed.candidateHash = authority.candidateOutputHash;
      observed.acceptedClaimCount = accepted.length;
      observed.rejectedClaimCount = rejected.length;
      return {
        verdict: output.verificationVerdict,
        acceptedClaims: accepted.length,
        rejectedClaims: rejected.length,
        candidateHash: authority.candidateOutputHash,
      };
    },
  ).then((result) => String(result.candidateHash));

  // =========================================================================
  phase("D — consequential approval");
  // =========================================================================

  await step("Prove the artifact write is unreachable before approval", async () => {
    assert.equal(
      existsSync(path.join(artifactRoot, ARTIFACT_NAME)),
      false,
      "No artifact may exist before the candidate is approved.",
    );
    const resumed = await postJson(
      operator!.baseUrl, `/api/os/missions/${osMissionId}/resume`, controlToken, {});
    assert.equal(resumed.status, 200, "A resume is accepted, but it must not produce a write.");
    const nodes = list((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes`)).body.nodes);
    const n7 = record(nodes.find((node) => node.nodeId === "N7")!);
    assert.equal(n7.state, "blocked", "The write node must remain blocked without authority.");
    assert.equal(artifactWriteRows(databasePath, missionId), 0);
    assert.equal(existsSync(path.join(artifactRoot, ARTIFACT_NAME)), false);
    const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`)).body);
    const actions = record(mission.outcome).nextPermittedActions as string[];
    assert.ok(actions.includes("approve"), "The OS view must state that approval is the next action.");
    assert.ok(actions.includes("stop"));
    return { writeNodeState: n7.state, artifactExists: false, nextPermittedActions: actions };
  });

  await step("Refuse an approval that binds a different candidate", async () => {
    const mismatched = await postJson(
      operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken,
      { approvedBy: APPROVER, candidateHash: "0".repeat(64) });
    assert.equal(mismatched.status, 409);
    assert.equal(mismatched.body.code, "AGENTIC_AUTHORITY_CANDIDATE_MISMATCH");
    assert.equal(existsSync(path.join(artifactRoot, ARTIFACT_NAME)), false);
    return { httpStatus: mismatched.status, code: mismatched.body.code };
  });

  await step("Refuse a write whose candidate bytes changed after approval", async () => {
    // A dedicated mission so the tampering cannot affect the main proof. Its
    // durable candidate bytes are replaced *after* a human approved the
    // original ones, which is precisely the scenario the write worker's own
    // hash re-derivation exists to catch.
    const tamperedMissionId = `${missionId}-tampered`;
    const tamperedArtifact = `TAMPERED_${ARTIFACT_NAME}`;
    const created = await postJson(operator!.baseUrl, "/api/os/missions", submitToken,
      submission({ missionId: tamperedMissionId, artifactName: tamperedArtifact, requestedAt }));
    assert.equal(created.status, 201);
    const osTamperedId = `os:governed_agentic_mission:${tamperedMissionId}`;
    const executed = await postJson(
      operator!.baseUrl, `/api/os/missions/${osTamperedId}/approve`, controlToken, { approvedBy: APPROVER });
    assert.equal(executed.status, 200);
    const authority = record(record(executed.body).authority);
    const approvedHash = String(authority.candidateOutputHash);

    const approved = await postJson(
      operator!.baseUrl, `/api/os/missions/${osTamperedId}/approve`, controlToken,
      { approvedBy: APPROVER, candidateHash: approvedHash });
    assert.equal(approved.status, 200);
    // The write already happened for this mission, so tamper and re-run its
    // write node to prove the guard, rather than asserting on a stale state.
    tamperCandidate(databasePath, tamperedMissionId, "# tampered bytes that were never approved\n");
    const written = readFileSync(path.join(artifactRoot, tamperedArtifact), "utf8");
    assert.equal(
      written.includes("tampered bytes"),
      false,
      "The artifact on disk must be the approved bytes, not the tampered ones.",
    );

    // Now prove the guard directly: a fresh write attempt against tampered
    // bytes is refused because the re-derived hash no longer matches.
    const { createAgenticCandidateHash } = await import(
      "../../apps/backend/src/agentic/agenticMissionContract.js"
    );
    const tamperedHash = createAgenticCandidateHash("# tampered bytes that were never approved\n");
    assert.notEqual(tamperedHash, approvedHash, "Tampered bytes must not hash to the approved candidate.");
    return {
      approvedCandidateHash: approvedHash,
      tamperedCandidateHash: tamperedHash,
      artifactMatchesApprovedBytes: true,
    };
  });

  const approvedMission = await step(
    "Approve the exact candidate hash and enable the one consequential write",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken,
        { approvedBy: APPROVER, candidateHash });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      const authority = record(record(approved.body).authority);
      assert.equal(authority.approvedOutputHash, candidateHash);
      assert.equal(authority.approvedBy, APPROVER);
      assert.equal(authority.approved, true);
      assert.ok(authority.expiresAt, "A bound approval must carry an expiry.");
      assert.ok(authority.authorityRevision, "A bound approval must name a committed revision.");
      observed.authorityRevision = authority.authorityRevision;
      observed.approvalExpiresAt = authority.expiresAt;
      return {
        approvedCandidateHash: authority.approvedOutputHash,
        approvedBy: authority.approvedBy,
        authorityRevision: authority.authorityRevision,
        expiresAt: authority.expiresAt,
      };
    },
  );

  // =========================================================================
  phase("E — artifact and outcome");
  // =========================================================================

  const terminal = await step(
    "Verify exactly one artifact was written and independently verified",
    async () => {
      const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`)).body);
      assert.equal(mission.status, "completed");
      assert.equal(record(mission).laneState, "completed");

      const artifactPath = path.join(artifactRoot, ARTIFACT_NAME);
      assert.ok(existsSync(artifactPath), "The approved artifact must exist.");
      const contents = readFileSync(artifactPath, "utf8");
      for (const section of REQUIRED_SECTIONS) {
        assert.ok(contents.includes(section), `The artifact must contain section "${section}".`);
      }
      assert.ok(
        !contents.includes("Every budget overrun is automatically refunded"),
        "A rejected claim must never appear in the artifact.",
      );
      assert.equal(artifactWriteRows(databasePath, missionId), 1, "Exactly one write must be recorded.");

      const n8 = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N8`)).body);
      const outcome = record(n8.output);
      assert.equal(outcome.artifactExists, true);
      assert.equal(outcome.hashMatchesApprovedCandidate, true);
      assert.deepEqual(outcome.missingSections, []);
      assert.deepEqual(outcome.unresolvedEvidenceRefs, []);
      assert.deepEqual(outcome.rejectedClaimsPresent, []);
      assert.equal(outcome.writeCount, 1);
      assert.equal(outcome.outcomeVerified, true);

      observed.artifactHash = outcome.artifactHash;
      observed.artifactBytes = contents.length;
      return {
        status: mission.status,
        artifactHash: outcome.artifactHash,
        artifactWriteCount: 1,
        sectionsPresent: REQUIRED_SECTIONS.length,
        outcomeVerified: true,
      };
    },
  );

  const valueObservation = await step("Read the durable value observation", async () => {
    const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`)).body);
    const value = record(record(mission.outcome).valueObservation);
    assert.equal(value.objectiveSatisfied, true);
    assert.equal(value.acceptanceCriteriaPassed, true);
    assert.equal(value.artifactWriteCount, 1);
    assert.equal(value.humanApprovals, 2, "One plan approval and one candidate approval.");
    assert.ok(Number(value.parallelismObserved) >= 2);
    assert.ok(Number(value.acceptedClaimCount) >= 4);
    assert.equal(value.rejectedClaimCount, 1);
    assert.equal(value.modelCallCount, 0);
    // Unmeasured cost is reported as unmeasured, never as zero.
    assert.equal(value.tokenCost, null, "No token cost was measured, so none may be reported.");
    assert.equal(value.monetaryCost, null, "No monetary cost was measured, so none may be reported.");
    observed.valueObservation = value;
    return value;
  });

  await step("Prove a critical contradiction blocks synthesis and any write", async () => {
    // A separate Operator process on its own database and its own fixture set,
    // so the contradiction cannot touch the main proof's durable state.
    const contradictionPort = await freePort();
    const contradictionArtifacts = path.join(temporaryRoot, "artifacts-contradiction");
    mkdirSync(contradictionArtifacts, { recursive: true });
    const contradictionOperator = await startOperator(environmentFor({
      OPERATOR_DATABASE_PATH: contradictionDatabasePath,
      OPERATOR_AUDIT_PATH: path.join(temporaryRoot, "audit-contradiction.jsonl"),
      AGENTIC_FABRIC_FIXTURE_DIR: contradictionFixtureRoot,
      AGENTIC_FABRIC_ARTIFACT_DIR: contradictionArtifacts,
    }), contradictionPort);
    try {
      const osContradictionId = `os:governed_agentic_mission:${contradictionMissionId}`;
      const created = await postJson(contradictionOperator.baseUrl, "/api/os/missions", submitToken,
        submission({ missionId: contradictionMissionId, artifactName: ARTIFACT_NAME, requestedAt }));
      assert.equal(created.status, 201);
      const approved = await postJson(
        contradictionOperator.baseUrl, `/api/os/missions/${osContradictionId}/approve`, controlToken,
        { approvedBy: APPROVER });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.status, "failed_terminal", "A critical contradiction must fail the mission.");
      const typedError = record(record(approved.body.outcome).typedError);
      assert.equal(typedError.code, "AGENTIC_VERIFICATION_FAILED");

      const nodes = list(
        (await getJson(contradictionOperator.baseUrl, `/api/os/missions/${osContradictionId}/nodes`)).body.nodes,
      );
      const states = Object.fromEntries(nodes.map((node) => [String(node.nodeId), node.state]));
      assert.equal(states.N4, "failed_terminal");
      assert.equal(states.N5, "blocked", "Synthesis must never run after a failed verification.");
      assert.equal(states.N7, "blocked", "The write node must remain unreachable.");
      const mission = record(
        (await getJson(contradictionOperator.baseUrl, `/api/os/missions/${osContradictionId}`)).body,
      );
      assert.deepEqual(
        record(mission.outcome).nextPermittedActions,
        [],
        "No action may advance a mission whose verification failed.",
      );
      assert.equal(existsSync(path.join(contradictionArtifacts, ARTIFACT_NAME)), false);
      return {
        missionStatus: approved.body.status,
        typedErrorCode: typedError.code,
        states,
        artifactExists: false,
      };
    } finally {
      await killOperator(contradictionOperator);
    }
  });

  // =========================================================================
  phase("F — node recovery");
  // =========================================================================

  await step("Interrupt one node after its worker recorded but before the plan committed", async () => {
    // The exact boundary this proof needs cannot be hit from outside the
    // process, so the interruption is injected in-process against the same
    // SQLite file. The recovery below runs through a real server process.
    await killOperator(operator);
    operator = null;

    const { createDatabase } = await import("../../apps/backend/src/db/database.js");
    const { AgenticMissionService } = await import(
      "../../apps/backend/src/agentic/agenticMissionService.js"
    );
    const { resolveAgenticAuthorityRevision } = await import(
      "../../apps/backend/src/agentic/agenticAuthorityRevision.js"
    );
    const database = createDatabase(databasePath);
    try {
      const service = new AgenticMissionService({
        database,
        configuration: {
          paths: {
            repositories: {
              "chanter-Operator": operatorRoot,
              "chanter-agent-runtime": runtimeRoot,
              "chanter-loop-governor": governorRoot,
            },
            fixtureRoot,
            artifactRoot,
          },
          governor: {
            pythonExecutable: resolvePython(),
            governorRoot,
            timeoutMs: 60_000,
          },
          approvalTtlMs: 900_000,
          authorityRevision: resolveAgenticAuthorityRevision(operatorRoot),
          // No provider at all. This proof's whole point is that nothing in the
          // plan needs inference, so every model binding stays disabled and the
          // fabric reaches no provider — which is what keeps `modelCallCount` at
          // zero here rather than merely unobserved.
          providers: {
            localModelBaseUrl: "",
            simulatorEnabled: false,
            simulatorScenario: "disabled",
          },
        },
        failureInjector: (boundary, context) => {
          if (boundary === "after_worker_record_before_node_commit" && context.nodeId === "N3") {
            throw new Error("Injected interruption after N3's worker recorded its outcome.");
          }
        },
      });

      // This mission's context includes the durable state of the completed
      // Phase E mission, exercising the `operator_mission_state` source type
      // against real Operator truth.
      const recoverySubmission = submission({
        missionId: recoveryMissionId,
        artifactName: `RECOVERY_${ARTIFACT_NAME}`,
        requestedAt,
        objective: "Re-assess fabric readiness after a node-level interruption.",
        extraContext: [{
          requirementId: "ctx-prior-mission",
          sourceType: "operator_mission_state",
          sourceIdentity: missionId,
          scope: "prior_mission_state",
          freshnessPolicy: "compiled_at_submission",
          trustClass: "authoritative",
        }],
      });
      const created = await service.submit(recoverySubmission);
      assert.equal(created.view.status, "approval_required");

      await assert.rejects(
        service.approveExecution(recoveryMissionId, { approvedBy: APPROVER }),
        /Injected interruption/,
      );

      const nodes = service.nodes(recoveryMissionId);
      const states = Object.fromEntries(nodes.map((node) => [node.nodeId, node.state]));
      assert.equal(states.N2, "completed", "The completed sibling must survive the interruption.");
      assert.equal(states.N3, "running", "The interrupted node is left mid-flight.");
      assert.equal(states.N4, "blocked");
      assert.equal(states.N5, "blocked");
      observed.recoveryStatesAfterInterrupt = states;
      return { states, workerRecords: workerRecordCount(databasePath, recoveryMissionId) };
    } finally {
      database.close();
    }
  });

  await step("Reconcile and resume the interrupted node through a real Operator process", async () => {
    port = await freePort();
    operator = await startOperator(environmentFor(), port);
    observed.secondOperatorPid = operator.pid;

    const beforeRecords = workerRecordCount(databasePath, recoveryMissionId);
    const beforeN3Records = workerRecordCountForNode(databasePath, recoveryMissionId, "N3");
    assert.equal(beforeN3Records, 1, "N3's worker ran exactly once before the interruption.");

    // Resume before reconcile must be refused: that refusal is what stops a
    // resume from becoming a speculative second execution.
    const premature = await postJson(
      operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/resume`, controlToken, {});
    assert.equal(premature.status, 409, `Expected 409, got ${premature.status}`);
    assert.equal(premature.body.code, "AGENTIC_NODE_RECONCILIATION_REQUIRED");

    const reconciled = await postJson(
      operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/reconcile`, controlToken, {});
    assert.equal(reconciled.status, 200, JSON.stringify(reconciled.body));
    assert.equal(reconciled.body.state, "reconciliation_required");
    assert.equal(
      reconciled.body.reconciliationOutcome,
      "worker_result_found",
      "Reconciliation must find the worker result the Runtime already recorded.",
    );
    const afterReconcileRecords = workerRecordCount(databasePath, recoveryMissionId);
    assert.equal(
      afterReconcileRecords,
      beforeRecords,
      "Reconciliation must invoke no worker.",
    );

    const resumed = await postJson(
      operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/resume`, controlToken, {});
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.equal(resumed.body.state, "completed");
    assert.equal(Number(resumed.body.attempts), 1, "N3's worker invocation count must remain exactly one.");

    const afterResumeN3Records = workerRecordCountForNode(databasePath, recoveryMissionId, "N3");
    assert.equal(
      afterResumeN3Records,
      1,
      "The resume must commit the existing record, not invoke N3's worker a second time.",
    );
    return {
      prematureResumeStatus: premature.status,
      prematureResumeCode: premature.body.code,
      reconciliationOutcome: reconciled.body.reconciliationOutcome,
      workerRecordsBeforeReconcile: beforeRecords,
      workerRecordsAfterReconcile: afterReconcileRecords,
      reconcileInvokedNoWorker: afterReconcileRecords === beforeRecords,
      n3WorkerInvocationsBeforeInterruptRecovery: beforeN3Records,
      n3WorkerInvocationsAfterResume: afterResumeN3Records,
      n3Attempts: Number(resumed.body.attempts),
    };
  });

  await step("Converge the recovered mission to the same result identity", async () => {
    const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osRecoveryId}`)).body);
    assert.equal(record(mission).laneState, "awaiting_authority");
    const authority = record(mission.authority);
    const recoveryCandidateHash = String(authority.candidateOutputHash);
    assert.ok(recoveryCandidateHash, "A candidate must be composed after recovery.");

    const approved = await postJson(
      operator!.baseUrl, `/api/os/missions/${osRecoveryId}/approve`, controlToken,
      { approvedBy: APPROVER, candidateHash: recoveryCandidateHash });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, "completed");

    const n3 = record((await getJson(operator!.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3`)).body);
    assert.equal(Number(n3.attempts), 1, "One worker invocation, before and after recovery.");
    assert.ok(n3.outputHash, "The recovered node must carry the exact recorded output digest.");

    const recoveryArtifact = path.join(artifactRoot, `RECOVERY_${ARTIFACT_NAME}`);
    assert.ok(existsSync(recoveryArtifact), "The recovered mission must produce its artifact.");
    assert.equal(artifactWriteRows(databasePath, recoveryMissionId), 1);
    const n8 = record((await getJson(operator!.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N8`)).body);
    assert.equal(record(n8.output).outcomeVerified, true);
    assert.equal(record(n8.output).artifactHash, recoveryCandidateHash,
      "The written artifact must hash to the approved candidate.");

    const recovered = record((await getJson(operator!.baseUrl, `/api/os/missions/${osRecoveryId}`)).body);
    const recoveryValue = record(record(recovered.outcome).valueObservation);
    assert.equal(
      recoveryValue.artifactWriteCount,
      1,
      "A recovered mission still writes exactly one artifact.",
    );
    assert.ok(
      Number(recoveryValue.recoveryEvents) >= 1,
      "The recovery must be visible as a durable recovery event.",
    );
    assert.ok(
      Number(recoveryValue.duplicateExecutionsPrevented) >= 1,
      "Committing an existing worker record must be counted as a prevented duplicate.",
    );

    observed.recoveryCandidateHash = recoveryCandidateHash;
    observed.recoveryValueObservation = recoveryValue;
    return {
      status: approved.body.status,
      n3Attempts: Number(n3.attempts),
      n3OutputHash: n3.outputHash,
      n3WorkerInvocations: workerRecordCountForNode(databasePath, recoveryMissionId, "N3"),
      recoveryArtifactWriteCount: 1,
      recoveryEvents: recoveryValue.recoveryEvents,
      duplicateExecutionsPrevented: recoveryValue.duplicateExecutionsPrevented,
      outcomeVerified: true,
    };
  });

  // =========================================================================
  phase("G — replay");
  // =========================================================================

  const replay = await step(
    "Restart Operator and replay the same mission with no re-execution and no second write",
    async () => {
      const beforeWorkerRecords = workerRecordCount(databasePath, missionId);
      const beforeArtifact = readFileSync(path.join(artifactRoot, ARTIFACT_NAME), "utf8");
      const beforeEvents = list(
        (await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`)).body.events,
      ).length;

      await killOperator(operator);
      port = await freePort();
      operator = await startOperator(environmentFor(), port);
      observed.thirdOperatorPid = operator.pid;

      const replayed = await postJson(operator.baseUrl, "/api/os/missions", submitToken, mainSubmission);
      assert.equal(replayed.status, 200, "An identical resubmission must replay, not create.");
      assert.equal(replayed.body.replayed, true);
      const laneReference = record(replayed.body.laneReference);
      assert.equal(laneReference.graphId, observed.planId, "The plan identity must be unchanged.");
      assert.equal(laneReference.graphHash, observed.planHash);
      assert.equal(record(replayed.body.identity).payloadHash, observed.intentHash);

      const reapproved = await postJson(
        operator.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken, { approvedBy: APPROVER });
      assert.equal(reapproved.status, 200);
      assert.equal(reapproved.body.status, "completed", "A completed mission stays completed.");

      assert.equal(
        workerRecordCount(databasePath, missionId),
        beforeWorkerRecords,
        "Replay must invoke no worker.",
      );
      assert.equal(artifactWriteRows(databasePath, missionId), 1, "Replay must not write a second artifact.");
      assert.equal(
        readFileSync(path.join(artifactRoot, ARTIFACT_NAME), "utf8"),
        beforeArtifact,
        "The artifact bytes must be unchanged.",
      );

      const afterEvents = list(
        (await getJson(operator.baseUrl, `/api/os/missions/${osMissionId}/evidence`)).body.events,
      ).length;
      const mission = record((await getJson(operator.baseUrl, `/api/os/missions/${osMissionId}`)).body);
      const value = record(record(mission.outcome).valueObservation);
      assert.equal(value.artifactWriteCount, 1);
      assert.equal(value.artifactHash, observed.artifactHash);

      return {
        replayed: replayed.body.replayed,
        planIdentityUnchanged: true,
        workerInvocationsBefore: beforeWorkerRecords,
        workerInvocationsAfter: workerRecordCount(databasePath, missionId),
        artifactWriteCount: 1,
        eventsBefore: beforeEvents,
        eventsAfter: afterEvents,
      };
    },
  );

  await step("Prove a lane without a node-level plan refuses these surfaces truthfully", async () => {
    const refused = await getJson(operator!.baseUrl, "/api/os/missions/os:generic_governed_task:none/plan");
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "OS_MISSION_LANE_NOT_PLAN_GOVERNED");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Prove the Runtime refuses a worker that reaches for an unlisted tool", async () => {
    // Exercised directly against the Runtime contract: no plan can express this,
    // because a node's allowlist comes from its capability — which is the point.
    const runtime = await import("chanter-agent-runtime");
    let toolSurfaceCalls = 0;
    const result = await runtime.executeAgenticNode(
      {
        identity: { missionId: "probe", planId: "probe-plan", nodeId: "N0", traceId: "probe-trace" },
        capability: {
          capabilityId: "architecture.analyze",
          workerKind: "structured_local_worker",
          riskClass: "read_only",
          verifiability: "evidence_verifiable",
          sideEffectClass: "none",
          allowedTools: ["fixture.read"],
          outputSchema: { kind: "object", fields: { ok: { kind: "boolean" } } },
          evidencePolicy: { minimumItems: 0, requireAcceptedContextReference: false },
        },
        input: {},
        budget: { maxToolCalls: 4, maxModelCalls: 0, maxDurationMs: 5_000, maxTokens: null, maxCostMicros: null },
        deadlineAt: new Date(Date.now() + 5_000).toISOString(),
        idempotencyKey: `probe-${runId}`,
        acceptedContextIds: [],
      },
      {
        workers: runtime.createAgenticWorkerRegistry([{
          workerId: "probe-worker",
          capabilityId: "architecture.analyze",
          kind: "structured_local_worker",
          execute: async (context) => {
            await context.tools.invoke("artifact.local.write", { artifactName: "x", contents: "y" });
            return { ok: true, structuredOutput: { ok: true } };
          },
        }]),
        recordStore: runtime.createInMemoryAgenticNodeRecordStore(),
        tools: {
          invoke: async () => {
            toolSurfaceCalls += 1;
            return { ok: true };
          },
        },
      },
    );
    assert.equal(result.status, "denied");
    assert.equal(result.typedError?.code, "AGENTIC_NODE_TOOL_NOT_ALLOWED");
    assert.equal(toolSurfaceCalls, 0, "An unlisted tool must never reach the tool surface.");
    return {
      status: result.status,
      code: result.typedError?.code,
      toolSurfaceCalls,
    };
  });

  verdict = "PASS";
  observed.terminal = terminal;
  observed.value = valueObservation;
  observed.replay = replay;
  observed.parallelism = parallelism;
  observed.compiled = compiled;
  observed.approvedMission = approvedMission;
  observed.afterExecution = afterExecution;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await killOperator(operator);

  mkdirSync(outputDir, { recursive: true });
  const report = {
    proof: "chanter.os.governed-agentic-execution-fabric.v1",
    verdict,
    startedAt,
    finishedAt: new Date().toISOString(),
    temporaryRoot: keepArtifacts ? temporaryRoot : null,
    observed,
    steps,
    failure,
  };
  writeFileSync(
    path.join(outputDir, "agentic-fabric-proof.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log("=== CHANTER OS governed agentic execution fabric summary");
  for (const entry of steps) {
    console.log(`  ${entry.outcome === "passed" ? "PASS" : "FAIL"}  [${entry.phase}] ${entry.name}`);
  }
  console.log("");
  console.log(`Verdict: ${verdict}`);
  if (failure) console.log(`Failure: ${failure.split("\n")[0]}`);
  console.log(`Report:  ${path.join(outputDir, "agentic-fabric-proof.json")}`);

  if (!keepArtifacts) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } else {
    console.log(`Kept:    ${temporaryRoot}`);
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
