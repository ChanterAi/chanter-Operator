/**
 * Provider-owned billing reconciliation — regression tests.
 *
 * Closes the seam that failed the first live billed acceptance run at step 29.
 *
 * Two real charges were incurred, recorded, and hashed correctly. Both were then
 * reported `unavailable` — not because anything went wrong with the money, but
 * because the inline lookup fired **three milliseconds** after the charge became
 * durable, and OpenRouter writes its generation record *after* the completion
 * returns. Both lookups got `HTTP 404` for generations that had genuinely been
 * billed, the adapter treated a single 404 as terminal, and nothing in the
 * fabric could ever ask again: a mission replay is refused at
 * `AGENTIC_PROVIDER_ALREADY_INVOKED` long before reconciliation is reachable.
 *
 * So the fix is two-sided, and both sides are pinned here:
 *
 *   - a *later* reconciliation, driven from durable state alone, and
 *   - a hard guarantee that running it cannot cost money.
 *
 * The second is the one that matters most. `reconcileBilling` reaches exactly
 * one provider method — `reconcile` — so no restart, retry, or repeated call can
 * produce a second inference request or a second charge. Every test below
 * measures that directly rather than assuming it.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
  AgenticProviderAdapter,
  AgenticProviderReconciliation,
} from "chanter-agent-runtime";
import { createDatabase } from "../src/db/database.js";
import { AgenticMissionService } from "../src/agentic/agenticMissionService.js";
import { AgenticPlanJournal } from "../src/agentic/agenticPlanJournal.js";
import { AGENTIC_ARTIFACT_MISSION_CAPABILITIES } from "../src/agentic/agenticCapabilityRegistry.js";
import { SIMULATOR_PRIMARY_BINDING_ID } from "../src/agentic/agenticProviderRegistry.js";
import { createAgenticProviderAdapters } from "../src/agentic/agenticProviderAdapters.js";
import { SIMULATED_ADAPTER_ID } from "chanter-agent-runtime";
import type {
  AgenticGovernanceDecision,
  AgenticGovernanceSnapshot,
  AgenticPlanGovernorPort,
} from "../src/agentic/agenticPlanGovernorPort.js";

const APPROVER = "founder";
let root: string;
let database: ReturnType<typeof createDatabase>;

function admitAllReady(): AgenticPlanGovernorPort {
  return {
    configured: true,
    async govern(snapshot: AgenticGovernanceSnapshot): Promise<AgenticGovernanceDecision> {
      const completed = new Set(
        snapshot.nodes.filter((node) => node.state === "completed").map((node) => node.nodeId),
      );
      const admitted = snapshot.nodes
        .filter((node) =>
          (node.state === "blocked" || node.state === "ready")
          && node.dependsOn.every((dependency) => completed.has(dependency))
          && node.attempts < node.attemptLimit)
        .slice(0, snapshot.maxParallelism)
        .map((node) => node.nodeId);
      return {
        admitted,
        held: [],
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

function submission(missionId: string): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId,
    traceId: `${missionId}-trace`,
    workspaceId: "chanter-os",
    actorId: APPROVER,
    objective: "Prove a recorded charge can be confirmed against the provider's own record.",
    constraints: [],
    acceptanceCriteria: [{
      criterionId: "ac-evidence-section",
      statement: "The artifact states its evidence index.",
      check: "artifact_section_present",
      parameter: "Evidence Index",
    }],
    riskClass: "local_write",
    verifiabilityClass: "evidence_verifiable",
    authorityPolicy: {
      approvalRequiredCapabilities: ["artifact.local.write"],
      approvalRequiredRiskClasses: ["local_write"],
      approverRole: APPROVER,
    },
    timeBudgetMs: 1_800_000,
    maxParallelism: 2,
    executionPolicy: "model_required_for_judgment",
    providerBindings: [
      { capabilityId: "architecture.analyze", bindingId: SIMULATOR_PRIMARY_BINDING_ID },
      { capabilityId: "risk.analyze", bindingId: SIMULATOR_PRIMARY_BINDING_ID },
    ],
    allowedCapabilities: [...AGENTIC_ARTIFACT_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [{
      requirementId: "ctx-architecture",
      sourceType: "static_fixture",
      sourceIdentity: "architecture-contract.json",
      scope: "architecture_contract",
      freshnessPolicy: "any",
      trustClass: "declared",
    }, {
      requirementId: "ctx-risk",
      sourceType: "static_fixture",
      sourceIdentity: "risk-register.json",
      scope: "risk_register",
      freshnessPolicy: "any",
      trustClass: "declared",
    }],
    outputContract: {
      format: "markdown",
      artifactName: "BILLING.md",
      requiredSections: ["Executive Summary", "Evidence Index"],
    },
    requestedAt: "2026-08-07T10:00:00.000Z",
  };
}

const PROVIDER_CONFIGURATION = {
  localModelBaseUrl: "",
  simulatorEnabled: true,
  simulatorScenario: "succeed" as const,
  openRouterApiKey: "",
  openRouterBaseUrl: "https://openrouter.ai",
};

interface Counters {
  /** Every inference dispatch. This is the number that must never move. */
  inferenceCalls: number;
  /** Every billing-record lookup. Bounded polling is measured from this. */
  billingLookups: number;
}

