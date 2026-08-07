/**
 * Governed model-worker admission — canonical contract tests.
 *
 * The pure layers only: the execution policy, the closed provider registry, the
 * router's escalation rule, and the plan compiler's binding of a provider to a
 * node payload hash. Live provider behaviour — real inference, measured usage,
 * fallback, interruption, replay — is proven end to end by
 * `npm run os:csi-model-workers`, so nothing here re-simulates it.
 *
 * What this file exists to catch is the drift that would silently un-govern the
 * whole thing: a mission that can name its own endpoint, a deterministic check
 * that becomes probabilistic, or a provider that can change under an approval
 * that was already given.
 */
import { describe, expect, it } from "vitest";

import { OperatorError } from "../src/services/operatorService.js";
import { compileAgenticIntent } from "../src/agentic/agenticIntentCompiler.js";
import {
  AGENTIC_ARTIFACT_MISSION_CAPABILITIES,
  budgetForWorkerKind,
  listAgenticCapabilities,
  minimumExecutablePlanDurationMs,
  requireAgenticCapability,
} from "../src/agentic/agenticCapabilityRegistry.js";
import { routeAgenticNode } from "../src/agentic/agenticCapabilityRouter.js";
import { compileAgenticPlan } from "../src/agentic/agenticPlanCompiler.js";
import { createAgenticWorkerSet } from "../src/agentic/agenticWorkers.js";
import {
  createAgenticContextBundleId,
  type AgenticContextBundle,
  type AgenticContextItem,
} from "../src/agentic/agenticMissionContract.js";
import {
  allRegisteredBindingIds,
  authorizedBindingIdsFor,
  capabilitySupportsModelWorker,
  createOperatorProviderBindingRegistry,
  defaultBindingFor,
  EXTERNAL_BILLED_BINDING_ID,
  EXTERNAL_BILLED_MODEL_ID,
  LOCAL_JUDGMENT_BINDING_ID,
  SIMULATOR_PRIMARY_BINDING_ID,
} from "../src/agentic/agenticProviderRegistry.js";
import { costEnforcementFor, OPENROUTER_ADAPTER_ID } from "chanter-agent-runtime";
import {
  AGENTIC_SIMULATOR_SCENARIOS,
  createAgenticProviderAdapters,
  normalizeSimulatorScenario,
} from "../src/agentic/agenticProviderAdapters.js";

const MODEL_POLICY_BUDGET_MS = 900_000;

function submission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: "chanter.agentic-work.v1",
    missionId: "mission-model-1",
    traceId: "trace-1",
    workspaceId: "ws-1",
    actorId: "founder",
    objective: "Assess fabric readiness with model-backed specialists.",
    constraints: [],
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
    timeBudgetMs: MODEL_POLICY_BUDGET_MS,
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
      artifactName: "READINESS.md",
      requiredSections: ["Executive Summary", "Evidence Index"],
    },
    requestedAt: "2026-08-07T10:00:00.000Z",
    ...overrides,
  };
}

