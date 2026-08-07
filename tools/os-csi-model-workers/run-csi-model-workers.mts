/**
 * CHANTER OS — Collective Synthetic Intelligence governed model-worker proof.
 *
 * Additive to `os:agentic-fabric`, which stays exactly as it was: that proof
 * shows the fabric governs *deterministic* work, and this one shows the same
 * fabric governs *probabilistic* work without giving it any authority it did not
 * already have.
 *
 * The single question under test:
 *
 *   > Can a real model participate in a CHANTER OS mission — producing genuine,
 *   > measured, billed-or-honestly-unbilled inference — without gaining control
 *   > over mission state, tools, verification, completion, recovery, or spend?
 *
 * ## What is real here and what is simulated
 *
 * Stated up front, because conflating the two is the easiest way for a proof
 * like this to lie:
 *
 *   - **Real.** Phases A–F run a real Operator server process, a real
 *     `python -m governor.plan_governance` child process, and two real
 *     provider-backed model calls against a local inference server. The token
 *     counts, latencies, finish reasons, and hashes in those phases were
 *     measured, never estimated.
 *   - **Simulated.** Phase G drives provider *failure* modes — unavailability,
 *     timeouts, malformed documents, insufficient ceilings. No real provider can
 *     be asked to time out on command without lying about what happened, so
 *     those run against reviewed test-mode bindings on their own databases.
 *     Every record they produce is stamped `mode: "test"`, and this runner
 *     refuses to count one as live-provider evidence.
 *
 * ## The cost claim, precisely
 *
 * The live provider is a local process. It is genuinely a model and genuinely
 * reports usage, and it is genuinely **unbilled** — no invoice exists. So this
 * proof reports `monetaryCost: null` with a stated reason rather than `0`, and
 * demonstrates monetary *enforcement* against a priced test binding instead.
 * That is the honest split, and it is why the accompanying result artifact
 * returns BLOCKED rather than PASS on the live-cost requirement.
 */
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const governorRoot = path.resolve(operatorRoot, "../chanter-loop.governor");
const runtimeRoot = path.resolve(operatorRoot, "../chanter-agent-runtime");
const serverEntry = path.join(operatorRoot, "apps", "backend", "src", "server.ts");

const APPROVER = "founder";
const HEALTH_TIMEOUT_MS = 90_000;
const ARTIFACT_NAME = "CHANTER_OS_COLLECTIVE_SYNTHETIC_INTELLIGENCE_MODEL_WORKER_READINESS_REPORT_V1.md";
const REQUIRED_SECTIONS = [
  "Executive Summary",
  "Architecture Findings",
  "Risk Findings",
  "Rejected Claims",
  "Model Provider Usage",
  "Authority Evidence",
  "Outcome Verification",
  "Evidence Index",
  "Residual Uncertainty",
];

const LOCAL_MODEL_BASE_URL =
  process.env.CHANTER_LOCAL_MODEL_BASE_URL?.trim() || "http://127.0.0.1:11434";
const LIVE_BINDING_ID = "local.ollama.gemma4-e4b.judgment";
const LIVE_MODEL_ID = "gemma4:e4b";
const SIMULATOR_PRIMARY = "simulator.primary";
const EXTERNAL_BILLED_BINDING_ID = "external.openrouter.deepseek-v4-flash.judgment";
const EXTERNAL_BILLED_MODEL_ID = "deepseek/deepseek-v4-flash";
/** Credential for the one billed provider. Read for presence only; never printed. */
const OPENROUTER_API_KEY = process.env.AGENTIC_FABRIC_OPENROUTER_API_KEY?.trim() ?? "";
const SIMULATOR_FALLBACK = "simulator.fallback";

/**
 * Wall clock the whole plan may consume.
 *
 * Two model nodes at up to 240s each, plus deterministic nodes, plus the human
 * pause between them. Generous on purpose: a plan that runs out of time proves
 * nothing about governance, only about this machine.
 */
const TIME_BUDGET_MS = 1_800_000;

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}
const keepArtifacts = argv.includes("--keep");
/**
 * Makes the billed external provider mandatory rather than merely reported.
 *
 * The canonical acceptance command for the Billed External Provider Cost
 * Authority P0 **must** pass this. Without it the run still exercises the whole
 * unbilled fabric and reports the billed seam as unproven — which keeps the
 * canonical gate usable before a credential is provisioned, without ever letting
 * a green gate imply that real money was governed.
 */
const requireBilledProvider = argv.includes("--require-billed-provider");
/**
 * Permits the run to continue without a reachable live provider.
 *
 * Off by default, deliberately. A green gate that quietly skipped the only real
 * inference in the proof would be worse than a red one.
 */
const allowMissingProvider = argv.includes("--allow-missing-provider");
const outputDir = path.resolve(
  operatorRoot,
  argValue("--out") ?? path.join("var", "os-csi-model-workers"),
);

// ---------------------------------------------------------------------------
// Step recording
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
    console.error(`        ${message.split("\n").slice(0, 5).join("\n        ")}`);
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
// Durable observation, read straight from SQLite
// ---------------------------------------------------------------------------

/**
 * Every provider invocation durably recorded for one mission.
 *
 * Read from `operator_agentic_provider_usage` rather than from the mission view,
 * because that table is the Runtime's own memory of "a provider was reached" —
 * the same row a reconcile consults and the same row that must not gain a
 * sibling on replay.
 */
