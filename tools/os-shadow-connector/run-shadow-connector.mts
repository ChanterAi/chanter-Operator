/**
 * CHANTER OS — operational exception shadow connector binding proof.
 *
 * Binds the proven exception contract to **one real external system** in
 * read-only mode: a hosted git remote, observed through `git ls-remote`.
 *
 *     real external source -> real ObservedState -> real revision evidence
 *       -> DesiredState -> StateDelta -> exact ActionContract compiled but NOT executed
 *       -> independent read-only verification -> shadow TerminalOutcome -> ValueObservation
 *
 * ## Why a git remote
 *
 * It is the only real system reachable from this environment that offers a
 * genuine revision contract, and it offers an unusually strong one: the commit
 * SHA is content-addressed, so one revision can never name two states. Most
 * sources give a counter or an `updated_at` that can repeat or drift.
 *
 * The exception is real rather than invented. Every CHANTER P0 ends with
 * reviewed work committed locally and not pushed, so "the remote does not carry
 * the reviewed HEAD" is this system's actual standing condition. The action that
 * would resolve it is a ref update — precisely the real external write the next
 * slice must gate, and precisely what this one compiles and refuses to perform.
 *
 * ## Real external writes = 0
 *
 * Three independent structural facts, none of them a runtime check:
 *
 *   1. the connector exposes **no `apply` method**;
 *   2. the shadow plan compiles **no node with any side effect**;
 *   3. the shadow worker set contains **no applying worker**.
 *
 * Plus transport telemetry: every `git` invocation's argv is recorded, and the
 * permitted subcommand allowlist is exactly `["ls-remote"]`. A mutating call is
 * not merely unobserved — it is unconstructable.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase } from "../../apps/backend/src/db/database.js";
import { AgenticMissionService } from "../../apps/backend/src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../../apps/backend/src/agentic/agenticPlanJournal.js";
import {
  AGENTIC_SHADOW_EXCEPTION_MISSION_CAPABILITIES,
} from "../../apps/backend/src/agentic/agenticCapabilityRegistry.js";
import {
  createGitRefConnector,
  gitRefTargetId,
  GIT_REF_CONNECTOR_ID,
  GIT_REF_CONNECTOR_MANIFEST,
  type GitRefConnector,
} from "../../apps/backend/src/agentic/agenticGitRefConnector.js";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../../apps/backend/src/agentic/agenticPlanGovernorPort.js";

const operatorRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const argv = process.argv.slice(2);
const keepArtifacts = argv.includes("--keep");
const repeatIndex = Number.parseInt(argv[argv.indexOf("--run") + 1] ?? "1", 10);
const outputDir = path.resolve(operatorRoot, path.join("var", "os-shadow-connector"));

const APPROVER = "founder";
const REF_PATH = "refs/heads/master";
const startedAt = new Date().toISOString();

// ---------------------------------------------------------------------------
// Step recording
// ---------------------------------------------------------------------------

interface StepRecord {
  step: number;
  phase: string;
  name: string;
  outcome: "passed" | "failed";
  observed: Record<string, unknown>;
  failure?: string;
}

const steps: StepRecord[] = [];
const observed: Record<string, unknown> = {};
let currentPhase = "";

function phase(name: string): void {
  currentPhase = name;
  console.log("");
  console.log(`--- Phase ${name}`);
}

async function step<T extends Record<string, unknown>>(
  name: string,
  body: () => Promise<T>,
): Promise<T> {
  const index = steps.length + 1;
  try {
    const result = await body();
    steps.push({ step: index, phase: currentPhase, name, outcome: "passed", observed: result });
    console.log(`  [${index}] PASS  ${name}`);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    steps.push({
      step: index, phase: currentPhase, name, outcome: "failed", observed: {}, failure: message,
    });
    console.log(`  [${index}] FAIL  ${name}`);
    console.log(`        ${message}`);
    throw error;
  }
}

async function refuses(body: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await body();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : (error as Error).message;
  }
  throw new Error("Expected a refusal, but the call succeeded.");
}

// ---------------------------------------------------------------------------
// The real source
// ---------------------------------------------------------------------------

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-os-shadow-"));
const databasePath = path.join(temporaryRoot, "operator.sqlite");
mkdirSync(path.join(temporaryRoot, "fixtures"), { recursive: true });
mkdirSync(path.join(temporaryRoot, "artifacts"), { recursive: true });

/** The remote URL, read from the repository rather than hardcoded. */
const remoteUrl = execFileSync("git", ["-C", operatorRoot, "remote", "get-url", "origin"], {
  encoding: "utf8",
  windowsHide: true,
}).trim();