function bundle(): AgenticContextBundle {
  const items: readonly AgenticContextItem[] = [{
    contextItemId: "ctx-aaaaaaaaaaaaaaaaaaaaaaaa",
    sourceType: "repository_metadata",
    sourceIdentity: "operator",
    contentHash: "a".repeat(64),
    retrievedAt: "2026-08-07T10:00:00.000Z",
    freshnessPolicy: "compiled_at_submission",
    trustClass: "authoritative",
    scope: "operator_repo",
    claims: ["operator HEAD is abc123."],
    evidenceReference: "context:ctx-aaaaaaaaaaaaaaaaaaaaaaaa",
  }];
  return {
    schemaVersion: "chanter.agentic-context.v1",
    contextBundleId: createAgenticContextBundleId(items),
    items,
    rejectedRequirementIds: [],
    compiledAt: "2026-08-07T10:00:00.000Z",
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

const MODEL_SUBMISSION = { executionPolicy: "model_required_for_judgment" };

describe("execution policy", () => {
  it("defaults to the cheapest sufficient worker and records that it assumed one", () => {
    const intent = compileAgenticIntent(submission());
    expect(intent.executionPolicy).toBe("cheapest_sufficient");
    expect(intent.providerBindings).toEqual([]);
    expect(intent.defaultsApplied.map((entry) => entry.field)).toContain("executionPolicy");
  });

  it("refuses a policy value the closed set does not carry", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({ executionPolicy: "always_use_the_best_model" }))))
      .toBe("AGENTIC_INTENT_FIELD_INVALID");
  });

  it("participates in the intent hash, so the same mission under a different policy is a conflict", () => {
    const cheap = compileAgenticIntent(submission());
    const model = compileAgenticIntent(submission(MODEL_SUBMISSION));
    expect(model.intentHash).not.toBe(cheap.intentHash);
  });

  it("raises the minimum executable budget, because model nodes genuinely cost more time", () => {
    const cheap = minimumExecutablePlanDurationMs("cheapest_sufficient");
    const model = minimumExecutablePlanDurationMs("model_required_for_judgment");
    expect(model).toBeGreaterThan(cheap);
    expect(refusalCode(() => compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      timeBudgetMs: cheap,
    })))).toBe("AGENTIC_INTENT_BUDGET_BELOW_MINIMUM");
  });

  it("refuses provider bindings declared under a policy that routes nothing to a model", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      providerBindings: [{ capabilityId: "architecture.analyze", bindingId: LOCAL_JUDGMENT_BINDING_ID }],
    })))).toBe("AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY");
  });
});

describe("closed provider registry", () => {
  it("refuses a binding nobody registered, before any worker could exist", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      providerBindings: [{ capabilityId: "architecture.analyze", bindingId: "openai.gpt-9.turbo" }],
    })))).toBe("AGENTIC_INTENT_PROVIDER_BINDING_UNREGISTERED");
  });

  it("refuses a registered binding this capability is not authorized to reach", () => {
    // Deterministic capabilities authorize none at all, which is the enforcement.
    expect(refusalCode(() => compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      providerBindings: [{ capabilityId: "evidence.verify", bindingId: LOCAL_JUDGMENT_BINDING_ID }],
    })))).toBe("AGENTIC_INTENT_MODEL_WORKER_NOT_PERMITTED");
  });

  it("refuses two different bindings for one capability rather than picking one", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      providerBindings: [
        { capabilityId: "architecture.analyze", bindingId: LOCAL_JUDGMENT_BINDING_ID },
        { capabilityId: "architecture.analyze", bindingId: SIMULATOR_PRIMARY_BINDING_ID },
      ],
    })))).toBe("AGENTIC_INTENT_CONSTRAINTS_CONTRADICTORY");
  });

  it("authorizes model bindings for exactly the judgement-bearing capabilities", () => {
    for (const capability of listAgenticCapabilities()) {
      const supported = capabilitySupportsModelWorker(capability.capabilityId);
      if (capability.verifiability === "deterministic") {
        expect(supported, `${capability.capabilityId} must authorize no provider binding`).toBe(false);
      }
      if (supported) {
        expect(capability.allowedWorkerKinds).toContain("model_worker");
        expect(capability.modelWorkerBudget).not.toBeNull();
      }
    }
  });

  it("leaves every live binding disabled when no provider is configured", () => {
    const registry = createOperatorProviderBindingRegistry({
      localModelBaseUrl: "",
      simulatorEnabled: false,
      simulatorScenario: "disabled",
      openRouterApiKey: "",
      openRouterBaseUrl: "https://openrouter.ai",
    });
    expect(registry.resolve(LOCAL_JUDGMENT_BINDING_ID)?.enabled).toBe(false);
    expect(defaultBindingFor("architecture.analyze", registry)).toBeNull();
  });

  it("prefers the live provider over the simulator when both are enabled", () => {
    const registry = createOperatorProviderBindingRegistry({
      localModelBaseUrl: "http://127.0.0.1:11434",
      simulatorEnabled: true,
      simulatorScenario: "succeed",
      openRouterApiKey: "",
      openRouterBaseUrl: "https://openrouter.ai",
    });
    expect(defaultBindingFor("architecture.analyze", registry)).toBe(LOCAL_JUDGMENT_BINDING_ID);
  });

  it("declares the local binding unpriced with a stated reason, never zero", () => {
    const registry = createOperatorProviderBindingRegistry({
      localModelBaseUrl: "http://127.0.0.1:11434",
      simulatorEnabled: false,
      simulatorScenario: "disabled",
      openRouterApiKey: "",
      openRouterBaseUrl: "https://openrouter.ai",
    });
    const pricing = registry.resolve(LOCAL_JUDGMENT_BINDING_ID)?.pricing;
    expect(pricing?.costMode).toBe("unpriced_local_compute");
    expect(pricing?.unpricedReason).toMatch(/no invoice exists/i);
    expect(pricing?.inputMicrosPerMillionTokens).toBeNull();
  });

  it("registers no live adapter when no provider is configured", () => {
    const adapters = createAgenticProviderAdapters({
      localModelBaseUrl: "",
      simulatorEnabled: false,
      simulatorScenario: "disabled",
      openRouterApiKey: "",
      openRouterBaseUrl: "https://openrouter.ai",
    });
    expect(adapters.size).toBe(0);
  });

  it("normalizes an unrecognized simulator scenario to disabled", () => {
    expect(normalizeSimulatorScenario("pretend-everything-worked")).toBe("disabled");
    for (const scenario of AGENTIC_SIMULATOR_SCENARIOS) {
      expect(normalizeSimulatorScenario(scenario)).toBe(scenario);
    }
  });

  it("keeps every registered binding id stable, independent of configuration", () => {
    expect([...allRegisteredBindingIds()]).toContain(LOCAL_JUDGMENT_BINDING_ID);
    expect([...authorizedBindingIdsFor("architecture.analyze")][0]).toBe(LOCAL_JUDGMENT_BINDING_ID);
  });
});