/**
 * The real simulator transport, wrapped so both call classes are counted, and
 * given the billing-record endpoint the simulator does not have.
 *
 * Wrapping rather than re-implementing matters: the mission really executes
 * through the same adapter the fabric ships, so the charges being reconciled are
 * charges the fabric actually recorded, not fixtures written by the test.
 */
function countedAdapters(
  counters: Counters,
  reconcile?: (attempt: number) => AgenticProviderReconciliation | null,
): { adapters: ReadonlyMap<string, AgenticProviderAdapter> } {
  const real = createAgenticProviderAdapters(PROVIDER_CONFIGURATION);
  const simulated = real.get(SIMULATED_ADAPTER_ID);
  if (!simulated) throw new Error("the simulated adapter must be registered for this test");

  const wrapped: AgenticProviderAdapter = {
    adapterId: simulated.adapterId,
    async invoke(dispatch) {
      counters.inferenceCalls += 1;
      return simulated.invoke(dispatch);
    },
    ...(reconcile
      ? {
        async reconcile(request) {
          let attempts = 0;
          for (let attempt = 0; attempt < request.maxAttempts; attempt += 1) {
            attempts += 1;
            counters.billingLookups += 1;
            const found = reconcile(attempts);
            if (found) return { ...found, attempts };
            await request.wait(request.retryDelayMs);
          }
          return {
            evidenceType: "provider_generation_lookup",
            verdict: "unavailable",
            attempts,
            externalAmountMicros: null,
            deltaMicros: null,
            upstreamProvider: null,
            upstreamRequestId: null,
            upstreamInferenceCostMicros: null,
            detail: `No provider record after ${attempts} lookup(s).`,
            checkedAt: new Date().toISOString(),
          };
        },
      }
      : {}),
  };
  return { adapters: new Map([[SIMULATED_ADAPTER_ID, wrapped]]) };
}

function serviceWith(adapters: ReadonlyMap<string, AgenticProviderAdapter>): AgenticMissionService {
  return new AgenticMissionService({
    database,
    governor: admitAllReady(),
    providerAdapters: adapters,
    billingReconciliationWait: async () => {},
    configuration: {
      paths: {
        repositories: {},
        fixtureRoot: path.join(root, "fixtures"),
        artifactRoot: path.join(root, "artifacts"),
      },
      governor: { pythonExecutable: "python", governorRoot: root, timeoutMs: 30_000 },
      approvalTtlMs: 1_800_000,
      authorityRevision: "0".repeat(40),
      providers: PROVIDER_CONFIGURATION,
    },
  });
}