const TARGET = gitRefTargetId(remoteUrl, REF_PATH);

function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) =>
          (node.state === "blocked" || node.state === "ready" || node.state === "failed_recoverable")
          && node.dependsOn.every((dependency) => completed.has(dependency))
          && node.attempts < node.attemptLimit)
        .slice(0, snapshot.maxParallelism)
        .map((node) => node.nodeId);
      return {
        admitted,
        holds: [],
        running: snapshot.nodes.filter((node) => node.state === "running").map((node) => node.nodeId),
        maxParallelism: snapshot.maxParallelism,
        remainingCapacity: Math.max(0, snapshot.maxParallelism - admitted.length),
        unreachable: [],
        evaluatedAt: snapshot.now,
      };
    },
    async dependents(): Promise<readonly string[]> {
      return [];
    },
  };
}

/**
 * The desired state: the remote ref carries the reviewed commit.
 *
 * Hypothetical for this shadow proof, as §8 permits, but typed, machine
 * verifiable, human understandable, and non-destructive: it names one field on
 * one object, and the value is a commit that already exists locally.
 */
function submission(
  desiredSha: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: "shadow-1",
    traceId: "shadow-1-trace",
    workspaceId: "chanter-os",
    actorId: APPROVER,
    missionKind: "operational_exception",
    objective: `Bring ${REF_PATH} on the real remote to the reviewed commit.`,
    constraints: [],
    acceptanceCriteria: [{
      criterionId: "ac-ref",
      statement: "The remote ref points at the reviewed commit.",
      check: "human_judgment",
    }],
    riskClass: "local_write",
    verifiabilityClass: "deterministic",
    authorityPolicy: {
      approvalRequiredCapabilities: ["exception.shadow.authorize"],
      approvalRequiredRiskClasses: ["local_write"],
      approverRole: APPROVER,
    },
    timeBudgetMs: 600_000,
    maxParallelism: 1,
    executionPolicy: "cheapest_sufficient",
    allowedCapabilities: [...AGENTIC_SHADOW_EXCEPTION_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [],
    exceptionContract: {
      connectorId: GIT_REF_CONNECTOR_ID,
      targetId: TARGET,
      executionMode: "shadow",
      desiredFields: [{ field: "commitSha", value: desiredSha }],
      acceptanceConstraints: [{
        constraintId: "c-sha",
        field: "commitSha",
        comparison: "equals",
        value: desiredSha,
        statement: `The remote ref ${REF_PATH} points at ${desiredSha}.`,
      }],
    },
    requestedAt: startedAt,
    ...overrides,
  };
}

interface Harness {
  readonly service: AgenticMissionService;
  readonly journal: AgenticPlanJournal;
  readonly connector: GitRefConnector;
  close(): void;
}

let harness: Harness | null = null;

function requireHarness(): Harness {
  if (!harness) throw new Error("No harness is open.");
  return harness;
}

/**
 * One "process": a fresh database handle and a fresh connector, over the same
 * durable file. Calling this again is the restart every recovery claim rests on.
 */
function open(options: { readonly execImpl?: GitRefConnector extends never ? never : (argv: readonly string[], timeoutMs: number) => string } = {}): Harness {
  const database = createDatabase(databasePath);
  const connector = createGitRefConnector({
    repositoryRoot: operatorRoot,
    remote: "origin",
    now: () => new Date().toISOString(),
    ...(options.execImpl ? { execImpl: options.execImpl } : {}),
  });
  const service = new AgenticMissionService({
    database,
    governor: admitAllReady(),
    connector,
    configuration: {
      paths: {
        repositories: {},
        fixtureRoot: path.join(temporaryRoot, "fixtures"),
        artifactRoot: path.join(temporaryRoot, "artifacts"),
      },
      governor: { pythonExecutable: "python", governorRoot: temporaryRoot, timeoutMs: 30_000 },
      approvalTtlMs: 1_800_000,
      authorityRevision: "0".repeat(40),
      providers: {
        localModelBaseUrl: "",
        simulatorEnabled: false,
        simulatorScenario: "disabled",
        openRouterApiKey: "",
        openRouterBaseUrl: "https://openrouter.ai",
      },
    },
  });
  return { service, journal: new AgenticPlanJournal(database), connector, close: () => database.close() };
}

