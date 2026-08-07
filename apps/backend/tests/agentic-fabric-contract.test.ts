/**
 * Governed agentic execution fabric — canonical contract tests.
 *
 * These cover the pure layers only: the intent compiler, the capability
 * registry, the router, the plan compiler, and the candidate renderer. The live
 * behaviour — real Operator process, real Governor admission, real concurrency,
 * real approvals, real artifact write, node recovery, restart replay — is proven
 * end to end by `npm run os:agentic-fabric`, so nothing here re-simulates it.
 *
 * The value of this file is drift detection: it fails the moment compilation
 * stops being deterministic, a capability gains an unregistered tool, routing
 * starts spending inference on deterministic work, or authority starts coming
 * from anywhere other than a reviewed capability contract.
 */
import { describe, expect, it } from "vitest";

import { OperatorError } from "../src/services/operatorService.js";
import {
  compileAgenticIntent,
  assertAgenticIntentUnchanged,
} from "../src/agentic/agenticIntentCompiler.js";
import {
  AGENTIC_ARTIFACT_MISSION_CAPABILITIES,
  AGENTIC_EXCEPTION_MISSION_CAPABILITIES,
  AGENTIC_TOOLS,
  listAgenticCapabilities,
  minimumExecutablePlanDurationMs,
  requireAgenticCapability,
} from "../src/agentic/agenticCapabilityRegistry.js";
import { routeAgenticNode } from "../src/agentic/agenticCapabilityRouter.js";
import {
  AGENTIC_PLAN_NODE_IDS,
  compileAgenticPlan,
} from "../src/agentic/agenticPlanCompiler.js";
import {
  createAgenticCandidateHash,
  createAgenticContextBundleId,
  type AgenticContextBundle,
  type AgenticContextItem,
} from "../src/agentic/agenticMissionContract.js";

const ARTIFACT_NAME = "READINESS.md";
const REQUIRED_SECTIONS = ["Executive Summary", "Evidence Index"];

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: "mission-1",
    traceId: "trace-1",
    workspaceId: "ws-1",
    actorId: "founder",
    objective: "Assess fabric readiness.",
    constraints: [
      {
        constraintId: "c1",
        kind: "forbid",
        subject: "external_publication",
        statement: "Nothing may be published externally.",
      },
    ],
    acceptanceCriteria: [
      {
        criterionId: "a1",
        statement: "Evidence Index is present.",
        check: "artifact_section_present",
        parameter: "Evidence Index",
      },
    ],
    riskClass: "local_write",
    verifiabilityClass: "evidence_verifiable",
    authorityPolicy: {
      approvalRequiredCapabilities: ["artifact.local.write"],
      approverRole: "founder",
    },
    timeBudgetMs: 600_000,
    maxParallelism: 2,
    allowedCapabilities: [...AGENTIC_ARTIFACT_MISSION_CAPABILITIES],
    forbiddenCapabilities: [],
    contextRequirements: [
      {
        requirementId: "r1",
        sourceType: "repository_metadata",
        sourceIdentity: "operator",
        scope: "operator_repo",
        freshnessPolicy: "compiled_at_submission",
      },
    ],
    outputContract: {
      format: "markdown",
      artifactName: ARTIFACT_NAME,
      requiredSections: REQUIRED_SECTIONS,
    },
    requestedAt: "2026-08-06T10:00:00.000Z",
    ...overrides,
  };
}

function contextItem(overrides: Partial<AgenticContextItem> = {}): AgenticContextItem {
  return {
    contextItemId: "ctx-aaaaaaaaaaaaaaaaaaaaaaaa",
    sourceType: "repository_metadata",
    sourceIdentity: "operator",
    contentHash: "a".repeat(64),
    retrievedAt: "2026-08-06T10:00:00.000Z",
    freshnessPolicy: "compiled_at_submission",
    trustClass: "authoritative",
    scope: "operator_repo",
    claims: ["operator HEAD is abc123."],
    evidenceReference: "context:ctx-aaaaaaaaaaaaaaaaaaaaaaaa",
    ...overrides,
  };
}

function bundle(items: readonly AgenticContextItem[]): AgenticContextBundle {
  return {
    schemaVersion: "chanter.agentic-context.v1",
    contextBundleId: createAgenticContextBundleId(items),
    items,
    rejectedRequirementIds: [],
    compiledAt: "2026-08-06T10:00:00.000Z",
  };
}

function refusalCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(OperatorError);
    return (error as OperatorError).code ?? "";
  }
  throw new Error("Expected a typed refusal, but compilation succeeded.");
}

describe("agentic intent compiler", () => {
  it("compiles a submission into a stable, order-insensitive hash", () => {
    const first = compileAgenticIntent(submission());
    const second = compileAgenticIntent(submission({
      // Same semantics, different declaration order.
      allowedCapabilities: [...AGENTIC_ARTIFACT_MISSION_CAPABILITIES].reverse(),
    }));

    expect(first.intentHash).toHaveLength(64);
    expect(second.intentHash).toBe(first.intentHash);
    expect(first.allowedCapabilities).toEqual([...first.allowedCapabilities].sort());
  });

  it("preserves the human's original wording separately from compiled semantics", () => {
    const intent = compileAgenticIntent(submission());

    expect(intent.humanText.objective).toBe("Assess fabric readiness.");
    expect(intent.humanText.constraints).toEqual(["Nothing may be published externally."]);
    // The compiled constraint is typed; the statement is the human's bytes.
    expect(intent.constraints[0]?.kind).toBe("forbid");
    expect(intent.constraints[0]?.subject).toBe("external_publication");
  });

  it("records every default it supplied rather than assuming it silently", () => {
    const intent = compileAgenticIntent(submission({ traceId: undefined }));

    expect(intent.traceId).toBe("mission-1");
    expect(intent.defaultsApplied.map((entry) => entry.field)).toContain("traceId");
    expect(intent.defaultsApplied[0]?.reason.length).toBeGreaterThan(0);
  });

  it("refuses contradictory hard constraints", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      constraints: [
        { constraintId: "c1", kind: "require", subject: "evidence", statement: "Require evidence." },
        { constraintId: "c2", kind: "forbid", subject: "evidence", statement: "Forbid evidence." },
      ],
    })))).toBe("AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY");
  });

  it("refuses a mission with no acceptance criteria", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({ acceptanceCriteria: [] }))))
      .toBe("AGENTIC_INTENT_FIELD_INVALID");
  });

  it("refuses an unsupported risk class rather than downgrading it", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({ riskClass: "external_write" }))))
      .toBe("AGENTIC_INTENT_RISK_ACTION_UNSUPPORTED");
    expect(refusalCode(() => compileAgenticIntent(submission({ riskClass: "irreversible" }))))
      .toBe("AGENTIC_INTENT_RISK_ACTION_UNSUPPORTED");
  });

  it("refuses a consequential mission that names no approval policy", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      authorityPolicy: { approvalRequiredCapabilities: [], approvalRequiredRiskClasses: [], approverRole: "founder" },
    })))).toBe("AGENTIC_INTENT_AUTHORITY_POLICY_REQUIRED");
  });

  it("never silently grants a capability the mission did not request", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      allowedCapabilities: AGENTIC_ARTIFACT_MISSION_CAPABILITIES
        .filter((capability) => capability !== "evidence.verify"),
    })))).toBe("AGENTIC_INTENT_CAPABILITY_NOT_ALLOWED");
  });

  it("refuses a budget below the smallest executable plan", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({ timeBudgetMs: 1 }))))
      .toBe("AGENTIC_INTENT_BUDGET_BELOW_MINIMUM");
    expect(minimumExecutablePlanDurationMs()).toBeGreaterThan(0);
  });

  it("refuses concurrency too low for independent specialist work", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({ maxParallelism: 1 }))))
      .toBe("AGENTIC_INTENT_BUDGET_BELOW_MINIMUM");
  });

  it("refuses an ambiguous output contract", () => {
    for (const outputContract of [
      { format: "markdown", artifactName: ARTIFACT_NAME, requiredSections: [] },
      { format: "markdown", artifactName: "../escape.md", requiredSections: REQUIRED_SECTIONS },
      { format: "html", artifactName: ARTIFACT_NAME, requiredSections: REQUIRED_SECTIONS },
      {
        format: "markdown",
        artifactName: ARTIFACT_NAME,
        requiredSections: ["Evidence Index", "Evidence Index"],
      },
    ]) {
      expect(refusalCode(() => compileAgenticIntent(submission({ outputContract }))))
        .toBe("AGENTIC_INTENT_OUTPUT_CONTRACT_AMBIGUOUS");
    }
  });

  it("refuses changed intent bytes under a known mission identity", () => {
    const stored = compileAgenticIntent(submission());
    const changed = compileAgenticIntent(submission({ objective: "Something else entirely." }));

    expect(() => assertAgenticIntentUnchanged(stored.intentHash, changed))
      .toThrowError(/different compiled intent/);
    expect(() => assertAgenticIntentUnchanged(stored.intentHash, stored)).not.toThrow();
  });
});