/** Runs one mission to completion and returns its recorded charges. */
async function chargedMission(
  service: AgenticMissionService,
  missionId: string,
): Promise<{ readonly costMicros: number; readonly chargeCount: number }> {
  await service.submit(submission(missionId));
  await service.approveExecution(missionId, { approvedBy: APPROVER });

  // Drive to a terminal state so the durable value observation — the record
  // whose billing verdict this seam has to keep true — actually exists. The
  // candidate appears partway through, so approval is granted when it does
  // rather than assumed to be available immediately after execution approval.
  for (let step = 0; step < 12; step += 1) {
    const view = service.get(missionId);
    if (view.status === "completed" || view.status.startsWith("failed")) break;
    const { candidateHash, approvedCandidateHash } = view.authority;
    if (candidateHash && candidateHash !== approvedCandidateHash) {
      await service.approveCandidate(missionId, { approvedBy: APPROVER, candidateHash });
      continue;
    }
    await service.advance(missionId);
  }
  const usage = new AgenticPlanJournal(database).listProviderUsage(missionId);
  const charges = usage.filter((row) => row.monetaryCostMicros !== null);
  return {
    costMicros: charges.reduce((total, row) => total + Number(row.monetaryCostMicros), 0),
    chargeCount: charges.length,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "chanter-billing-"));
  mkdirSync(path.join(root, "fixtures"), { recursive: true });
  mkdirSync(path.join(root, "artifacts"), { recursive: true });
  writeFileSync(
    path.join(root, "fixtures", "architecture-contract.json"),
    JSON.stringify({ claims: [{ claimId: "a1", statement: "Operator owns plan authority.", confidence: "high" }] }),
    "utf8",
  );
  writeFileSync(
    path.join(root, "fixtures", "risk-register.json"),
    JSON.stringify({ claims: [{ claimId: "r1", statement: "Unknown outcomes require reconciliation.", confidence: "high" }] }),
    "utf8",
  );
  database = createDatabase(path.join(root, "operator.sqlite"));
});

afterEach(() => {
  database.close();
  rmSync(root, { recursive: true, force: true });
});