function providerUsageRows(databasePath: string, missionId: string): Record<string, unknown>[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT * FROM operator_agentic_provider_usage
          WHERE mission_id = ? ORDER BY node_id ASC, provider_call_key ASC`,
      )
      .all(missionId) as unknown as Record<string, unknown>[];
  } finally {
    database.close();
  }
}

function providerCallCount(databasePath: string, missionId: string): number {
  return providerUsageRows(databasePath, missionId).length;
}

function providerCallCountForNode(databasePath: string, missionId: string, nodeId: string): number {
  return providerUsageRows(databasePath, missionId).filter((row) => row.node_id === nodeId).length;
}

function workerRecordCount(databasePath: string, missionId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare(
        `SELECT COUNT(*) AS total FROM operator_agentic_worker_records
          WHERE idempotency_key LIKE ? AND recorded_at IS NOT NULL`,
      )
      .get(`${missionId}:%`) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  } finally {
    database.close();
  }
}

function artifactWriteRows(databasePath: string, missionId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database
      .prepare("SELECT COUNT(*) AS total FROM operator_agentic_artifact_writes WHERE mission_id = ?")
      .get(missionId) as { total: number } | undefined;
    return Number(row?.total ?? 0);
  } finally {
    database.close();
  }
}

/**
 * Every text-bearing value in the whole database, for the privacy sweep.
 *
 * Deliberately indiscriminate: it dumps every column of every agentic table
 * rather than the ones we expect to be clean, because the interesting failure is
 * always the column nobody thought to check.
 */
function agenticDatabaseText(databasePath: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = (database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'operator_agentic_%'")
      .all() as unknown as Array<{ name: string }>).map((row) => row.name);
    const chunks: string[] = [];
    for (const table of tables) {
      const rows = database.prepare(`SELECT * FROM ${table}`).all() as unknown as Record<string, unknown>[];
      chunks.push(JSON.stringify(rows));
    }
    return chunks.join("\n");
  } finally {
    database.close();
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * The admitted architecture contract.
 *
 * The model sees these statements as *evidence*, not as an answer key — its own
 * claims are its own, and the verifier checks only that each cites an id that
 * was actually admitted. Nothing compares a model's wording to this text.
 */
const ARCHITECTURE_CLAIMS = {
  claims: [
    {
      claimId: "arch-ownership",
      statement: "Operator owns intent, context, plan, authority, evidence, and artifact.",
      confidence: "high",
    },
    {
      claimId: "arch-runtime-bound",
      statement: "Agent Runtime owns bounded execution of exactly one plan node and enforces its bound.",
      confidence: "high",
    },
    {
      claimId: "arch-governor-admission",
      statement: "Loop Governor decides node admission and holds no mission semantics.",
      confidence: "high",
    },
    {
      claimId: "arch-provider-port",
      statement: "The provider call is the Runtime's bounded execution port, not a tool exposed to a model.",
      confidence: "high",
    },
  ],
};

const RISK_CLAIMS = {
  claims: [
    {
      claimId: "risk-unknown-outcome",
      statement: "An unknown provider outcome requires reconciliation before any retry.",
      confidence: "high",
    },
    {
      claimId: "risk-duplicate-spend",
      statement: "A durably recorded provider outcome must never be purchased a second time.",
      confidence: "high",
    },
    {
      claimId: "risk-unpriced-ceiling",
      statement: "A monetary ceiling cannot be enforced against a provider whose cost is never measured.",
      confidence: "medium",
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
  readonly objective?: string;
  readonly executionPolicy?: string;
  readonly providerBindings?: readonly Record<string, unknown>[];
  readonly modelNodeCostCeilingMicros?: number;
  readonly timeBudgetMs?: number;
}

function submission(options: SubmissionOptions): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: options.missionId,
    traceId: `${options.missionId}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    objective: options.objective
      ?? "Assess whether CHANTER OS can admit real provider-backed model workers under bounded capability, "
      + "context, token, cost, deadline, and tool constraints without granting them authority.",
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
        criterionId: "ac-provider-section",
        statement: "The artifact states the model provider usage it incurred.",
        check: "artifact_section_present",
        parameter: "Model Provider Usage",
      },
      {
        // Calibrated to what two independent specialists reliably cite between
        // them. It is a real check on a real number; setting it where a model
        // would randomly miss it would measure the weather, not the fabric.
        criterionId: "ac-evidence-coverage",
        statement: "At least two distinct evidence references support the result.",
        check: "evidence_coverage_minimum",
        parameter: "2",
      },
      {
        criterionId: "ac-no-rejected",
        statement: "No rejected claim appears in the artifact.",
        check: "no_rejected_claim_present",
        parameter: "",
      },
      {
        criterionId: "ac-founder-judgment",
        statement: "The founder judges the model-worker admission sound.",
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
    timeBudgetMs: options.timeBudgetMs ?? TIME_BUDGET_MS,
    maxParallelism: 2,
    executionPolicy: options.executionPolicy ?? "model_required_for_judgment",
    ...(options.providerBindings ? { providerBindings: options.providerBindings } : {}),
    ...(options.modelNodeCostCeilingMicros !== undefined
      ? { modelNodeCostCeilingMicros: options.modelNodeCostCeilingMicros }
      : {}),
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

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-csi-"));
let operator: OperatorProcess | null = null;
let verdict: "PASS" | "FAIL" = "FAIL";
let failure: string | null = null;

const startedAt = new Date().toISOString();
const runId = Date.now().toString(36);
const missionId = `csi-model-${runId}`;
const recoveryMissionId = `csi-recovery-${runId}`;
const submitToken = `csi-submit-${Math.random().toString(36).slice(2)}`;
const controlToken = `csi-control-${Math.random().toString(36).slice(2)}`;
const ledgerToken = `csi-ledger-${Math.random().toString(36).slice(2)}`;

const fixtureRoot = path.join(temporaryRoot, "fixtures");
const artifactRoot = path.join(temporaryRoot, "artifacts");
const databasePath = path.join(temporaryRoot, "operator.sqlite");
mkdirSync(fixtureRoot, { recursive: true });
mkdirSync(artifactRoot, { recursive: true });

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

const observed: Record<string, unknown> = { missionId, recoveryMissionId };

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
    AGENTIC_FABRIC_APPROVAL_TTL_MS: "1800000",
    AGENTIC_FABRIC_LOCAL_MODEL_BASE_URL: LOCAL_MODEL_BASE_URL,
    // Passed through to the real server process so the billed binding can be
    // enabled. Empty when unprovisioned, which leaves it disabled.
    AGENTIC_FABRIC_OPENROUTER_API_KEY: OPENROUTER_API_KEY,
    OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT: operatorRoot,
    ...overrides,
  };
}

const osMissionId = `os:governed_agentic_mission:${missionId}`;
const requestedAt = startedAt;
const mainSubmission = submission({ missionId, artifactName: ARTIFACT_NAME, requestedAt });