describe("agentic capability registry", () => {
  it("registers no capability this fabric may not execute", () => {
    for (const capability of listAgenticCapabilities()) {
      expect(["read_only", "local_write"]).toContain(capability.riskClass);
      expect(capability.sideEffectClass).not.toBe("external");
    }
  });

  it("draws every allowed tool from the closed tool registry", () => {
    for (const capability of listAgenticCapabilities()) {
      for (const tool of capability.allowedTools) {
        expect(AGENTIC_TOOLS).toContain(tool);
      }
    }
  });

  /**
   * The property is "every consequential capability is gated", not "there is
   * exactly one of them". The registry now serves two mission kinds, each with
   * its own single side effect — an artifact write and a connector action — and
   * pinning the *set* would turn adding a reviewed capability into a test
   * failure rather than the invariant check it deserves.
   */
  it("gates every capability that has a side effect, and gates nothing else", () => {
    const effectful = listAgenticCapabilities()
      .filter((capability) => capability.sideEffectClass !== "none")
      .map((capability) => capability.capabilityId)
      .sort();
    const gated = listAgenticCapabilities()
      .filter((capability) => capability.authorityRequirement !== "none")
      .map((capability) => capability.capabilityId)
      .sort();

    expect(effectful).toEqual(["artifact.local.write", "connector.state.apply"]);
    // Exactly the same set: nothing consequential is ungated, and nothing
    // harmless demands a human decision it does not need.
    expect(gated).toEqual(effectful);
  });

  it("gives each mission kind exactly one consequential capability", () => {
    const consequentialFor = (capabilities: readonly string[]): string[] => capabilities
      .filter((capabilityId) => requireAgenticCapability(capabilityId).sideEffectClass !== "none")
      .sort();

    expect(consequentialFor(AGENTIC_ARTIFACT_MISSION_CAPABILITIES)).toEqual(["artifact.local.write"]);
    expect(consequentialFor(AGENTIC_EXCEPTION_MISSION_CAPABILITIES)).toEqual(["connector.state.apply"]);
  });

  it("never registers a real external side effect", () => {
    // `simulated_external` is a connector-owned local store standing in for an
    // external system. `external` means a real third party changed, and no
    // capability may declare it — the registry refuses at module load.
    const external = listAgenticCapabilities()
      .filter((capability) => capability.sideEffectClass === "external");

    expect(external).toEqual([]);
  });
});