describe("billed external provider binding", () => {
  const configured = {
    localModelBaseUrl: "",
    simulatorEnabled: false,
    simulatorScenario: "disabled" as const,
    openRouterApiKey: "sk-or-v1-not-a-real-key-0000000000000000",
    openRouterBaseUrl: "https://openrouter.ai",
  };
  const unconfigured = { ...configured, openRouterApiKey: "" };

  it("cannot spend anything when no credential is configured", () => {
    const registry = createOperatorProviderBindingRegistry(unconfigured);
    expect(registry.resolve(EXTERNAL_BILLED_BINDING_ID)?.enabled).toBe(false);
    // Two independent gates: the binding is disabled *and* no transport exists.
    expect(createAgenticProviderAdapters(unconfigured).has(OPENROUTER_ADAPTER_ID)).toBe(false);
  });

  it("registers exactly one transport once a credential is configured", () => {
    const registry = createOperatorProviderBindingRegistry(configured);
    expect(registry.resolve(EXTERNAL_BILLED_BINDING_ID)?.enabled).toBe(true);
    expect(createAgenticProviderAdapters(configured).has(OPENROUTER_ADAPTER_ID)).toBe(true);
  });

  it("names the billing counterparty as the provider, not the model vendor", () => {
    const binding = createOperatorProviderBindingRegistry(configured).resolve(EXTERNAL_BILLED_BINDING_ID);
    // OpenRouter charges the account. DeepSeek is what it routes to, and
    // attributing the spend to DeepSeek would name a party CHANTER has no
    // billing relationship with.
    expect(binding?.providerName).toBe("openrouter");
    expect(binding?.modelId).toBe(EXTERNAL_BILLED_MODEL_ID);
    expect(binding?.mode).toBe("live");
  });

  it("declares provider-reported cost and therefore needs no invented price", () => {
    const binding = createOperatorProviderBindingRegistry(configured).resolve(EXTERNAL_BILLED_BINDING_ID);
    expect(binding?.pricing.costMode).toBe("provider_reported");
    expect(binding?.pricing.inputMicrosPerMillionTokens).toBeNull();
    expect(binding?.pricing.outputMicrosPerMillionTokens).toBeNull();
    expect(binding?.pricing.pricingRevision).toBeNull();
    // Post-only: the amount does not exist until the provider states it, so
    // claiming pre-dispatch monetary enforcement would be false.
    expect(costEnforcementFor(binding!)).toBe("post_only");
  });

  it("never falls back from a billed call to a cheaper or simulated one", () => {
    const binding = createOperatorProviderBindingRegistry(configured).resolve(EXTERNAL_BILLED_BINDING_ID);
    expect(binding?.fallbackBindingId).toBeNull();
    expect(binding?.retryPolicy.maxAttempts).toBe(1);
    expect(binding?.retryPolicy.fallbackOnRateLimit).toBe(false);
  });

  it("declares that admitted context leaves the machine", () => {
    const registry = createOperatorProviderBindingRegistry(configured);
    expect(registry.resolve(EXTERNAL_BILLED_BINDING_ID)?.dataHandlingClass).toBe("external_processor");
    // Every other binding stays local, so the external one is the exception
    // rather than the norm — and is visible as such.
    for (const id of [LOCAL_JUDGMENT_BINDING_ID, SIMULATOR_PRIMARY_BINDING_ID]) {
      expect(registry.resolve(id)?.dataHandlingClass).toBe("local_process_only");
    }
  });

  it("keeps the free local provider ahead of the billed one in preference order", () => {
    const order = [...authorizedBindingIdsFor("architecture.analyze")];
    expect(order.indexOf(LOCAL_JUDGMENT_BINDING_ID)).toBeLessThan(order.indexOf(EXTERNAL_BILLED_BINDING_ID));
    // A mission that does not name the billed binding does not spend money,
    // even when a credential is present.
    const registry = createOperatorProviderBindingRegistry({ ...configured, localModelBaseUrl: "http://127.0.0.1:11434" });
    expect(defaultBindingFor("architecture.analyze", registry)).toBe(LOCAL_JUDGMENT_BINDING_ID);
  });

  it("is selectable by a mission, and binds into the node payload hash", () => {
    const intent = compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      providerBindings: [
        { capabilityId: "architecture.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
        { capabilityId: "risk.analyze", bindingId: EXTERNAL_BILLED_BINDING_ID },
      ],
    }));
    const billed = compileAgenticPlan(intent, bundle()).plan;
    const local = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle()).plan;
    const billedN2 = billed.nodes.find((node) => node.nodeId === "N2");
    expect(billedN2?.providerBindingId).toBe(EXTERNAL_BILLED_BINDING_ID);
    // Changing which provider a node uses changes the node, which changes the
    // plan — so an approval given for a free provider cannot silently carry
    // onto a billed one.
    expect(billedN2?.payloadHash).not.toBe(local.nodes.find((node) => node.nodeId === "N2")?.payloadHash);
    expect(billed.planId).not.toBe(local.planId);
  });

  it("still refuses to attach the billed binding to a deterministic capability", () => {
    expect(refusalCode(() => compileAgenticIntent(submission({
      ...MODEL_SUBMISSION,
      providerBindings: [{ capabilityId: "outcome.verify", bindingId: EXTERNAL_BILLED_BINDING_ID }],
    })))).toBe("AGENTIC_INTENT_MODEL_WORKER_NOT_PERMITTED");
  });
});