describe("reconciling recorded charges against provider-owned records", () => {
  it("confirms charges the inline attempt could not, and issues no inference call doing it", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    // The provider's record does not exist while the mission runs, so every
    // inline lookup legitimately finds nothing — the exact live failure. It
    // appears afterwards, which is when a *later* reconciliation can see it.
    let recordWritten = false;
    const service = serviceWith(countedAdapters(counters, (attempt) =>
      recordWritten
        ? {
          evidenceType: "provider_generation_lookup",
          verdict: "matched",
          attempts: attempt,
          externalAmountMicros: null,
          deltaMicros: 0,
          upstreamProvider: "sim-upstream",
          upstreamRequestId: "upstream-1",
          upstreamInferenceCostMicros: null,
          detail: null,
          checkedAt: new Date().toISOString(),
        }
        : null).adapters);

    const charged = await chargedMission(service, "billing-1");
    expect(charged.chargeCount).toBeGreaterThan(0);
    const inferenceCallsAfterMission = counters.inferenceCalls;
    counters.billingLookups = 0;

    // Every charge is durable and none of them is confirmed: the state the live
    // run ended in, and the state that used to be permanent.
    const journal = new AgenticPlanJournal(database);
    const unconfirmed = journal.listProviderUsage("billing-1")
      .filter((row) => row.monetaryCostMicros !== null);
    expect(unconfirmed).toHaveLength(charged.chargeCount);
    expect(unconfirmed.every((row) => row.reconciliation.verdict === "unavailable")).toBe(true);
    expect(unconfirmed.every((row) => (row.providerRequestId ?? "").length > 0)).toBe(true);

    recordWritten = true;
    const summary = await service.reconcileBilling("billing-1");

    expect(summary.verdict).toBe("matched");
    expect(summary.chargesConsidered).toBe(charged.chargeCount);
    expect(summary.chargesConfirmed).toBe(charged.chargeCount);
    expect(summary.chargesUnconfirmed).toBe(0);
    expect(summary.inferenceCallsIssued).toBe(0);
    // One lookup per charge, now that the record is there to be found.
    expect(summary.lookupAttempts).toBe(charged.chargeCount);
    expect(counters.billingLookups).toBe(summary.lookupAttempts);
    // The property the whole seam exists to guarantee.
    expect(counters.inferenceCalls).toBe(inferenceCallsAfterMission);
  });

  it("preserves every piece of existing charge evidence", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    const service = serviceWith(countedAdapters(counters, () => ({
      evidenceType: "provider_generation_lookup",
      verdict: "matched",
      attempts: 1,
      externalAmountMicros: null,
      deltaMicros: 0,
      upstreamProvider: null,
      upstreamRequestId: null,
      upstreamInferenceCostMicros: null,
      detail: null,
      checkedAt: new Date().toISOString(),
    })).adapters);

    await chargedMission(service, "billing-2");
    const journal = new AgenticPlanJournal(database);
    const before = journal.listProviderUsage("billing-2");

    await service.reconcileBilling("billing-2");
    const after = journal.listProviderUsage("billing-2");

    expect(after).toHaveLength(before.length);
    for (const [index, row] of after.entries()) {
      const original = before[index]!;
      // Everything the charge attested stays byte-identical. Reconciliation adds
      // evidence; it must never restate the thing it is evidence for.
      expect(row.providerCallKey).toBe(original.providerCallKey);
      expect(row.monetaryCostMicros).toBe(original.monetaryCostMicros);
      expect(row.monetaryCostSource).toBe(original.monetaryCostSource);
      expect(row.providerRequestId).toBe(original.providerRequestId);
      expect(row.providerName).toBe(original.providerName);
      expect(row.modelId).toBe(original.modelId);
      expect(row.inputTokens).toBe(original.inputTokens);
      expect(row.outputTokens).toBe(original.outputTokens);
      expect(row.totalTokens).toBe(original.totalTokens);
      expect(row.finishReason).toBe(original.finishReason);
      expect(row.requestHash).toBe(original.requestHash);
      expect(row.rawResponseHash).toBe(original.rawResponseHash);
      expect(row.responseHash).toBe(original.responseHash);
      expect(row.typedError).toEqual(original.typedError);
      expect(row.recordedAt).toBe(original.recordedAt);
    }
  });

  it("survives a restart and still buys nothing", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    const adapters = countedAdapters(counters, () => ({
      evidenceType: "provider_generation_lookup",
      verdict: "matched",
      attempts: 1,
      externalAmountMicros: null,
      deltaMicros: 0,
      upstreamProvider: null,
      upstreamRequestId: null,
      upstreamInferenceCostMicros: null,
      detail: null,
      checkedAt: new Date().toISOString(),
    })).adapters;

    const first = serviceWith(adapters);
    const charged = await chargedMission(first, "billing-3");
    const inferenceCallsAfterMission = counters.inferenceCalls;
    await first.reconcileBilling("billing-3");
    const lookupsAfterFirstPass = counters.billingLookups;

    // A different service instance over the same durable database is what a
    // restarted process actually is.
    const restarted = serviceWith(adapters);
    const summary = await restarted.reconcileBilling("billing-3");

    expect(summary.verdict).toBe("matched");
    // Nothing is asked twice once it has been answered.
    expect(summary.lookupAttempts).toBe(0);
    expect(summary.outcomes.every((outcome) => outcome.alreadySettled)).toBe(true);
    expect(counters.billingLookups).toBe(lookupsAfterFirstPass);
    expect(counters.inferenceCalls).toBe(inferenceCallsAfterMission);

    const after = new AgenticPlanJournal(database).listProviderUsage("billing-3");
    const total = after
      .filter((row) => row.monetaryCostMicros !== null)
      .reduce((sum, row) => sum + Number(row.monetaryCostMicros), 0);
    // A restart must not change what was spent.
    expect(total).toBe(charged.costMicros);
  });

  it("fails closed when the provider record cannot be confirmed", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    // The record never materializes, no matter how many times it is asked for.
    const service = serviceWith(countedAdapters(counters, () => null).adapters);

    await chargedMission(service, "billing-4");
    const inferenceCallsAfterMission = counters.inferenceCalls;

    const summary = await service.reconcileBilling("billing-4");

    expect(summary.verdict).toBe("unavailable");
    expect(summary.chargesConfirmed).toBe(0);
    expect(summary.chargesUnconfirmed).toBe(summary.chargesConsidered);
    expect(counters.inferenceCalls).toBe(inferenceCallsAfterMission);
    // Unconfirmed is not unrecorded: the money stands exactly as measured.
    const charges = new AgenticPlanJournal(database)
      .listProviderUsage("billing-4")
      .filter((row) => row.monetaryCostMicros !== null);
    expect(charges.length).toBeGreaterThan(0);
    expect(charges.every((row) => Number(row.monetaryCostMicros) > 0)).toBe(true);
  });

  it("reports unconfirmable rather than matched when the adapter cannot reconcile at all", async () => {
    // The shipped simulator exposes no billing endpoint. A binding that cannot
    // be reconciled is not thereby confirmed.
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    const service = serviceWith(countedAdapters(counters).adapters);

    await chargedMission(service, "billing-5");
    const summary = await service.reconcileBilling("billing-5");

    expect(summary.verdict).toBe("unavailable");
    expect(summary.lookupAttempts).toBe(0);
    expect(String(summary.outcomes[0]?.reconciliation.detail))
      .toMatch(/exposes no billing reconciliation endpoint/);
  });

  it("refreshes the mission's durable billing verdict once, and journals why", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    let recordWritten = false;
    const service = serviceWith(countedAdapters(counters, () => recordWritten
      ? {
        evidenceType: "provider_generation_lookup",
        verdict: "matched",
        attempts: 1,
        externalAmountMicros: null,
        deltaMicros: 0,
        upstreamProvider: null,
        upstreamRequestId: null,
        upstreamInferenceCostMicros: null,
        detail: null,
        checkedAt: new Date().toISOString(),
      }
      : null).adapters);

    await chargedMission(service, "billing-6");
    const journal = new AgenticPlanJournal(database);

    // The mission finished before its charges could be confirmed, so its durable
    // observation records exactly that. Left alone, it would say so forever.
    const atCompletion = journal.requireMission("billing-6").valueObservation;
    expect(atCompletion?.billingReconciliationVerdict).toBe("unavailable");

    recordWritten = true;
    await service.reconcileBilling("billing-6");
    const mission = journal.requireMission("billing-6");
    const confirmed = mission.valueObservation;
    expect(confirmed?.billingReconciliationVerdict).toBe("matched");
    // A completed mission is not re-opened, and nothing else it measured moves.
    expect(mission.status).toBe("completed");
    expect(confirmed?.totalTokenCount).toBe(atCompletion?.totalTokenCount);
    expect(confirmed?.providerCallCount).toBe(atCompletion?.providerCallCount);
    expect(confirmed?.objectiveSatisfied).toBe(atCompletion?.objectiveSatisfied);

    // The refresh is auditable, and a second pass that changes nothing writes
    // nothing — an unchanging fact must not accumulate events.
    const eventsAfterFirst = journal.listEvents("billing-6")
      .filter((event) => event.eventType === "mission_billing_reconciled");
    expect(eventsAfterFirst).toHaveLength(1);
    expect(eventsAfterFirst[0]?.evidenceReferences.length).toBeGreaterThan(0);

    await service.reconcileBilling("billing-6");
    expect(
      journal.listEvents("billing-6")
        .filter((event) => event.eventType === "mission_billing_reconciled"),
    ).toHaveLength(1);
  });

  it("refuses to reconcile a mission that does not exist", async () => {
    const counters: Counters = { inferenceCalls: 0, billingLookups: 0 };
    const service = serviceWith(countedAdapters(counters).adapters);
    await expect(service.reconcileBilling("no-such-mission")).rejects.toThrow();
    expect(counters.inferenceCalls).toBe(0);
    expect(counters.billingLookups).toBe(0);
  });
});