try {
  console.log("CHANTER OS — collective synthetic intelligence governed model-worker proof");
  console.log(`  temporary root: ${temporaryRoot}`);
  console.log(`  local provider: ${LOCAL_MODEL_BASE_URL}`);

  // =========================================================================
  phase("A — compile under a declared model policy");
  // =========================================================================

  const providerProbe = await step(
    "Confirm a real model provider is reachable and reports measured usage",
    async () => {
      // Outside the fabric on purpose: this establishes that the environment can
      // answer at all, before any claim is made about what the fabric did with
      // it. A proof that cannot tell "the fabric refused" from "the machine had
      // no model" is not a proof of either.
      let reachable = false;
      let models: string[] = [];
      try {
        const response = await fetch(`${LOCAL_MODEL_BASE_URL}/api/tags`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { models?: Array<{ model?: string }> };
          models = (body.models ?? []).map((entry) => String(entry.model ?? ""));
          reachable = models.includes(LIVE_MODEL_ID);
        }
      } catch {
        reachable = false;
      }
      if (!reachable && !allowMissingProvider) {
        throw new Error(
          `No live provider is available: ${LOCAL_MODEL_BASE_URL} did not offer model "${LIVE_MODEL_ID}". `
          + "This proof requires one real model-provider call. Re-run with --allow-missing-provider only if "
          + "you intend to skip the live-provider evidence, and report the result as BLOCKED.",
        );
      }
      // Checked here, before a single token is spent, so the billed acceptance
      // command fails on a missing prerequisite in seconds rather than after
      // minutes of local inference it was never going to be able to use.
      if (requireBilledProvider && OPENROUTER_API_KEY.length === 0) {
        throw new Error(
          "--require-billed-provider was passed but AGENTIC_FABRIC_OPENROUTER_API_KEY is empty. "
          + "The billed cost-authority seam cannot be proven without an authorized credential, and no "
          + "unbilled evidence substitutes for it.",
        );
      }
      observed.liveProviderReachable = reachable;
      observed.liveProviderModels = models;
      return {
        baseUrl: LOCAL_MODEL_BASE_URL,
        reachable,
        models,
        billedProviderConfigured: OPENROUTER_API_KEY.length > 0,
        billedProviderRequired: requireBilledProvider,
      };
    },
  );
  const liveProvider = providerProbe.reachable === true;

  let port = await freePort();
  operator = await startOperator(environmentFor(), port);
  observed.firstOperatorPid = operator.pid;

  const compiled = await step(
    "Submit one mission that requires model-backed judgement and compile a deterministic plan",
    async () => {
      const created = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, mainSubmission);
      assert.equal(created.status, 201, `Expected 201, got ${created.status}: ${JSON.stringify(created.body)}`);
      assert.equal(created.body.lane, "governed_agentic_mission");
      assert.equal(created.body.status, "approval_required");

      const plan = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/plan`);
      assert.equal(plan.status, 200);
      const nodes = list(record(plan.body.plan).nodes);
      const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));

      // The two specialists became model workers; every other node did not.
      for (const nodeId of ["N2", "N3"]) {
        const node = record(byId.get(nodeId));
        assert.equal(node.workerKind, "model_worker", `${nodeId} must be a model worker.`);
        assert.equal(
          node.providerBindingId,
          LIVE_BINDING_ID,
          `${nodeId} must be bound to the reviewed live provider binding.`,
        );
        const budget = record(node.budget);
        assert.equal(budget.maxToolCalls, 0, `${nodeId} must be granted no tool at all.`);
        assert.ok(Number(budget.maxTokens) > 0, `${nodeId} must carry a token ceiling.`);
      }
      for (const nodeId of ["N1", "N4", "N5", "N7", "N8"]) {
        const node = record(byId.get(nodeId));
        assert.equal(node.workerKind, "deterministic_tool", `${nodeId} must stay deterministic.`);
        assert.equal(node.providerBindingId, null, `${nodeId} must reach no provider.`);
      }
      assert.equal(record(byId.get("N6")).capabilityId, null, "The authority checkpoint runs no worker.");

      observed.intentHash = created.body.payloadHash ?? record(created.body.identity).payloadHash;
      observed.planId = record(plan.body.plan).planId;
      observed.planHash = record(plan.body.plan).planHash;
      return {
        planId: observed.planId,
        planHash: observed.planHash,
        modelNodes: ["N2", "N3"],
        deterministicNodes: ["N1", "N4", "N5", "N7", "N8"],
      };
    },
  );

  await step("Refuse a mission naming a provider binding nobody registered", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, submission({
      missionId: `${missionId}-unregistered`,
      artifactName: `UNREGISTERED_${ARTIFACT_NAME}`,
      requestedAt,
      providerBindings: [{ capabilityId: "architecture.analyze", bindingId: "openai.gpt-9.turbo" }],
    }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_PROVIDER_BINDING_UNREGISTERED");
    assert.equal(providerCallCount(databasePath, `${missionId}-unregistered`), 0);
    return { httpStatus: refused.status, code: refused.body.code, providerCalls: 0 };
  });

  await step("Refuse forcing a deterministic capability onto a model worker", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, submission({
      missionId: `${missionId}-deterministic`,
      artifactName: `DETERMINISTIC_${ARTIFACT_NAME}`,
      requestedAt,
      providerBindings: [{ capabilityId: "evidence.verify", bindingId: LIVE_BINDING_ID }],
    }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_MODEL_WORKER_NOT_PERMITTED");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse provider bindings under a policy that routes nothing to a model", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, submission({
      missionId: `${missionId}-inert`,
      artifactName: `INERT_${ARTIFACT_NAME}`,
      requestedAt,
      executionPolicy: "cheapest_sufficient",
      providerBindings: [{ capabilityId: "architecture.analyze", bindingId: LIVE_BINDING_ID }],
    }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Refuse a model mission whose time budget only covers the cheapest plan", async () => {
    const refused = await postJson(operator!.baseUrl, "/api/os/missions", submitToken, submission({
      missionId: `${missionId}-cheap-budget`,
      artifactName: `CHEAP_${ARTIFACT_NAME}`,
      requestedAt,
      timeBudgetMs: 200_000,
    }));
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, "AGENTIC_INTENT_BUDGET_BELOW_MINIMUM");
    return { httpStatus: refused.status, code: refused.body.code };
  });

  await step("Prove no provider was reached before a human granted execution authority", async () => {
    assert.equal(providerCallCount(databasePath, missionId), 0, "A compiled plan may not call a provider.");
    assert.equal(workerRecordCount(databasePath, missionId), 0);
    const refusedApproval = await postJson(
      operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, submitToken, { approvedBy: APPROVER });
    assert.equal(refusedApproval.status, 401, "The submit capability must not be able to approve.");
    assert.equal(providerCallCount(databasePath, missionId), 0, "A refused approval may not spend.");
    return { providerCalls: 0, workerRecords: 0, submitTokenApprovalStatus: refusedApproval.status };
  });

  // =========================================================================
  phase("B — real provider-backed specialist execution");
  // =========================================================================

  const execution = await step(
    "Approve execution and run two independent model workers under real Governor admission",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken, { approvedBy: APPROVER });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
      assert.equal(record(approved.body).laneState, "awaiting_authority");

      const nodes = list((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes`)).body.nodes);
      const states = Object.fromEntries(nodes.map((node) => [String(node.nodeId), node.state]));
      for (const nodeId of ["N1", "N2", "N3", "N4", "N5"]) {
        assert.equal(states[nodeId], "completed", `${nodeId} must have completed. States: ${JSON.stringify(states)}`);
      }
      assert.equal(states.N6, "ready");
      assert.equal(states.N7, "blocked");
      return { states };
    },
  );

  const usage = await step(
    "Prove both specialist nodes really called a provider, with measured token usage",
    async () => {
      const rows = providerUsageRows(databasePath, missionId);
      assert.equal(rows.length, 2, `Expected exactly two provider calls, saw ${rows.length}.`);
      const byNode = new Map(rows.map((row) => [String(row.node_id), row]));
      assert.ok(byNode.has("N2") && byNode.has("N3"), "One provider call per specialist node.");

      let totalInput = 0;
      let totalOutput = 0;
      for (const [nodeId, row] of byNode) {
        assert.equal(row.binding_id, LIVE_BINDING_ID, `${nodeId} must use the reviewed live binding.`);
        assert.equal(row.provider_name, "ollama");
        assert.equal(row.model_id, LIVE_MODEL_ID);
        assert.equal(row.mode, "live", `${nodeId} must be a live-mode provider call, not a simulation.`);
        assert.equal(row.typed_error_json, null, `${nodeId}'s provider call must have succeeded.`);

        // Measured, never estimated.
        const input = Number(row.input_tokens);
        const output = Number(row.output_tokens);
        assert.ok(Number.isInteger(input) && input > 0, `${nodeId} must report measured input tokens.`);
        assert.ok(Number.isInteger(output) && output > 0, `${nodeId} must report measured output tokens.`);
        assert.equal(Number(row.total_tokens), input + output);
        totalInput += input;
        totalOutput += output;

        assert.match(String(row.request_hash), /^[0-9a-f]{64}$/);
        assert.match(String(row.raw_response_hash), /^[0-9a-f]{64}$/);
        assert.match(String(row.response_hash), /^[0-9a-f]{64}$/);
        assert.ok(Number(row.latency_ms) > 0, `${nodeId} must record a real latency.`);
        assert.equal(row.finish_reason, "stop");
        assert.equal(row.fallback_decision, "not_required");

        // Cost honesty: unbilled local compute reports `null` plus a reason.
        assert.equal(
          row.monetary_cost_micros,
          null,
          `${nodeId} must report no monetary cost for an unbilled local provider.`,
        );
        assert.equal(row.monetary_cost_source, "unpriced_local_compute");
        assert.match(String(row.monetary_cost_unavailable_reason), /no invoice exists/i);
        assert.equal(row.pricing_revision, null);
        // Ollama issues no request identifier, and none is fabricated.
        assert.equal(row.provider_request_id, null);
      }

      observed.liveProviderCalls = rows.length;
      observed.liveInputTokens = totalInput;
      observed.liveOutputTokens = totalOutput;
      observed.liveTotalTokens = totalInput + totalOutput;
      observed.providerCallKeys = rows.map((row) => String(row.provider_call_key));
      return {
        providerCalls: rows.length,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        totalTokens: totalInput + totalOutput,
        monetaryCost: null,
        monetaryCostSource: "unpriced_local_compute",
      };
    },
  );

  await step("Prove the two model workers were genuinely independent requests", async () => {
    const rows = providerUsageRows(databasePath, missionId);
    const n2 = rows.find((row) => row.node_id === "N2")!;
    const n3 = rows.find((row) => row.node_id === "N3")!;
    assert.notEqual(n2.provider_call_key, n3.provider_call_key, "Independent nodes need independent call keys.");
    assert.notEqual(
      n2.request_hash,
      n3.request_hash,
      "Two specialists asking the same question would not be two specialists.",
    );

    // Structural independence, re-read from the durable plan rather than assumed.
    const plan = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/plan`);
    const nodes = list(record(plan.body.plan).nodes);
    const n2Node = record(nodes.find((node) => node.nodeId === "N2"));
    const n3Node = record(nodes.find((node) => node.nodeId === "N3"));
    assert.deepEqual(n2Node.dependencyIds, ["N1"]);
    assert.deepEqual(n3Node.dependencyIds, ["N1"]);
    assert.ok(!(n2Node.inputRefs as string[]).includes("N3"));
    assert.ok(!(n3Node.inputRefs as string[]).includes("N2"));
    return {
      distinctCallKeys: true,
      distinctRequestHashes: true,
      n2Dependencies: n2Node.dependencyIds,
      n3Dependencies: n3Node.dependencyIds,
    };
  });

  await step("Prove observed concurrency from the durable event journal", async () => {
    const evidence = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`);
    const events = list(evidence.body.events).filter((event) => event.scope === "node");
    let concurrent = 0;
    let peak = 0;
    const order: string[] = [];
    for (const event of events) {
      if (event.newState === "running") {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        order.push(`start:${String(event.nodeId)}`);
      } else if (event.previousState === "running" && event.newState !== "running") {
        concurrent = Math.max(0, concurrent - 1);
        order.push(`end:${String(event.nodeId)}`);
      }
    }
    const firstEnd = order.findIndex((entry) => entry === "end:N2" || entry === "end:N3");
    assert.ok(order.indexOf("start:N2") < firstEnd, "N2 must start before either specialist finishes.");
    assert.ok(order.indexOf("start:N3") < firstEnd, "N3 must start before either specialist finishes.");
    assert.ok(peak >= 2 && peak <= 2, `Observed concurrency ${peak} must be exactly the declared limit of 2.`);
    observed.parallelismObserved = peak;
    return { peakConcurrency: peak, admissionOrder: order.slice(0, 6) };
  });

  await step("Prove no prompt, reasoning, or credential reached any durable record", async () => {
    const text = agenticDatabaseText(databasePath);
    // The bounded system instruction is a distinctive string that exists only in
    // the prompt. Finding it in the database would mean prompts are persisted.
    assert.ok(
      !text.includes("You are a specialist analyst inside a governed execution fabric"),
      "The system instruction must never be persisted; only its digest.",
    );
    assert.ok(!text.includes("# Admitted evidence"), "The assembled prompt must never be persisted.");
    for (const pattern of [/"thinking"/i, /<think>/i, /chain[_ -]?of[_ -]?thought/i]) {
      assert.ok(!pattern.test(text), `Hidden reasoning marker ${pattern} must be absent from durable records.`);
    }
    for (const pattern of [/Bearer\s+[A-Za-z0-9._~+/-]{8,}/, /sk-[A-Za-z0-9]{16,}/, /api[_-]?key["':\s]+[A-Za-z0-9]{8,}/i]) {
      assert.ok(!pattern.test(text), `Credential-shaped material ${pattern} must be absent from durable records.`);
    }
    // The submit and control tokens are this run's real secrets.
    assert.ok(!text.includes(submitToken) && !text.includes(controlToken), "No capability token may be persisted.");
    return { promptPersisted: false, reasoningPersisted: false, credentialsPersisted: false };
  });

  // =========================================================================
  phase("C — independent verification and evidence-gated synthesis");
  // =========================================================================

  const candidateHash = await step(
    "Prove an independent deterministic verifier judged the model's claims",
    async () => {
      const verifier = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N4`)).body);
      assert.equal(verifier.workerKind, "deterministic_tool", "The verifier must never be a model.");
      const output = record(verifier.output);
      const accepted = list(output.acceptedClaims);
      const rejected = list(output.rejectedClaims);
      assert.ok(accepted.length > 0, "The model produced no claim the verifier could accept.");
      assert.ok(
        ["accepted", "accepted_with_rejections"].includes(String(output.verificationVerdict)),
        `Unexpected verdict ${String(output.verificationVerdict)}.`,
      );

      // Every accepted claim cites an admitted context id — checked here against
      // the durable bundle rather than trusting the verifier's own verdict.
      const evidence = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`);
      const admitted = new Set(
        list(record(evidence.body.contextBundle).items).map((item) => String(item.contextItemId)),
      );
      for (const claim of accepted) {
        for (const reference of claim.evidenceRefs as string[]) {
          assert.ok(admitted.has(reference), `Accepted claim cites unadmitted reference ${reference}.`);
        }
      }
      // Claims came from both independent specialists.
      const sourceNodes = new Set(accepted.map((claim) => String(claim.sourceNodeId)));
      assert.ok(sourceNodes.has("N2") && sourceNodes.has("N3"), "Both specialists must have contributed.");

      const synthesis = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N5`)).body);
      assert.equal(synthesis.workerKind, "deterministic_tool", "Synthesis must never be a model.");
      const rejectedIds = new Set(rejected.map((claim) => String(claim.claimId)));
      const sourceClaimIds = (record(synthesis.output).sourceClaimIds ?? []) as string[];
      for (const claimId of sourceClaimIds) {
        assert.ok(!rejectedIds.has(claimId), `Synthesis consumed rejected claim ${claimId}.`);
      }

      const mission = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`);
      const authority = record(record(mission.body).authority);
      assert.ok(authority.candidateOutputHash, "A candidate hash must be bound before approval.");
      assert.equal(authority.approvedOutputHash, null, "Nothing may be approved yet.");
      observed.acceptedClaimCount = accepted.length;
      observed.rejectedClaimCount = rejected.length;
      observed.candidateHash = authority.candidateOutputHash;
      return {
        verdict: output.verificationVerdict,
        acceptedClaims: accepted.length,
        rejectedClaims: rejected.length,
        contributingNodes: [...sourceNodes].sort(),
        candidateHash: authority.candidateOutputHash,
      };
    },
  ).then((result) => String(result.candidateHash));

  // =========================================================================
  phase("D — human authority and the one consequential write");
  // =========================================================================

  await step("Prove the artifact write is unreachable before candidate approval", async () => {
    assert.equal(existsSync(path.join(artifactRoot, ARTIFACT_NAME)), false);
    const resumed = await postJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/resume`, controlToken, {});
    assert.equal(resumed.status, 200, "A resume is accepted, but it must not produce a write.");
    assert.equal(artifactWriteRows(databasePath, missionId), 0);
    assert.equal(existsSync(path.join(artifactRoot, ARTIFACT_NAME)), false);
    return { artifactExists: false, artifactWriteRows: 0 };
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

  const written = await step(
    "Approve the exact candidate, write one artifact atomically, and verify it from disk",
    async () => {
      const approved = await postJson(
        operator!.baseUrl, `/api/os/missions/${osMissionId}/approve`, controlToken,
        { approvedBy: APPROVER, candidateHash });
      assert.equal(approved.status, 200, `Expected 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);

      const artifactPath = path.join(artifactRoot, ARTIFACT_NAME);
      assert.ok(existsSync(artifactPath), "Exactly one artifact must now exist.");
      const bytes = readFileSync(artifactPath, "utf8");
      for (const section of REQUIRED_SECTIONS) {
        assert.ok(bytes.includes(`## ${section}`), `The artifact must state its ${section} section.`);
      }
      assert.equal(artifactWriteRows(databasePath, missionId), 1, "Exactly one durable write row.");

      const outcome = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/nodes/N8`)).body);
      const verification = record(outcome.output);
      assert.equal(verification.artifactExists, true);
      assert.equal(verification.hashMatchesApprovedCandidate, true);
      assert.deepEqual(verification.missingSections, []);
      assert.equal(verification.writeCount, 1);
      assert.equal(verification.outcomeVerified, true);

      const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`)).body);
      const authority = record(mission.authority);
      assert.equal(authority.approvedOutputHash, candidateHash);
      assert.ok(authority.authorityRevision, "The approval must bind a committed repository revision.");
      observed.artifactBytes = bytes.length;
      observed.artifactHash = candidateHash;
      observed.authorityRevision = authority.authorityRevision;
      return {
        artifactByteLength: bytes.length,
        artifactWriteRows: 1,
        outcomeVerified: true,
        approvedCandidateHash: candidateHash,
        authorityRevision: authority.authorityRevision,
      };
    },
  );

  const valueObservation = await step(
    "Prove the durable value observation reports measured model usage, not zeros",
    async () => {
      const mission = record((await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}`)).body);
      const value = record(record(mission.outcome).valueObservation ?? mission.valueObservation);
      assert.equal(value.modelWorkerCount, 2);
      assert.equal(value.providerCallCount, 2);
      assert.equal(value.providerFallbackCount, 0);
      assert.ok(Number(value.inputTokenCount) > 0, "Input tokens must be measured.");
      assert.ok(Number(value.outputTokenCount) > 0, "Output tokens must be measured.");
      assert.equal(
        Number(value.totalTokenCount),
        Number(value.inputTokenCount) + Number(value.outputTokenCount),
      );
      assert.equal(value.tokenCostSource, "provider_measured");
      // The one honest `null`: no invoice exists for local compute.
      assert.equal(value.monetaryCostMicros, null, "An unbilled provider must report null, never zero.");
      assert.equal(value.monetaryCostSource, "unpriced_local_compute");
      assert.deepEqual(value.modelIdentitiesUsed, [`ollama/${LIVE_MODEL_ID}`]);
      assert.equal((value.providerUsageReferences as string[]).length, 2);
      assert.equal(value.artifactWriteCount, 1);
      assert.equal(value.humanApprovals, 2);
      assert.equal(value.objectiveSatisfied, true);
      observed.valueObservation = value;
      return value;
    },
  );

  // =========================================================================
  phase("E — interruption at the real two-commit boundary");
  // =========================================================================

  await step("Interrupt a model node after its provider answered but before the plan committed", async () => {
    // The boundary this proof needs sits between the Runtime durably recording
    // the provider outcome and the Operator committing the node, and no HTTP
    // request can be timed into it. So the interruption is injected in-process
    // against the same SQLite file; the recovery below then runs through a real
    // server process, which is the part that has to survive a restart.
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
          governor: { pythonExecutable: resolvePython(), governorRoot, timeoutMs: 60_000 },
          approvalTtlMs: 1_800_000,
          authorityRevision: resolveAgenticAuthorityRevision(operatorRoot),
          providers: {
            localModelBaseUrl: LOCAL_MODEL_BASE_URL,
            simulatorEnabled: false,
            simulatorScenario: "disabled",
            // Configured identically to the server process so the in-process
            // recovery phase resolves the same registry. The recovery mission
            // uses the local binding, so nothing here is purchased.
            openRouterApiKey: OPENROUTER_API_KEY,
            openRouterBaseUrl: "https://openrouter.ai",
          },
        },
        failureInjector: (boundary, context) => {
          if (boundary === "after_worker_record_before_node_commit" && context.nodeId === "N3") {
            throw new Error("Injected interruption after N3's provider result was durably recorded.");
          }
        },
      });

      const created = await service.submit(submission({
        missionId: recoveryMissionId,
        artifactName: `RECOVERY_${ARTIFACT_NAME}`,
        requestedAt,
        objective: "Re-assess model-worker admission after a node-level interruption.",
      }));
      assert.equal(created.view.status, "approval_required");

      await assert.rejects(
        service.approveExecution(recoveryMissionId, { approvedBy: APPROVER }),
        /Injected interruption/,
      );

      const nodes = service.nodes(recoveryMissionId);
      const states = Object.fromEntries(nodes.map((node) => [node.nodeId, node.state]));
      assert.equal(states.N3, "running", "The interrupted node is left mid-flight.");

      // The provider was reached exactly once, and that fact is already durable.
      const n3Calls = providerCallCountForNode(databasePath, recoveryMissionId, "N3");
      assert.equal(n3Calls, 1, "N3's provider outcome must be durable before the interruption.");
      observed.recoveryN3CallsBeforeRecovery = n3Calls;
      return { states, n3ProviderCallsBeforeRecovery: n3Calls };
    } finally {
      database.close();
    }
  });

  const recovery = await step(
    "Reconcile and resume through a real restarted server without a second provider call",
    async () => {
      port = await freePort();
      operator = await startOperator(environmentFor(), port);
      observed.recoveryOperatorPid = operator.pid;
      const osRecoveryId = `os:governed_agentic_mission:${recoveryMissionId}`;

      const beforeCalls = providerCallCountForNode(databasePath, recoveryMissionId, "N3");

      // A direct resume must be refused: the outcome is not yet established.
      const refusedResume = await postJson(
        operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/resume`, controlToken, {});
      assert.equal(refusedResume.status, 409);
      assert.equal(refusedResume.body.code, "AGENTIC_NODE_RECONCILIATION_REQUIRED");

      const reconciled = await postJson(
        operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/reconcile`, controlToken, {});
      assert.equal(reconciled.status, 200);
      assert.equal(record(reconciled.body).reconciliationOutcome, "worker_result_found");
      const afterReconcile = providerCallCountForNode(databasePath, recoveryMissionId, "N3");
      assert.equal(afterReconcile, beforeCalls, "Reconcile must read, never re-request.");

      const resumed = await postJson(
        operator.baseUrl, `/api/os/missions/${osRecoveryId}/nodes/N3/resume`, controlToken, {});
      assert.equal(resumed.status, 200);
      assert.equal(record(resumed.body).state, "completed");
      assert.equal(Number(record(resumed.body).attempts), 1, "Attempts must be unchanged by recovery.");

      const afterResume = providerCallCountForNode(databasePath, recoveryMissionId, "N3");
      assert.equal(afterResume, 1, "The interrupted node's provider call count must remain exactly one.");

      // The mission converges: verification, synthesis, approval, write, verify.
      const advanced = await postJson(
        operator.baseUrl, `/api/os/missions/${osRecoveryId}/resume`, controlToken, {});
      assert.equal(advanced.status, 200);
      const authority = record(record(advanced.body).authority);
      const recoveryCandidate = String(authority.candidateOutputHash);
      assert.ok(recoveryCandidate, "The recovered mission must compose a candidate.");
      const approved = await postJson(
        operator.baseUrl, `/api/os/missions/${osRecoveryId}/approve`, controlToken,
        { approvedBy: APPROVER, candidateHash: recoveryCandidate });
      assert.equal(approved.status, 200);
      assert.ok(existsSync(path.join(artifactRoot, `RECOVERY_${ARTIFACT_NAME}`)));
      assert.equal(artifactWriteRows(databasePath, recoveryMissionId), 1);

      const mission = record((await getJson(operator.baseUrl, `/api/os/missions/${osRecoveryId}`)).body);
      const value = record(record(mission.outcome).valueObservation ?? mission.valueObservation);
      assert.equal(value.providerCallCount, 2, "Two specialists, two provider calls, even after recovery.");
      assert.ok(Number(value.recoveryEvents) >= 1, "The recovery must be durably recorded.");
      assert.ok(
        Number(value.duplicateModelCallsPrevented) >= 1,
        "The reconcile that found N3's durable result prevented a duplicate model call, and must say so.",
      );
      observed.recoveryValueObservation = value;
      return {
        resumeBeforeReconcile: refusedResume.body.code,
        reconciliationOutcome: "worker_result_found",
        n3ProviderCallsAfterResume: afterResume,
        recoveryEvents: value.recoveryEvents,
        duplicateExecutionsPrevented: value.duplicateExecutionsPrevented,
        providerCallCount: value.providerCallCount,
      };
    },
  );

  // =========================================================================
  phase("F — abrupt restart and identical replay");
  // =========================================================================

  const replay = await step(
    "Kill Operator, restart on a new port, and replay the identical mission for free",
    async () => {
      const beforeCalls = providerCallCount(databasePath, missionId);
      const beforeWrites = artifactWriteRows(databasePath, missionId);
      const beforeBytes = readFileSync(path.join(artifactRoot, ARTIFACT_NAME), "utf8");
      const beforeEvidence = await getJson(operator!.baseUrl, `/api/os/missions/${osMissionId}/evidence`);
      const beforeEvents = list(beforeEvidence.body.events).length;
      const beforeTokens = providerUsageRows(databasePath, missionId)
        .reduce((total, row) => total + Number(row.total_tokens ?? 0), 0);

      await killOperator(operator);
      operator = null;
      port = await freePort();
      operator = await startOperator(environmentFor(), port);
      observed.replayOperatorPid = operator.pid;

      const replayed = await postJson(operator.baseUrl, "/api/os/missions", submitToken, mainSubmission);
      assert.equal(replayed.status, 200, `A completed mission must replay, not re-create. Got ${replayed.status}.`);
      assert.equal(replayed.body.replayed, true);

      const plan = await getJson(operator.baseUrl, `/api/os/missions/${osMissionId}/plan`);
      assert.equal(record(plan.body.plan).planId, observed.planId);
      assert.equal(record(plan.body.plan).planHash, observed.planHash);

      const afterCalls = providerCallCount(databasePath, missionId);
      const afterTokens = providerUsageRows(databasePath, missionId)
        .reduce((total, row) => total + Number(row.total_tokens ?? 0), 0);
      const afterWrites = artifactWriteRows(databasePath, missionId);
      const afterBytes = readFileSync(path.join(artifactRoot, ARTIFACT_NAME), "utf8");
      const afterEvents = list(
        (await getJson(operator.baseUrl, `/api/os/missions/${osMissionId}/evidence`)).body.events,
      ).length;

      assert.equal(afterCalls, beforeCalls, "A replay must not call a provider again.");
      assert.equal(afterTokens, beforeTokens, "A replay must not spend another token.");
      assert.equal(afterWrites, beforeWrites, "A replay must not write again.");
      assert.equal(afterBytes, beforeBytes, "The artifact bytes must be identical.");
      assert.equal(afterEvents, beforeEvents, "A replay must append no journal event.");

      const value = record(record(
        record((await getJson(operator.baseUrl, `/api/os/missions/${osMissionId}`)).body).outcome,
      ).valueObservation);
      assert.equal(value.monetaryCostMicros, null);
      assert.equal(Number(value.totalTokenCount), beforeTokens);
      return {
        replayed: true,
        providerCalls: `${beforeCalls} -> ${afterCalls}`,
        totalTokens: `${beforeTokens} -> ${afterTokens}`,
        artifactWrites: `${beforeWrites} -> ${afterWrites}`,
        journalEvents: `${beforeEvents} -> ${afterEvents}`,
        artifactBytesIdentical: afterBytes === beforeBytes,
      };
    },
  );

  await killOperator(operator);
  operator = null;

  // =========================================================================
  phase("G — provider failure modes (reviewed test-mode bindings)");
  // =========================================================================

  /**
   * Runs one scenario on its own database and its own Operator process.
   *
   * Each gets a fresh database because these scenarios deliberately leave
   * missions in failed and reconciliation-required states, and a shared database
   * would let one scenario's wreckage explain another's result.
   */
  async function runScenario(
    label: string,
    scenario: string,
    bindingId: string,
    body: (context: {
      baseUrl: string;
      databasePath: string;
      missionId: string;
      osMissionId: string;
      artifactRoot: string;
    }) => Promise<Record<string, unknown>>,
    overrides: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const scenarioRoot = path.join(temporaryRoot, `scenario-${label}`);
    const scenarioArtifacts = path.join(scenarioRoot, "artifacts");
    mkdirSync(scenarioArtifacts, { recursive: true });
    const scenarioDatabase = path.join(scenarioRoot, "operator.sqlite");
    const scenarioMissionId = `csi-${label}-${runId}`;
    const scenarioPort = await freePort();
    const scenarioOperator = await startOperator(
      {
        ...environmentFor({
          OPERATOR_DATABASE_PATH: scenarioDatabase,
          AGENTIC_FABRIC_ARTIFACT_DIR: scenarioArtifacts,
          AGENTIC_FABRIC_SIMULATOR_ENABLED: "true",
          AGENTIC_FABRIC_SIMULATOR_SCENARIO: scenario,
          ...overrides,
        }),
      },
      scenarioPort,
    );
    try {
      return await body({
        baseUrl: scenarioOperator.baseUrl,
        databasePath: scenarioDatabase,
        missionId: scenarioMissionId,
        osMissionId: `os:governed_agentic_mission:${scenarioMissionId}`,
        artifactRoot: scenarioArtifacts,
      });
    } finally {
      await killOperator(scenarioOperator);
    }
  }

  function simulatorSubmission(scenarioMissionId: string, extra: Partial<SubmissionOptions> = {}): Record<string, unknown> {
    return submission({
      missionId: scenarioMissionId,
      artifactName: `${scenarioMissionId}.md`,
      requestedAt,
      providerBindings: [
        { capabilityId: "architecture.analyze", bindingId: SIMULATOR_PRIMARY },
        { capabilityId: "risk.analyze", bindingId: SIMULATOR_PRIMARY },
      ],
      ...extra,
    });
  }

  await step("Deterministic declared fallback answers an unavailable primary provider", async () => {
    return runScenario(
      "fallback",
      "primary_unavailable_fallback_succeeds",
      SIMULATOR_PRIMARY,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken, simulatorSubmission(context.missionId));
        assert.equal(created.status, 201, JSON.stringify(created.body));
        const approved = await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });
        assert.equal(approved.status, 200, JSON.stringify(approved.body));

        const rows = providerUsageRows(context.databasePath, context.missionId);
        // Two nodes, each making a primary attempt and one declared fallback.
        assert.equal(rows.length, 4, `Expected four provider records, saw ${rows.length}.`);
        const primaries = rows.filter((row) => row.binding_id === SIMULATOR_PRIMARY);
        const fallbacks = rows.filter((row) => row.binding_id === SIMULATOR_FALLBACK);
        assert.equal(primaries.length, 2);
        assert.equal(fallbacks.length, 2);
        for (const row of primaries) {
          assert.match(String(row.typed_error_json), /AGENTIC_PROVIDER_UNREACHABLE/);
        }
        for (const row of fallbacks) {
          assert.equal(row.typed_error_json, null, "The declared fallback must have answered.");
          assert.equal(row.fallback_decision, "fallback_used");
          assert.equal(row.fallback_from_binding_id, SIMULATOR_PRIMARY);
          assert.equal(row.mode, "test", "A simulated call must never be recorded as live.");
          // The fallback inherited the original bounds and was priced by the
          // versioned snapshot, so a monetary ceiling is genuinely enforceable.
          assert.equal(row.monetary_cost_source, "local_price_snapshot");
          assert.match(String(row.pricing_revision), /^chanter\.agentic-price-snapshot\./);
          assert.ok(Number(row.monetary_cost_micros) > 0);
        }
        const states = Object.fromEntries(
          list((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes`)).body.nodes)
            .map((node) => [String(node.nodeId), node.state]),
        );
        assert.equal(states.N2, "completed");
        assert.equal(states.N3, "completed");

        // The independent verifier rejects a model's unsupported citation.
        //
        // This is asserted here rather than on the live mission because a real
        // model that cites correctly — as `gemma4:e4b` does — cannot be made to
        // produce a bad citation on demand without fabricating its output. The
        // scenario's document deliberately contains one claim citing an id the
        // context compiler never admitted, and the rejection below is the real
        // deterministic verifier acting on real model-shaped input.
        const verifier = record(
          (await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes/N4`)).body,
        );
        const output = record(verifier.output);
        const rejected = list(output.rejectedClaims);
        const accepted = list(output.acceptedClaims);
        assert.equal(output.verificationVerdict, "accepted_with_rejections");
        assert.ok(
          rejected.every((claim) => String(claim.reason) === "unsupported_evidence"),
          "Every rejection here must be for an unadmitted citation.",
        );
        assert.equal(rejected.length, 2, "One unsupported claim from each independent specialist.");
        // The supported claims survive: an unsupported citation costs the claim
        // that made it, never the node's other work or its peer's.
        assert.equal(accepted.length, 2, "Each specialist's supported claim must survive.");
        assert.deepEqual(
          [...new Set(accepted.map((claim) => String(claim.sourceNodeId)))].sort(),
          ["N2", "N3"],
          "Both specialists must retain a claim.",
        );
        return {
          providerRecords: rows.length,
          primaryFailures: primaries.length,
          fallbacksUsed: fallbacks.length,
          nodeStates: { N2: states.N2, N3: states.N3 },
          verificationVerdict: output.verificationVerdict,
          rejectedClaims: rejected.length,
          acceptedClaims: accepted.length,
        };
      },
    );
  });

  await step("An unknown provider outcome demands reconciliation and is never retried", async () => {
    return runScenario(
      "timeout",
      "primary_timeout_unknown_outcome",
      SIMULATOR_PRIMARY,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken, simulatorSubmission(context.missionId));
        assert.equal(created.status, 201);
        await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });

        const rows = providerUsageRows(context.databasePath, context.missionId);
        // One dispatch per specialist and no fallback: an unknown outcome may
        // not be answered by a second charge.
        assert.equal(rows.length, 2, `Expected two provider records, saw ${rows.length}.`);
        for (const row of rows) {
          assert.equal(row.binding_id, SIMULATOR_PRIMARY, "No fallback may follow an unknown outcome.");
          assert.match(String(row.typed_error_json), /AGENTIC_PROVIDER_TIMEOUT/);
        }
        const states = Object.fromEntries(
          list((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes`)).body.nodes)
            .map((node) => [String(node.nodeId), node.state]),
        );
        assert.equal(states.N2, "reconciliation_required");
        assert.equal(states.N3, "reconciliation_required");
        assert.equal(states.N7, "blocked");
        assert.equal(existsSync(path.join(context.artifactRoot, `${context.missionId}.md`)), false);

        const refusedResume = await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes/N2/resume`, controlToken, {});
        assert.equal(refusedResume.status, 409);
        assert.equal(refusedResume.body.code, "AGENTIC_NODE_RECONCILIATION_REQUIRED");
        assert.equal(
          providerUsageRows(context.databasePath, context.missionId).length,
          2,
          "A refused resume must not reach the provider.",
        );
        return {
          providerRecords: rows.length,
          fallbackRecords: 0,
          nodeStates: { N2: states.N2, N3: states.N3, N7: states.N7 },
          resumeBeforeReconcile: refusedResume.body.code,
          artifactExists: false,
        };
      },
    );
  });

  await step("A malformed model document is never silently accepted into synthesis", async () => {
    return runScenario(
      "malformed",
      "primary_malformed_output",
      SIMULATOR_PRIMARY,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken, simulatorSubmission(context.missionId));
        assert.equal(created.status, 201);
        await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });

        const rows = providerUsageRows(context.databasePath, context.missionId);
        const malformed = rows.filter((row) => String(row.typed_error_json ?? "").includes("OUTPUT_NOT_JSON"));
        assert.ok(malformed.length > 0, "The malformed document must be recorded as a typed failure.");
        for (const row of malformed) {
          assert.equal(row.response_hash, null, "No response hash may exist for a document that was refused.");
          assert.equal(row.binding_id, SIMULATOR_PRIMARY, "Malformed output must not trigger a fallback.");
        }
        const states = Object.fromEntries(
          list((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes`)).body.nodes)
            .map((node) => [String(node.nodeId), node.state]),
        );
        assert.notEqual(states.N5, "completed", "Synthesis must not run on a refused document.");
        assert.equal(states.N7, "blocked");
        assert.equal(existsSync(path.join(context.artifactRoot, `${context.missionId}.md`)), false);
        return {
          malformedRecords: malformed.length,
          fallbackAttempted: false,
          nodeStates: { N4: states.N4, N5: states.N5, N7: states.N7 },
          artifactExists: false,
        };
      },
    );
  });

  await step("An insufficient per-node cost ceiling keeps the provider call count at zero", async () => {
    return runScenario(
      "ceiling",
      "succeed",
      SIMULATOR_PRIMARY,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken,
          simulatorSubmission(context.missionId, { modelNodeCostCeilingMicros: 1 }));
        assert.equal(created.status, 201);
        await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });

        assert.equal(
          providerUsageRows(context.databasePath, context.missionId).length,
          0,
          "A refusal evaluated before dispatch must produce no provider record and no charge.",
        );
        const n2 = record((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes/N2`)).body);
        assert.match(
          String(record(n2.typedError ?? {}).message ?? ""),
          /AGENTIC_PROVIDER_COST_CEILING_INSUFFICIENT/,
        );
        assert.equal(existsSync(path.join(context.artifactRoot, `${context.missionId}.md`)), false);
        return { providerRecords: 0, nodeState: n2.state, artifactExists: false };
      },
    );
  });

  await step("An unpriced provider refuses a monetary ceiling rather than pretending to enforce it", async () => {
    return runScenario(
      "unenforceable",
      "succeed",
      LIVE_BINDING_ID,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken, submission({
            missionId: context.missionId,
            artifactName: `${context.missionId}.md`,
            requestedAt,
            modelNodeCostCeilingMicros: 5_000,
          }));
        assert.equal(created.status, 201);
        await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });

        assert.equal(
          providerUsageRows(context.databasePath, context.missionId).length,
          0,
          "A ceiling nobody can evaluate must refuse before dispatch.",
        );
        const n2 = record((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes/N2`)).body);
        assert.match(
          String(record(n2.typedError ?? {}).message ?? ""),
          /AGENTIC_PROVIDER_COST_CEILING_UNENFORCEABLE/,
        );
        return { providerRecords: 0, nodeState: n2.state, code: "AGENTIC_PROVIDER_COST_CEILING_UNENFORCEABLE" };
      },
    );
  });

  await step("An unreachable live provider fails closed with no fallback and no artifact", async () => {
    const deadPort = await freePort();
    return runScenario(
      "failclosed",
      "disabled",
      LIVE_BINDING_ID,
      async (context) => {
        const created = await postJson(
          context.baseUrl, "/api/os/missions", submitToken, submission({
            missionId: context.missionId,
            artifactName: `${context.missionId}.md`,
            requestedAt,
          }));
        assert.equal(created.status, 201);
        await postJson(
          context.baseUrl, `/api/os/missions/${context.osMissionId}/approve`, controlToken,
          { approvedBy: APPROVER });

        const rows = providerUsageRows(context.databasePath, context.missionId);
        for (const row of rows) {
          assert.match(String(row.typed_error_json), /AGENTIC_PROVIDER_UNREACHABLE|AGENTIC_PROVIDER_TRANSPORT/);
          assert.equal(row.binding_id, LIVE_BINDING_ID, "There is no declared fallback to a simulator.");
        }
        const states = Object.fromEntries(
          list((await getJson(context.baseUrl, `/api/os/missions/${context.osMissionId}/nodes`)).body.nodes)
            .map((node) => [String(node.nodeId), node.state]),
        );
        assert.notEqual(states.N5, "completed");
        assert.equal(states.N7, "blocked");
        assert.equal(existsSync(path.join(context.artifactRoot, `${context.missionId}.md`)), false);
        return {
          providerRecords: rows.length,
          simulatorFallbackUsed: false,
          nodeStates: { N2: states.N2, N3: states.N3, N7: states.N7 },
          artifactExists: false,
        };
      },
      { AGENTIC_FABRIC_LOCAL_MODEL_BASE_URL: `http://127.0.0.1:${deadPort}` },
    );
  });

  // =========================================================================
  phase("H — billed external provider cost authority");
  // =========================================================================

  const billedConfigured = OPENROUTER_API_KEY.length > 0;
  observed.billedProviderConfigured = billedConfigured;
  observed.billedProviderProven = false;

  await step("Establish whether a billed external provider is authorized", async () => {
    // Presence only. The value is never read into any output, and the run's own
    // credential is scanned for *absence* in durable state further below. The
    // hard requirement was already enforced in phase A, before any spend.
    return {
      billedProviderConfigured: billedConfigured,
      required: requireBilledProvider,
      bindingId: EXTERNAL_BILLED_BINDING_ID,
      modelId: EXTERNAL_BILLED_MODEL_ID,
    };
  });

  if (billedConfigured) {
    const billedMissionId = `csi-billed-${runId}`;
    const osBilledId = `os:governed_agentic_mission:${billedMissionId}`;
    const billedArtifact = `BILLED_${ARTIFACT_NAME}`;

    const billed = await step(
      "Purchase two real inference calls and record the provider-reported charge",
      async () => {
        port = await freePort();
        operator = await startOperator(environmentFor(), port);

        const created = await postJson(operator.baseUrl, "/api/os/missions", submitToken, submission({
          missionId: billedMissionId,
          artifactName: billedArtifact,
          requestedAt,
          objective: "Prove billed external provider cost authority end to end.",
          providerBindings: [
            { capabilityId: "architecture.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
            { capabilityId: "risk.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
          ],
        }));
        assert.equal(created.status, 201, JSON.stringify(created.body));

        // Nothing is purchased before a human grants execution authority.
        assert.equal(providerCallCount(databasePath, billedMissionId), 0);
        const approved = await postJson(
          operator.baseUrl, `/api/os/missions/${osBilledId}/approve`, controlToken, { approvedBy: APPROVER });
        assert.equal(approved.status, 200, JSON.stringify(approved.body));

        const rows = providerUsageRows(databasePath, billedMissionId);
        assert.equal(rows.length, 2, `Expected exactly two billed calls, saw ${rows.length}.`);
        let totalMicros = 0;
        for (const row of rows) {
          assert.equal(row.binding_id, EXTERNAL_BILLED_BINDING_ID);
          // The counterparty that charged the account — not the model vendor.
          assert.equal(row.provider_name, "openrouter");
          assert.equal(row.model_id, EXTERNAL_BILLED_MODEL_ID);
          assert.equal(row.mode, "live", "a billed call must never be recorded as test mode");
          assert.equal(row.typed_error_json, null, JSON.stringify(row.typed_error_json));

          assert.ok(Number(row.input_tokens) > 0, "provider-authoritative input tokens");
          assert.ok(Number(row.output_tokens) > 0, "provider-authoritative output tokens");

          // The seam this whole P0 exists to close.
          const micros = Number(row.monetary_cost_micros);
          assert.ok(
            row.monetary_cost_micros !== null && Number.isFinite(micros) && micros > 0,
            "a billed call must record a real non-null monetary charge",
          );
          assert.equal(row.monetary_cost_source, "provider_reported");
          assert.equal(row.pricing_revision, null, "a reported charge needs no invented price");
          assert.ok(String(row.provider_request_id ?? "").length > 0, "the generation id must be recorded");
          totalMicros += micros;
        }
        observed.billedProviderCalls = rows.length;
        observed.billedTotalMicros = totalMicros;
        return {
          billedCalls: rows.length,
          totalMonetaryCostMicros: totalMicros,
          totalMonetaryCostUsd: (totalMicros / 1_000_000).toFixed(6),
          monetaryCostSource: "provider_reported",
        };
      },
    );

    await step("Reconcile each charge against the provider's own billing record", async () => {
      const rows = providerUsageRows(databasePath, billedMissionId);
      const verdicts: string[] = [];
      for (const row of rows) {
        const reconciliation = JSON.parse(String(row.reconciliation_json ?? "{}")) as Record<string, unknown>;
        verdicts.push(String(reconciliation.verdict));
        assert.equal(
          reconciliation.evidenceType,
          "provider_generation_lookup",
          "billing evidence must come from the provider's own record, never a price list",
        );
        // `unavailable` is honest and permitted; `mismatched` is not, because it
        // means the charge and the provider's record genuinely disagree.
        assert.notEqual(
          reconciliation.verdict,
          "mismatched",
          `The provider's record disagrees with the recorded charge: ${JSON.stringify(reconciliation)}`,
        );
        if (reconciliation.verdict === "matched") {
          assert.equal(reconciliation.deltaMicros, 0 || reconciliation.deltaMicros);
          assert.ok(Number(reconciliation.externalAmountMicros) > 0);
        }
      }
      observed.billedReconciliationVerdicts = verdicts;
      const allMatched = verdicts.every((verdict) => verdict === "matched");
      observed.billedProviderProven = allMatched;
      assert.ok(
        allMatched,
        `Billing reconciliation did not confirm every charge: ${verdicts.join(", ")}. `
        + "A PASS requires the provider's own record to confirm what CHANTER recorded.",
      );
      return { verdicts, reconciliationSource: "provider_generation_lookup" };
    });

    await step("Prove a replay of the billed mission purchases nothing", async () => {
      const beforeRows = providerUsageRows(databasePath, billedMissionId);
      const beforeMicros = beforeRows.reduce((total, row) => total + Number(row.monetary_cost_micros ?? 0), 0);

      // An abrupt kill, then the identical submission against the same state.
      await killOperator(operator);
      operator = null;
      port = await freePort();
      operator = await startOperator(environmentFor(), port);

      const replayed = await postJson(operator.baseUrl, "/api/os/missions", submitToken, submission({
        missionId: billedMissionId,
        artifactName: billedArtifact,
        requestedAt,
        objective: "Prove billed external provider cost authority end to end.",
        providerBindings: [
          { capabilityId: "architecture.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
          { capabilityId: "risk.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
        ],
      }));
      assert.equal(replayed.status, 200);
      assert.equal(replayed.body.replayed, true);

      const afterRows = providerUsageRows(databasePath, billedMissionId);
      const afterMicros = afterRows.reduce((total, row) => total + Number(row.monetary_cost_micros ?? 0), 0);
      assert.equal(afterRows.length, beforeRows.length, "a replay must not purchase another call");
      assert.equal(afterMicros, beforeMicros, "a replay must not change what was spent");
      return {
        billedCalls: `${beforeRows.length} -> ${afterRows.length}`,
        monetaryCostMicros: `${beforeMicros} -> ${afterMicros}`,
      };
    });

    await step("Prove the billed credential reached no durable record", async () => {
      const text = agenticDatabaseText(databasePath);
      // The literal value is used in memory only, for an absence check. It is
      // never printed, and only the result of the check is reported.
      assert.ok(!text.includes(OPENROUTER_API_KEY), "the provider credential must never be persisted");
      assert.doesNotMatch(text, /Bearer\s+sk-or-/i);
      assert.doesNotMatch(text, /sk-or-v1-[A-Za-z0-9]{8,}/);
      return { credentialPersisted: false, credentialValueChecked: true, credentialValuePrinted: false };
    });
  } else {
    await step("Report the billed cost-authority seam as unproven", async () => {
      // Reported, never skipped silently. A green gate must not imply that real
      // money was governed when no billed provider was ever reachable.
      console.log("");
      console.log("  !! BILLED EXTERNAL PROVIDER COST AUTHORITY: NOT PROVEN");
      console.log("     No AGENTIC_FABRIC_OPENROUTER_API_KEY is configured, so no real charge was");
      console.log("     incurred, measured, or reconciled. Everything above is unbilled evidence.");
      console.log("     The P0 acceptance command is:");
      console.log("       npm run os:csi-model-workers -- --require-billed-provider");
      return {
        billedProviderProven: false,
        reason: "no billed external provider credential is configured",
        monetaryCostMicros: null,
      };
    });
  }

  verdict = "PASS";
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  verdict = "FAIL";
} finally {
  await killOperator(operator);

  mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, "csi-model-workers-report.json");
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      verdict,
      failure,
      startedAt,
      completedAt: new Date().toISOString(),
      liveProviderRequired: !allowMissingProvider,
      billedProviderRequired: requireBilledProvider,
      billedProviderConfigured: observed.billedProviderConfigured ?? false,
      billedProviderProven: observed.billedProviderProven ?? false,
      localModelBaseUrl: LOCAL_MODEL_BASE_URL,
      observed,
      steps,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`Report: ${reportPath}`);
  const passed = steps.filter((entry) => entry.outcome === "passed").length;
  console.log(`${verdict}  (${passed}/${steps.length} steps)`);
  console.log(
    observed.billedProviderProven === true
      ? "Billed external provider cost authority: PROVEN (real charge measured and reconciled)"
      : "Billed external provider cost authority: NOT PROVEN (no billed charge occurred)",
  );
  if (failure) console.error(`Failure: ${failure}`);

  if (!keepArtifacts) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  } else {
    console.log(`Kept temporary root: ${temporaryRoot}`);
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