describe("router escalation", () => {
  it("routes judgement capabilities to a model only under the declared policy", () => {
    const cheap = compileAgenticIntent(submission());
    const model = compileAgenticIntent(submission(MODEL_SUBMISSION));
    for (const capabilityId of ["architecture.analyze", "risk.analyze"]) {
      expect(routeAgenticNode(cheap, "N2", capabilityId).selectedWorkerKind).toBe("structured_local_worker");
      expect(routeAgenticNode(cheap, "N2", capabilityId).providerBindingId).toBeNull();
      const escalated = routeAgenticNode(model, "N2", capabilityId);
      expect(escalated.selectedWorkerKind).toBe("model_worker");
      expect(escalated.providerBindingId).toBe(LOCAL_JUDGMENT_BINDING_ID);
      expect(escalated.selectedModelOrExecutor).toBe(LOCAL_JUDGMENT_BINDING_ID);
    }
  });

  it("never routes a deterministic capability to a model, whatever the policy says", () => {
    const model = compileAgenticIntent(submission(MODEL_SUBMISSION));
    for (const capability of listAgenticCapabilities()) {
      if (capability.verifiability !== "deterministic") continue;
      if (!model.allowedCapabilities.includes(capability.capabilityId)) continue;
      const decision = routeAgenticNode(model, "N4", capability.capabilityId);
      expect(decision.selectedWorkerKind).toBe("deterministic_tool");
      expect(decision.providerBindingId).toBeNull();
    }
  });

  it("reaches the same conclusion whatever the node is called", () => {
    const model = compileAgenticIntent(submission(MODEL_SUBMISSION));
    const asN2 = routeAgenticNode(model, "N2", "architecture.analyze");
    const renamed = routeAgenticNode(model, "artifact.persist", "architecture.analyze");
    expect(renamed.selectedWorkerKind).toBe(asN2.selectedWorkerKind);
    expect(renamed.providerBindingId).toBe(asN2.providerBindingId);
    expect(renamed.authorityRequirement).toBe(asN2.authorityRequirement);
  });
});