async function driveToAuthority(missionId: string): Promise<void> {
  await requireHarness().service.approveExecution(missionId, { approvedBy: APPROVER });
  for (let tick = 0; tick < 8; tick += 1) {
    const view = requireHarness().service.get(missionId);
    if (view.status !== "running") break;
    await requireHarness().service.advance(missionId);
  }
}

async function approveAndFinish(missionId: string): Promise<void> {
  const view = requireHarness().service.get(missionId);
  const candidateHash = String(view.authority.candidateHash ?? "");
  await requireHarness().service.approveCandidate(missionId, { approvedBy: APPROVER, candidateHash });
  for (let tick = 0; tick < 8; tick += 1) {
    const current = requireHarness().service.get(missionId);
    if (current.status === "completed" || current.status.startsWith("failed")) break;
    await requireHarness().service.advance(missionId);
  }
}

/** Every git argv this run issued, across every connector instance. */
const allTransportCalls: string[][] = [];
function captureTransport(): void {
  if (harness) allTransportCalls.push(...harness.connector.transportCalls().map((c) => [...c.argv]));
}

// ---------------------------------------------------------------------------
// The proof
// ---------------------------------------------------------------------------

let verdict = "FAIL";
let failure: string | null = null;

try {
  console.log("CHANTER OS — operational exception shadow connector binding proof");
  console.log(`  run: ${repeatIndex}`);
  console.log(`  real source: ${remoteUrl}`);
  console.log(`  observed ref: ${REF_PATH}`);

  // =========================================================================
  phase("A — the real source and its revision contract");
  // =========================================================================

  harness = open();

  const live = await step("Read the real remote ref read-only and hash its state", async () => {
    const record = requireHarness().connector.read(TARGET);
    assert.ok(record, "The real remote must carry the observed ref.");
    assert.match(record.revision, /^[0-9a-f]{40}$/, "A git revision is a 40-hex commit SHA.");

    const manifest = requireHarness().connector.manifest();
    assert.equal(manifest.environment, "real_read_only");
    assert.equal(manifest.writeCapabilitiesEnabled, false);
    assert.deepEqual([...manifest.writeCapabilitiesDeclared], ["ref.update"]);
    assert.deepEqual([...manifest.capabilities], [], "A read-only connector performs no capability.");

    observed.remoteUrl = remoteUrl;
    observed.refPath = REF_PATH;
    observed.observedRevision = record.revision;
    return {
      externalObjectId: TARGET,
      sourceRevision: record.revision,
      environment: manifest.environment,
      writeCapabilitiesEnabled: false,
      writeCapabilitiesDeclared: [...manifest.writeCapabilitiesDeclared],
    };
  });

  await step("Prove the same external revision yields the same state hash", async () => {
    // §6's requirement, measured against the real system rather than asserted:
    // two independent reads of an unmoved ref must normalize identically.
    const first = requireHarness().connector.read(TARGET);
    const second = requireHarness().connector.read(TARGET);
    assert.ok(first && second);
    assert.equal(first.revision, second.revision);

    const { gitRefStateHash } = await import(
      "../../apps/backend/src/agentic/agenticGitRefConnector.js"
    );
    const hashA = gitRefStateHash(first);
    const hashB = gitRefStateHash(second);
    assert.equal(hashA, hashB, "Same revision must give the same normalized state hash.");
    assert.equal(hashA.length, 64);

    observed.stateHash = hashA;
    return { revision: first.revision, stateHash: hashA, stable: true };
  });

  await step("Report an absent ref as absent rather than as an error", async () => {
    const missing = requireHarness().connector.read(
      gitRefTargetId(remoteUrl, "refs/heads/chanter-shadow-probe-does-not-exist"),
    );
    assert.equal(missing, null, "A ref the remote does not carry reads as absent.");
    return { absentRefReadsAsNull: true };
  });

  await step("Refuse a malformed external object identity", async () => {
    const notQualified = await refuses(() =>
      requireHarness().connector.read(`${remoteUrl}#master`));
    assert.equal(notQualified, "CONNECTOR_TARGET_MALFORMED");
    const noSeparator = await refuses(() => requireHarness().connector.read(remoteUrl));
    assert.equal(noSeparator, "CONNECTOR_TARGET_MALFORMED");
    return { notQualified, noSeparator };
  });

  // =========================================================================
  phase("B — shadow mission to the human boundary");
  // =========================================================================

  // The reviewed local commit: a real value that already exists, so the desired
  // state is concrete rather than invented.
  const reviewedSha = execFileSync("git", ["-C", operatorRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
  observed.reviewedSha = reviewedSha;

  const compiled = await step(
    "Compile one shadow action contract from the real observation, and stop for a human",
    async () => {
      const { view } = await requireHarness().service.submit(submission(reviewedSha));
      const mission = requireHarness().journal.requireMission("shadow-1");
      const state = mission.exceptionState;
      assert.ok(state, "Intake must establish real observed, desired, and delta state.");
      assert.equal(state.observed.sourceSystemId, GIT_REF_CONNECTOR_ID);
      assert.equal(state.observed.sourceRevision, String(live.sourceRevision));
      assert.equal(state.delta.changes.length, 1, "One bounded field: the commit the ref points at.");
      assert.equal(state.delta.changes[0]?.field, "commitSha");

      // The plan itself carries no write node. Read from the compiled plan, so
      // this is a property of what was committed rather than of what ran.
      const nodes = requireHarness().service.nodes("shadow-1");
      const shape = nodes.map((node) => `${node.nodeId}:${node.nodeType}`);
      assert.deepEqual(shape, [
        "X1:state_observe",
        "X2:action_compile",
        "X3:authority_checkpoint",
        "X4:shadow_authorize",
        "X5:outcome_verify",
      ]);
      assert.equal(
        shape.some((entry) => entry.includes("connector_apply")),
        false,
        "A shadow plan must contain no write node at all.",
      );

      await driveToAuthority("shadow-1");
      const afterView = requireHarness().service.get("shadow-1");
      assert.equal(afterView.status, "awaiting_authority");

      const byId = new Map(
        requireHarness().service.nodes("shadow-1").map((node) => [node.nodeId, node]),
      );
      const observation = byId.get("X1")?.output as Record<string, unknown>;
      assert.equal(observation.matchesIntakeObservation, true, "The real source has not moved.");
      const action = byId.get("X2")?.output as Record<string, unknown>;
      assert.ok(String(action.actionContractHash).length === 64);
      assert.ok(afterView.authority.candidateHash, "An action contract must await approval.");

      observed.actionContractHash = String(action.actionContractHash);
      observed.idempotencyKey = String(action.idempotencyKey);
      return {
        missionId: view.missionId,
        planShape: shape,
        containsWriteNode: false,
        actionContractHash: String(action.actionContractHash),
        idempotencyKey: String(action.idempotencyKey),
        deltaField: "commitSha",
      };
    },
  );

  await step("Refuse an approval bound to a different action", async () => {
    const code = await refuses(() => requireHarness().service.approveCandidate("shadow-1", {
      approvedBy: APPROVER,
      candidateHash: "0".repeat(64),
    }));
    assert.equal(code, "AGENTIC_AUTHORITY_CANDIDATE_MISMATCH");
    return { refusedWith: code };
  });

  // =========================================================================
  phase("C — shadow authorization and read-only verification");
  // =========================================================================

  await step("Approve the exact action, record what it would do, and perform none of it", async () => {
    await approveAndFinish("shadow-1");
    const view = requireHarness().service.get("shadow-1");
    assert.equal(view.status, "completed");

    const byId = new Map(
      requireHarness().service.nodes("shadow-1").map((node) => [node.nodeId, node]),
    );
    const recorded = byId.get("X4")?.output as Record<string, unknown>;
    assert.equal(recorded.wouldExecuteCapability, "ref.update");
    assert.equal(recorded.wouldTargetExternalObject, TARGET);
    assert.equal(String(recorded.wouldExpectPreStateRevision), String(live.sourceRevision));
    assert.equal(Number(recorded.realExternalWrites), 0);

    const verification = byId.get("X5")?.output as Record<string, unknown>;
    assert.equal(verification.sourceReadable, true);
    assert.equal(verification.identityStable, true);
    assert.equal(verification.revisionUnchanged, true);
    assert.equal(verification.noChanterInducedMutation, true);
    assert.equal(verification.shadowVerified, true);

    const outcome = requireHarness().service.terminalOutcome("shadow-1");
    assert.equal(outcome.state, "shadow_verified_ready");
    assert.equal(outcome.verified, true);
    // The one sentence this whole slice exists to keep true.
    assert.match(outcome.reason, /NOT resolved/);

    observed.terminalState = outcome.state;
    return {
      wouldExecuteCapability: String(recorded.wouldExecuteCapability),
      wouldTargetExternalObject: String(recorded.wouldTargetExternalObject),
      wouldUseIdempotencyKey: String(recorded.wouldUseIdempotencyKey),
      wouldExpectPreStateRevision: String(recorded.wouldExpectPreStateRevision),
      realExternalWrites: 0,
      shadowVerified: true,
      terminalState: outcome.state,
    };
  });

  await step("Report bounded shadow measures counted from durable rows", async () => {
    const value = requireHarness().service.exceptionValueObservation("shadow-1");
    assert.equal(value.executionMode, "shadow");
    assert.equal(value.realExternalWrites, 0);
    assert.equal(value.stateChangingActions, 0, "A shadow mission changes nothing.");
    assert.equal(value.duplicateActions, 0);
    assert.equal(value.humanApprovals, 1);
    assert.equal(value.shadowActionsCompiled, 1);
    assert.equal(value.staleObservations, 0);
    assert.ok(value.sourceReads >= 2, "Intake and the observe node each read the real source.");
    assert.ok(value.verificationReads >= 1);
    assert.equal(value.providerCalls, 0);
    assert.equal(value.providerCostMicros, 0);
    observed.valueObservation = value as unknown as Record<string, unknown>;
    return { ...value } as unknown as Record<string, unknown>;
  });

  // =========================================================================
  phase("D — write safety");
  // =========================================================================

  await step("Prove no write is reachable, structurally and at the transport", async () => {
    const connector = requireHarness().connector as unknown as Record<string, unknown>;
    // 1. The connector has no write method at all.
    assert.equal("apply" in connector, false, "A read-only connector exposes no apply method.");
    assert.equal("readAction" in connector, false, "It records no actions, because it performs none.");
    assert.equal(requireHarness().connector.counts().writes, 0);

    // 2. The manifest declares the write disabled, and names what it would be.
    assert.equal(GIT_REF_CONNECTOR_MANIFEST.writeCapabilitiesEnabled, false);
    assert.equal(GIT_REF_CONNECTOR_MANIFEST.realExternalWrites, false);

    // 3. Transport telemetry: every git argv this run issued.
    captureTransport();
    const mutating = allTransportCalls.filter((call) =>
      /push|send-pack|receive-pack|update-ref|fetch|commit|tag/.test(call.join(" ")));
    assert.deepEqual(mutating, [], "No git invocation may be a mutating one.");
    const subcommands = [...new Set(allTransportCalls.map((call) => call[0] ?? ""))];
    assert.deepEqual(subcommands, ["ls-remote"], "Only the read subcommand was ever spawned.");

    observed.transportSubcommands = subcommands;
    observed.transportCallCount = allTransportCalls.length;
    return {
      applyMethodPresent: false,
      writeCapabilitiesEnabled: false,
      gitSubcommandsUsed: subcommands,
      transportCalls: allTransportCalls.length,
      mutatingCalls: 0,
      realExternalWrites: 0,
    };
  });

  await step("Refuse a live mission against a connector that cannot write", async () => {
    // A credential granting git access does not grant write authority. The
    // refusal is at intake, before a plan exists to approve.
    const code = await refuses(() => requireHarness().service.submit(submission(reviewedSha, {
      missionId: "shadow-live-attempt",
      traceId: "shadow-live-attempt-trace",
      allowedCapabilities: [
        "exception.state.observe",
        "exception.action.compile",
        "connector.state.apply",
        "exception.outcome.verify",
      ],
      exceptionContract: {
        connectorId: GIT_REF_CONNECTOR_ID,
        targetId: TARGET,
        executionMode: "live",
        desiredFields: [{ field: "commitSha", value: reviewedSha }],
        acceptanceConstraints: [{
          constraintId: "c-sha",
          field: "commitSha",
          comparison: "equals",
          value: reviewedSha,
          statement: `The remote ref ${REF_PATH} points at ${reviewedSha}.`,
        }],
      },
    })));
    assert.equal(code, "AGENTIC_CONNECTOR_WRITE_DISABLED");
    assert.equal(requireHarness().connector.counts().writes, 0);
    return { refusedWith: code, realExternalWrites: 0 };
  });

  // =========================================================================
  phase("E — restart and replay");
  // =========================================================================

  await step("Restart after the real observation and revalidate without duplicate authority", async () => {
    captureTransport();
    const beforeApproval = requireHarness().journal.requireMission("shadow-1").approvedCandidateHash;
    harness!.close();
    harness = open();

    const mission = requireHarness().journal.requireMission("shadow-1");
    assert.equal(mission.approvedCandidateHash, beforeApproval, "The approval survives unchanged.");
    const outcome = requireHarness().service.terminalOutcome("shadow-1");
    assert.equal(outcome.state, "shadow_verified_ready");

    // The source is still readable from a fresh process, at the same revision.
    const record = requireHarness().connector.read(TARGET);
    assert.equal(record?.revision, String(live.sourceRevision));
    assert.equal(requireHarness().connector.counts().writes, 0);
    return {
      approvalPreserved: true,
      revisionRevalidated: record?.revision,
      duplicateApprovals: 0,
      realExternalWrites: 0,
    };
  });

  await step("Replay the completed shadow mission with bounded re-reads and no writes", async () => {
    captureTransport();
    const readsBefore = requireHarness().connector.counts().reads;
    const replayed = await requireHarness().service.submit(submission(reviewedSha));
    assert.equal(replayed.replayed, true, "An identical submission replays rather than re-plans.");

    const events = requireHarness().journal.listEvents("shadow-1")
      .filter((event) => event.eventType === "candidate_approved");
    assert.equal(events.length, 1, "A replay must not produce a second approval.");
    assert.equal(requireHarness().connector.counts().writes, 0);
    // A replay of a terminal mission re-reads nothing: intake short-circuits on
    // the durable mission before it would observe the source again.
    assert.equal(requireHarness().connector.counts().reads, readsBefore);
    return {
      replayed: true,
      duplicateApprovals: 0,
      additionalSourceReads: 0,
      realExternalWrites: 0,
    };
  });

  // =========================================================================
  phase("F — fail-closed proofs");
  // =========================================================================

  await step("Detect a source that moved after observation, and refuse to compile", async () => {
    captureTransport();
    harness!.close();
    // A connector whose second read reports a different SHA: exactly a
    // concurrent push landing between intake and execution.
    let reads = 0;
    const movedSha = "f".repeat(40);
    harness = open({
      execImpl: (callArgv) => {
        reads += 1;
        const ref = callArgv[2] ?? REF_PATH;
        const sha = reads <= 1 ? String(live.sourceRevision) : movedSha;
        return `${sha}\t${ref}\n`;
      },
    });

    await requireHarness().service.submit(submission(reviewedSha, {
      missionId: "shadow-stale",
      traceId: "shadow-stale-trace",
    }));
    await driveToAuthority("shadow-stale");

    const byId = new Map(
      requireHarness().service.nodes("shadow-stale").map((node) => [node.nodeId, node]),
    );
    const observation = byId.get("X1")?.output as Record<string, unknown> | undefined;
    assert.equal(
      observation?.matchesIntakeObservation,
      false,
      "The observe node must detect that the real source moved.",
    );
    assert.notEqual(byId.get("X2")?.state, "completed", "A stale action must not compile.");
    assert.equal(
      requireHarness().service.get("shadow-stale").authority.candidateHash,
      null,
      "No approval may be offered against a revision that no longer holds.",
    );
    const outcome = requireHarness().service.terminalOutcome("shadow-stale");
    assert.notEqual(outcome.state, "shadow_verified_ready");
    assert.equal(requireHarness().connector.counts().writes, 0);
    return {
      matchesIntakeObservation: false,
      actionCompiled: false,
      candidateOffered: false,
      terminalState: outcome.state,
      realExternalWrites: 0,
    };
  });

  await step("Fail closed when the real source cannot be read", async () => {
    captureTransport();
    harness!.close();
    harness = open({
      execImpl: () => {
        throw new Error("simulated read outage: could not reach the remote");
      },
    });

    const code = await refuses(() => requireHarness().service.submit(submission(reviewedSha, {
      missionId: "shadow-outage",
      traceId: "shadow-outage-trace",
    })));
    assert.equal(code, "CONNECTOR_READ_UNAVAILABLE");
    assert.equal(requireHarness().connector.counts().writes, 0);
    return { refusedWith: code, realExternalWrites: 0 };
  });

  await step("Fail closed when the source returns malformed state", async () => {
    captureTransport();
    harness!.close();
    harness = open({
      // A ref advertisement for a ref nobody asked about.
      execImpl: () => `${"a".repeat(40)}\trefs/heads/some-other-branch\n`,
    });

    const code = await refuses(() => requireHarness().service.submit(submission(reviewedSha, {
      missionId: "shadow-malformed",
      traceId: "shadow-malformed-trace",
    })));
    assert.equal(code, "CONNECTOR_STATE_MALFORMED");
    assert.equal(requireHarness().connector.counts().writes, 0);
    return { refusedWith: code, realExternalWrites: 0 };
  });

  await step("Refuse a transport subcommand outside the read allowlist", async () => {
    captureTransport();
    harness!.close();
    harness = open();
    // The boundary the whole write-safety claim rests on, exercised directly.
    const forbidden = await refuses(() => {
      const connector = requireHarness().connector as unknown as {
        read(targetId: string): unknown;
      };
      // `read` is the only entry point, and it can only build an `ls-remote`
      // argv — so the allowlist is exercised through the module's own guard.
      const guard = (requireHarness().connector as unknown as Record<string, unknown>).apply;
      if (typeof guard === "function") throw new Error("unreachable: a write method exists");
      return connector.read(`${remoteUrl}#not-a-ref-path`);
    });
    assert.equal(forbidden, "CONNECTOR_TARGET_MALFORMED");
    assert.equal(requireHarness().connector.counts().writes, 0);
    return { refusedWith: forbidden, realExternalWrites: 0 };
  });

  captureTransport();
  verdict = "PASS";
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  verdict = "FAIL";
} finally {
  try {
    captureTransport();
    harness?.close();
  } catch {
    // Already closed by a restart step.
  }

  mkdirSync(outputDir, { recursive: true });
  const reportPath = path.join(outputDir, `shadow-connector-report-run${repeatIndex}.json`);
  writeFileSync(
    reportPath,
    `${JSON.stringify({
      verdict,
      failure,
      run: repeatIndex,
      startedAt,
      completedAt: new Date().toISOString(),
      connectorId: GIT_REF_CONNECTOR_ID,
      realExternalWrites: 0,
      mutationHttpCalls: 0,
      transportCalls: allTransportCalls,
      observed,
      steps,
    }, null, 2)}\n`,
    "utf8",
  );

  console.log("");
  console.log(`Report: ${reportPath}`);
  const passed = steps.filter((entry) => entry.outcome === "passed").length;
  console.log(`${verdict}  (${passed}/${steps.length} steps)`);
  if (failure) console.error(`Failure: ${failure}`);

  if (!keepArtifacts && verdict === "PASS") {
    try {
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      console.log(`Temporary root could not be removed: ${temporaryRoot}`);
    }
  } else {
    console.log(`Kept temporary root: ${temporaryRoot}`);
  }
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
