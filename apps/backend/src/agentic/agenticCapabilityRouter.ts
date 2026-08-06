/**
 * CHANTER OS — capability / risk / verifiability router.
 *
 * Decides, for one node, which registered capability does the work and which
 * *kind* of worker is the smallest one sufficient to do it — then records why,
 * so the decision is reviewable rather than folklore.
 *
 * ## Effective Intelligence Density
 *
 * The preference order is fixed and applies to every capability:
 *
 *     deterministic tool  ->  structured local worker  ->  model worker
 *
 * A capability whose verifiability is `deterministic` never routes to a model,
 * because a model would add cost, latency, and non-determinism to a question
 * that already has an exact answer. Only work that genuinely requires judgement
 * — `evidence_verifiable` or `human_judgment_required` — becomes eligible for a
 * model worker, and even then only when no structured local worker is
 * registered for it. Spending inference on work a function can do is the most
 * common way an agentic system becomes expensive without becoming more capable.
 *
 * ## No string matching
 *
 * Routing reads the capability's declared contract fields — `verifiability`,
 * `riskClass`, `allowedWorkerKinds`, `authorityRequirement` — and nothing else.
 * It never inspects a node's name, a node's objective text, or a prompt. A node
 * called "specialist.architecture_analysis" gets its authority and its worker
 * kind from `architecture.analyze`'s registry entry, so renaming the node
 * changes nothing about what it is permitted to do.
 */
import { OperatorError } from "../services/operatorService.js";
import type { AgenticWorkerKind } from "chanter-agent-runtime";
import {
  requireAgenticCapability,
  type AgenticAuthorityRequirement,
  type AgenticCapability,
} from "./agenticCapabilityRegistry.js";
import type { AgenticIntentContract } from "./agenticMissionContract.js";

/** Global preference order. Index is cost rank: lower is preferred. */
const WORKER_KIND_PREFERENCE: readonly AgenticWorkerKind[] = [
  "deterministic_tool",
  "structured_local_worker",
  "model_worker",
];

/** Rough relative cost units, used only for a comparable estimate. */
const WORKER_KIND_COST_UNITS: Readonly<Record<AgenticWorkerKind, number>> = Object.freeze({
  deterministic_tool: 1,
  structured_local_worker: 2,
  model_worker: 20,
});

export interface AgenticRoutingDecision {
  readonly nodeId: string;
  readonly selectedCapability: string;
  readonly selectedWorkerKind: AgenticWorkerKind;
  /**
   * The concrete executor this fabric will run. Named as an executor identity
   * rather than a model name, because no capability in this P0 routes to a
   * provider — reporting one would be fabricated.
   */
  readonly selectedModelOrExecutor: string;
  readonly reason: string;
  /** Relative cost units, not currency. Currency is only ever measured. */
  readonly estimatedCostUnits: number;
  readonly estimatedLatencyMs: number;
  readonly risk: AgenticCapability["riskClass"];
  readonly requiredEvidence: number;
  readonly authorityRequirement: AgenticAuthorityRequirement;
  /** What happens when this node fails. Explicit, never an implicit retry loop. */
  readonly fallbackPolicy: "reconcile_then_resume" | "escalate_to_human";
}

/**
 * Selects the smallest sufficient worker kind for one capability.
 *
 * Sufficiency is decided by the capability's own declared verifiability, not by
 * the router's opinion: deterministic work may only use a deterministic worker,
 * and judgement work takes the cheapest kind the capability actually registered.
 */
function selectWorkerKind(capability: AgenticCapability): { kind: AgenticWorkerKind; reason: string } {
  const eligible = WORKER_KIND_PREFERENCE.filter((kind) => capability.allowedWorkerKinds.includes(kind));
  const cheapest = eligible[0];
  if (!cheapest) {
    throw new OperatorError(
      `Capability ${capability.capabilityId} declares no routable worker kind.`,
      500,
      "AGENTIC_ROUTER_NO_ELIGIBLE_WORKER",
    );
  }
  if (capability.verifiability === "deterministic") {
    if (cheapest !== "deterministic_tool") {
      throw new OperatorError(
        `Capability ${capability.capabilityId} is deterministic but registers no deterministic worker.`,
        500,
        "AGENTIC_ROUTER_NO_ELIGIBLE_WORKER",
      );
    }
    return {
      kind: "deterministic_tool",
      reason:
        "The capability's declared verifiability is deterministic, so an exact function is sufficient "
        + "and no inference is spent.",
    };
  }
  return {
    kind: cheapest,
    reason: cheapest === "model_worker"
      ? "No cheaper worker kind is registered for this judgement-bearing capability."
      : `The cheapest sufficient worker kind registered for this ${capability.verifiability} capability.`,
  };
}

/**
 * Routes one node.
 *
 * The mission's own allow/forbid lists are re-checked here even though the
 * intent compiler already checked them, because this is the last point before a
 * node payload becomes durable — and a capability that reached routing without
 * being permitted is a defect worth failing on rather than executing.
 */
export function routeAgenticNode(
  intent: AgenticIntentContract,
  nodeId: string,
  capabilityId: string,
): AgenticRoutingDecision {
  if (intent.forbiddenCapabilities.includes(capabilityId)) {
    throw new OperatorError(
      `Node ${nodeId} routes to ${capabilityId}, which this mission forbids.`,
      409,
      "AGENTIC_ROUTER_FORBIDDEN_CAPABILITY",
    );
  }
  if (!intent.allowedCapabilities.includes(capabilityId)) {
    throw new OperatorError(
      `Node ${nodeId} routes to ${capabilityId}, which this mission did not allow.`,
      409,
      "AGENTIC_ROUTER_CAPABILITY_NOT_ALLOWED",
    );
  }
  const capability = requireAgenticCapability(capabilityId);
  const selected = selectWorkerKind(capability);

  // Authority comes from the capability contract and the mission's declared
  // policy — never from the node's name or type.
  const policyRequiresApproval =
    intent.authorityPolicy.approvalRequiredCapabilities.includes(capabilityId)
    || intent.authorityPolicy.approvalRequiredRiskClasses.includes(capability.riskClass);
  const authorityRequirement: AgenticAuthorityRequirement =
    capability.authorityRequirement !== "none" || policyRequiresApproval
      ? "human_approval_bound_to_candidate_hash"
      : "none";

  return {
    nodeId,
    selectedCapability: capabilityId,
    selectedWorkerKind: selected.kind,
    selectedModelOrExecutor: `operator.agentic.${selected.kind}`,
    reason: selected.reason,
    estimatedCostUnits: WORKER_KIND_COST_UNITS[selected.kind],
    estimatedLatencyMs: capability.defaultBudget.maxDurationMs,
    risk: capability.riskClass,
    requiredEvidence: capability.evidencePolicy.minimumItems,
    authorityRequirement,
    fallbackPolicy: capability.sideEffectClass === "none"
      ? "reconcile_then_resume"
      : "escalate_to_human",
  };
}