describe("verification across independently-numbered specialists", () => {
  /**
   * Model workers number their findings from one, every time.
   *
   * Two independent specialists therefore routinely emit the *same* claim ids,
   * and a verifier that keyed rejections by claim id alone would let one node's
   * unsupported citation discard the other node's well-evidenced claim. That is
   * a silent loss of verified work, and it only appears once real models are in
   * the plan — which is exactly why it is pinned here rather than left to a
   * live run to notice.
   */
  async function verify(input: unknown): Promise<Record<string, unknown>> {
    const workers = createAgenticWorkerSet({
      intent: compileAgenticIntent(submission(MODEL_SUBMISSION)),
      contextBundle: bundle(),
      tools: {} as never,
      candidate: () => null,
      artifactWriteCount: () => 0,
    });
    const worker = workers.resolve("evidence.verify");
    expect(worker).toBeDefined();
    const outcome = await worker!.execute({
      missionId: "m1",
      planId: "plan-1",
      nodeId: "N4",
      capabilityId: "evidence.verify",
      workerKind: "deterministic_tool",
      input: input as never,
      acceptedContextIds: ["ctx-admitted"],
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      tools: { invoke: async () => null },
      recordModelCall: () => undefined,
    });
    expect(outcome.ok).toBe(true);
    return outcome.structuredOutput as Record<string, unknown>;
  }

  const collidingClaimSets = {
    contextBundleId: "ctxb-1",
    acceptedContextIds: ["ctx-admitted"],
    claimSets: [
      {
        nodeId: "N2",
        claims: [{
          claimId: "claim1",
          statement: "Operator owns plan authority.",
          confidence: "high",
          evidenceRefs: ["ctx-admitted"],
        }],
      },
      {
        nodeId: "N3",
        claims: [{
          claimId: "claim1",
          statement: "Recovery never duplicates a side effect.",
          confidence: "high",
          evidenceRefs: ["ctx-never-admitted"],
        }],
      },
    ],
  };

  it("rejects only the node that cited an unadmitted reference", async () => {
    const output = await verify(collidingClaimSets);
    const accepted = output.acceptedClaims as Array<Record<string, unknown>>;
    const rejected = output.rejectedClaims as Array<Record<string, unknown>>;
    expect(output.verificationVerdict).toBe("accepted_with_rejections");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.statement).toBe("Recovery never duplicates a side effect.");
    // The surviving claim carries the same claim id as the rejected one.
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.claimId).toBe("claim1");
    expect(accepted[0]?.sourceNodeId).toBe("N2");
  });

  it("still detects a genuine cross-node contradiction under colliding ids", async () => {
    const output = await verify({
      contextBundleId: "ctxb-1",
      acceptedContextIds: ["ctx-admitted"],
      claimSets: [
        {
          nodeId: "N2",
          claims: [{
            claimId: "claim1",
            statement: "The write node retries automatically.",
            confidence: "high",
            evidenceRefs: ["ctx-admitted"],
          }],
        },
        {
          nodeId: "N3",
          claims: [{
            claimId: "claim1",
            statement: "NOT: The write node retries automatically.",
            confidence: "high",
            evidenceRefs: ["ctx-admitted"],
          }],
        },
      ],
    });
    expect(output.verificationVerdict).toBe("failed");
    expect(output.rejectedClaims).toHaveLength(2);
    expect(output.acceptedClaims).toHaveLength(0);
  });
});