describe("agentic capability router", () => {
  const intent = compileAgenticIntent(submission());

  it("never spends inference on deterministic work", () => {
    for (const capabilityId of AGENTIC_ARTIFACT_MISSION_CAPABILITIES) {
      const capability = requireAgenticCapability(capabilityId);
      const decision = routeAgenticNode(intent, "N1", capabilityId);
      if (capability.verifiability === "deterministic") {
        expect(decision.selectedWorkerKind).toBe("deterministic_tool");
      }
      expect(decision.selectedWorkerKind).not.toBe("model_worker");
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("reads authority from the capability contract, never from the node name", () => {
    // The same capability routed under two different node names must reach the
    // same authority conclusion, or a rename would change who must approve.
    const first = routeAgenticNode(intent, "N7", "artifact.local.write");
    const second = routeAgenticNode(intent, "totally.different.node.name", "artifact.local.write");

    expect(first.authorityRequirement).toBe("human_approval_bound_to_candidate_hash");
    expect(second.authorityRequirement).toBe(first.authorityRequirement);

    const readOnly = routeAgenticNode(intent, "artifact.persist", "architecture.analyze");
    expect(readOnly.authorityRequirement).toBe("none");
  });

  it("refuses to route a capability the mission forbade", () => {
    const restricted = compileAgenticIntent(submission({
      allowedCapabilities: AGENTIC_ARTIFACT_MISSION_CAPABILITIES,
      forbiddenCapabilities: ["repo.file.read"],
    }));

    expect(refusalCode(() => routeAgenticNode(restricted, "N1", "repo.file.read")))
      .toBe("AGENTIC_ROUTER_FORBIDDEN_CAPABILITY");
  });

  it("escalates rather than auto-retrying a node with a real side effect", () => {
    expect(routeAgenticNode(intent, "N7", "artifact.local.write").fallbackPolicy)
      .toBe("escalate_to_human");
    expect(routeAgenticNode(intent, "N2", "architecture.analyze").fallbackPolicy)
      .toBe("reconcile_then_resume");
  });
});

describe("agentic plan compiler", () => {
  const intent = compileAgenticIntent(submission());
  const context = bundle([contextItem()]);

  it("compiles the same intent and context to the same plan identity", () => {
    const first = compileAgenticPlan(intent, context);
    const second = compileAgenticPlan(compileAgenticIntent(submission()), bundle([contextItem()]));

    expect(first.plan.planId).toBe(second.plan.planId);
    expect(first.plan.planHash).toBe(second.plan.planHash);
    expect(first.plan.nodes.map((node) => node.payloadHash))
      .toEqual(second.plan.nodes.map((node) => node.payloadHash));
    expect(first.plan.edges).toEqual(second.plan.edges);
  });

  it("produces a different plan for a different context bundle", () => {
    const other = bundle([contextItem({
      contextItemId: "ctx-bbbbbbbbbbbbbbbbbbbbbbbb",
      contentHash: "b".repeat(64),
    })]);

    expect(compileAgenticPlan(intent, other).plan.planId)
      .not.toBe(compileAgenticPlan(intent, context).plan.planId);
  });

  it("compiles exactly the canonical eight-node graph", () => {
    const { plan } = compileAgenticPlan(intent, context);

    expect(plan.nodes.map((node) => node.nodeId)).toEqual(AGENTIC_PLAN_NODE_IDS);
    expect(plan.nodes).toHaveLength(8);
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));
    expect(byId.get("N2")?.dependencyIds).toEqual(["N1"]);
    expect(byId.get("N3")?.dependencyIds).toEqual(["N1"]);
    expect(byId.get("N4")?.dependencyIds).toEqual(["N2", "N3"]);
    expect(byId.get("N8")?.dependencyIds).toEqual(["N7"]);
  });

  it("gives the two specialists no path to each other's output", () => {
    const { plan } = compileAgenticPlan(intent, context);
    const byId = new Map(plan.nodes.map((node) => [node.nodeId, node]));

    expect(byId.get("N2")?.inputRefs).not.toContain("N3");
    expect(byId.get("N3")?.inputRefs).not.toContain("N2");
  });

  it("gives synthesis no direct edge from any specialist", () => {
    const { plan } = compileAgenticPlan(intent, context);
    const synthesis = plan.nodes.find((node) => node.nodeId === "N5");

    // Only the verifier's accepted output may reach synthesis; a direct
    // source-to-synthesis path would let an unverified claim into the artifact.
    expect(synthesis?.inputRefs).toEqual(["N4"]);
    expect(synthesis?.dependencyIds).toEqual(["N4"]);
  });

  it("models the authority checkpoint as a node that runs no worker", () => {
    const { plan } = compileAgenticPlan(intent, context);
    const checkpoint = plan.nodes.find((node) => node.nodeId === "N6");

    expect(checkpoint?.capabilityId).toBeNull();
    expect(checkpoint?.workerKind).toBeNull();
    expect(checkpoint?.budget.maxToolCalls).toBe(0);
    expect(checkpoint?.budget.maxModelCalls).toBe(0);
    expect(checkpoint?.authorityRequirement).toBe("human_approval_bound_to_candidate_hash");
  });

  it("permits the consequential node exactly one automatic attempt", () => {
    const { plan } = compileAgenticPlan(intent, context);
    const write = plan.nodes.find((node) => node.nodeId === "N7");
    const specialist = plan.nodes.find((node) => node.nodeId === "N2");

    expect(write?.attemptLimit).toBe(1);
    expect(specialist?.attemptLimit).toBeGreaterThan(1);
  });

  it("records one routing decision per worker node", () => {
    const { plan, routing } = compileAgenticPlan(intent, context);
    const workerNodes = plan.nodes.filter((node) => node.capabilityId !== null);

    expect(routing).toHaveLength(workerNodes.length);
    expect(routing.every((decision) => decision.reason.length > 0)).toBe(true);
  });
});

describe("agentic candidate digest", () => {
  it("binds different bytes to different digests", () => {
    expect(createAgenticCandidateHash("# a\n")).toHaveLength(64);
    expect(createAgenticCandidateHash("# a\n")).toBe(createAgenticCandidateHash("# a\n"));
    expect(createAgenticCandidateHash("# a\n")).not.toBe(createAgenticCandidateHash("# b\n"));
  });
});