describe("plan compilation under a model policy", () => {
  it("binds the provider into the node payload hash", () => {
    const cheap = compileAgenticPlan(compileAgenticIntent(submission()), bundle());
    const model = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle());

    const cheapN2 = cheap.plan.nodes.find((node) => node.nodeId === "N2");
    const modelN2 = model.plan.nodes.find((node) => node.nodeId === "N2");
    expect(cheapN2?.providerBindingId).toBeNull();
    expect(modelN2?.providerBindingId).toBe(LOCAL_JUDGMENT_BINDING_ID);
    expect(modelN2?.payloadHash).not.toBe(cheapN2?.payloadHash);
    expect(model.plan.planId).not.toBe(cheap.plan.planId);
  });

  it("gives model nodes their declared model budget and leaves everything else untouched", () => {
    const model = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle());
    const modelNode = model.plan.nodes.find((node) => node.nodeId === "N3");
    const expected = budgetForWorkerKind(requireAgenticCapability("risk.analyze"), "model_worker");
    expect(modelNode?.budget.maxTokens).toBe(expected.maxTokens);
    expect(modelNode?.budget.maxModelCalls).toBe(expected.maxModelCalls);
    // The provider call is the Runtime's port, not a tool the model may reach.
    expect(modelNode?.budget.maxToolCalls).toBe(0);

    const verifier = model.plan.nodes.find((node) => node.nodeId === "N4");
    expect(verifier?.workerKind).toBe("deterministic_tool");
    expect(verifier?.budget).toEqual(requireAgenticCapability("evidence.verify").defaultBudget);
  });

  it("applies the mission's per-node cost ceiling to model nodes only", () => {
    const plan = compileAgenticPlan(
      compileAgenticIntent(submission({ ...MODEL_SUBMISSION, modelNodeCostCeilingMicros: 25_000 })),
      bundle(),
    );
    expect(plan.plan.nodes.find((node) => node.nodeId === "N2")?.budget.maxCostMicros).toBe(25_000);
    expect(plan.plan.nodes.find((node) => node.nodeId === "N7")?.budget.maxCostMicros).toBeNull();
  });

  it("keeps the two specialists structurally independent when both are models", () => {
    const plan = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle()).plan;
    const n2 = plan.nodes.find((node) => node.nodeId === "N2");
    const n3 = plan.nodes.find((node) => node.nodeId === "N3");
    expect(n2?.dependencyIds).toEqual(["N1"]);
    expect(n3?.dependencyIds).toEqual(["N1"]);
    expect(n2?.inputRefs).not.toContain("N3");
    expect(n3?.inputRefs).not.toContain("N2");
    // No specialist -> synthesis edge, so an unverified claim still has no path
    // into the artifact even when a model produced it.
    expect(plan.nodes.find((node) => node.nodeId === "N5")?.inputRefs).toEqual(["N4"]);
  });

  it("compiles deterministically: same intent and context give the same plan", () => {
    const first = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle()).plan;
    const second = compileAgenticPlan(compileAgenticIntent(submission(MODEL_SUBMISSION)), bundle()).plan;
    expect(second.planHash).toBe(first.planHash);
    expect(second.nodes.map((node) => node.payloadHash)).toEqual(first.nodes.map((node) => node.payloadHash));
  });
});
