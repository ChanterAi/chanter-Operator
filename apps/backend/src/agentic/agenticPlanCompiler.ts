/**
 * CHANTER OS — deterministic agentic plan compiler.
 *
 *     approved intent contract + admitted context bundle -> one immutable DAG
 *
 * The plan is a pure function of those two inputs. Same intent hash and same
 * context bundle id give the same `planId`, the same node ids, the same edges,
 * the same node payload hashes, and the same authority checkpoints — on a fresh
 * process, after a restart, on any machine. Nothing here reads a clock, a random
 * source, or the environment, and no worker ever contributes to plan shape.
 *
 * That determinism is what makes an approval meaningful. A human approves a
 * `planId`, and `planId` is a digest of every bound in the plan, so an approval
 * cannot survive a change to what it authorized: a different intent or a
 * different context compiles to a *different plan*, which the journal refuses to
 * overwrite the old one with.
 *
 * ## The compiled shape
 *
 *     N1  context.collect.repository_state   repo.metadata.read
 *      ├─ N2  specialist.architecture_analysis   architecture.analyze
 *      └─ N3  specialist.risk_analysis           risk.analyze
 *              └─ N4  verifier.cross_check       evidence.verify   (N2 + N3)
 *                  └─ N5  synthesis.compose      result.synthesize
 *                      └─ N6  authority.approve_local_write   (no worker)
 *                          └─ N7  artifact.persist   artifact.local.write
 *                              └─ N8  outcome.verify  outcome.verify
 *
 * N2 and N3 depend only on N1 and on nothing of each other's, which is what
 * makes their concurrency real rather than incidental — and it is also why the
 * verifier can treat them as independent: neither could have seen the other's
 * output, because the graph gives them no path to it.
 *
 * N6 runs no worker at all. An authority checkpoint is a *state the plan waits
 * in*, not a task an agent performs, and modelling it as a node with a worker
 * would put the approval decision inside the executable surface.
 */
import { OperatorError } from "../services/operatorService.js";
import {
  agenticPlanIdFor,
  AGENTIC_PLAN_SCHEMA_VERSION,
  createAgenticNodePayloadHash,
  createAgenticPlanHash,
  type AgenticCompiledPlan,
  type AgenticContextBundle,
  type AgenticIntentContract,
  type AgenticMissionKind,
  type AgenticNodeType,
  type AgenticPlanEdge,
  type AgenticPlanNode,
} from "./agenticMissionContract.js";
import { budgetForWorkerKind, requireAgenticCapability } from "./agenticCapabilityRegistry.js";
import { routeAgenticNode, type AgenticRoutingDecision } from "./agenticCapabilityRouter.js";

/** Attempts permitted for a node with no side effect outside its own record. */
const PURE_NODE_ATTEMPT_LIMIT = 3;

/**
 * Attempts permitted for the one consequential node.
 *
 * A single attempt, by design: a second automatic try at a write whose outcome
 * is unknown is exactly how one artifact becomes two. Recovery for this node
 * goes through reconciliation and an explicit human resume, never through a
 * retry budget.
 */
const WRITE_NODE_ATTEMPT_LIMIT = 1;

interface NodeBlueprint {
  readonly nodeId: string;
  readonly nodeType: AgenticNodeType;
  readonly capabilityId: string | null;
  readonly dependencyIds: readonly string[];
  readonly inputRefs: readonly string[];
}

/**
 * The canonical DAG. Declared once, as data, so the compiled shape is auditable
 * without reading control flow.
 */
const PLAN_BLUEPRINT: readonly NodeBlueprint[] = Object.freeze([
  Object.freeze({
    nodeId: "N1",
    nodeType: "context_collect" as const,
    capabilityId: "repo.metadata.read",
    dependencyIds: [] as readonly string[],
    inputRefs: [] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N2",
    nodeType: "specialist" as const,
    capabilityId: "architecture.analyze",
    dependencyIds: ["N1"] as readonly string[],
    inputRefs: ["N1"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N3",
    nodeType: "specialist" as const,
    capabilityId: "risk.analyze",
    dependencyIds: ["N1"] as readonly string[],
    inputRefs: ["N1"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N4",
    nodeType: "verifier" as const,
    capabilityId: "evidence.verify",
    dependencyIds: ["N2", "N3"] as readonly string[],
    inputRefs: ["N2", "N3"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N5",
    nodeType: "synthesis" as const,
    capabilityId: "result.synthesize",
    dependencyIds: ["N4"] as readonly string[],
    // Only the verifier's accepted output. There is deliberately no edge from a
    // specialist to synthesis: a direct source-to-synthesis path would let an
    // unverified claim reach the artifact.
    inputRefs: ["N4"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N6",
    nodeType: "authority_checkpoint" as const,
    capabilityId: null,
    dependencyIds: ["N5"] as readonly string[],
    inputRefs: ["N5"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N7",
    nodeType: "artifact_write" as const,
    capabilityId: "artifact.local.write",
    dependencyIds: ["N6"] as readonly string[],
    inputRefs: ["N5", "N6"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "N8",
    nodeType: "outcome_verify" as const,
    capabilityId: "outcome.verify",
    dependencyIds: ["N7"] as readonly string[],
    inputRefs: ["N5", "N7"] as readonly string[],
  }),
]);

/**
 * The operational-exception DAG.
 *
 *     X1 observe        exception.state.observe    re-reads the connector
 *      └─ X2 compile    exception.action.compile   one ActionContract
 *          └─ X3 authority.approve_connector_write (no worker)
 *              └─ X4 apply   connector.state.apply  ONE simulated write
 *                  └─ X5 verify  exception.outcome.verify
 *
 * Strictly linear, and that is the shape of the guarantee rather than a
 * simplification: each node's whole purpose is to constrain the next one. The
 * observation bounds the action, the action is what a human approves, the
 * approval is what permits the write, and the write is what the oracle judges.
 * A parallel edge anywhere in this chain would mean something ran before the
 * thing that was supposed to bound it.
 *
 * X1 re-observes rather than trusting intake. Intake's observation is what the
 * delta and the approval were built on; X1 exists to prove the source has not
 * moved since — which is the only way a stale approval becomes detectable
 * before the write instead of after it.
 */
const EXCEPTION_PLAN_BLUEPRINT: readonly NodeBlueprint[] = Object.freeze([
  Object.freeze({
    nodeId: "X1",
    nodeType: "state_observe" as const,
    capabilityId: "exception.state.observe",
    dependencyIds: [] as readonly string[],
    inputRefs: [] as readonly string[],
  }),
  Object.freeze({
    nodeId: "X2",
    nodeType: "action_compile" as const,
    capabilityId: "exception.action.compile",
    dependencyIds: ["X1"] as readonly string[],
    inputRefs: ["X1"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "X3",
    nodeType: "authority_checkpoint" as const,
    capabilityId: null,
    dependencyIds: ["X2"] as readonly string[],
    inputRefs: ["X2"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "X4",
    nodeType: "connector_apply" as const,
    capabilityId: "connector.state.apply",
    dependencyIds: ["X3"] as readonly string[],
    inputRefs: ["X2", "X3"] as readonly string[],
  }),
  Object.freeze({
    nodeId: "X5",
    nodeType: "outcome_verify" as const,
    capabilityId: "exception.outcome.verify",
    dependencyIds: ["X4"] as readonly string[],
    inputRefs: ["X2", "X4"] as readonly string[],
  }),
]);

/** The blueprint for one mission kind. The only place the two plans diverge. */
function blueprintFor(missionKind: AgenticMissionKind): readonly NodeBlueprint[] {
  return missionKind === "operational_exception" ? EXCEPTION_PLAN_BLUEPRINT : PLAN_BLUEPRINT;
}

/**
 * The node whose verdict may complete a mission of this kind.
 *
 * Exactly one per plan, and always an `outcome_verify` node. Naming it here
 * rather than hardcoding `"N8"` downstream is what keeps "only an independent
 * oracle completes a mission" true for both plans instead of true for one.
 */
export function terminalVerificationNodeId(missionKind: AgenticMissionKind): string {
  return soleNodeOfType(missionKind, "outcome_verify");
}

/**
 * The one node a human decision lands on for this mission kind.
 *
 * Derived from the blueprint for the same reason as the terminal node: a
 * hardcoded id downstream would silently approve the wrong plan's checkpoint
 * the moment a second plan shape existed.
 */
export function authorityCheckpointNodeId(missionKind: AgenticMissionKind): string {
  return soleNodeOfType(missionKind, "authority_checkpoint");
}

function soleNodeOfType(missionKind: AgenticMissionKind, nodeType: AgenticNodeType): string {
  const matching = blueprintFor(missionKind).filter((blueprint) => blueprint.nodeType === nodeType);
  /* c8 ignore next 7 -- unreachable: both blueprints declare exactly one of each. */
  if (matching.length !== 1) {
    throw new OperatorError(
      `A plan must declare exactly one ${nodeType} node; ${missionKind} declares ${matching.length}.`,
      500,
      "AGENTIC_PLAN_MALFORMED",
    );
  }
  return matching[0]!.nodeId;
}

export interface AgenticCompiledPlanResult {
  readonly plan: AgenticCompiledPlan;
  /** The routing decision behind every worker node, for the durable read model. */
  readonly routing: readonly AgenticRoutingDecision[];
}

/**
 * Compiles the plan.
 *
 * Deadline offsets accumulate along the critical path rather than being shared,
 * so a node's window is "everything before me, plus my own budget" — which is
 * the only offset that stays correct when two siblings run at once.
 */
export function compileAgenticPlan(
  intent: AgenticIntentContract,
  context: AgenticContextBundle,
): AgenticCompiledPlanResult {
  const nodes: AgenticPlanNode[] = [];
  const edges: AgenticPlanEdge[] = [];
  const routing: AgenticRoutingDecision[] = [];
  const offsetByNode = new Map<string, number>();

  for (const blueprint of blueprintFor(intent.missionKind)) {
    const dependencyOffset = blueprint.dependencyIds.reduce(
      (deepest, dependencyId) => Math.max(deepest, offsetByNode.get(dependencyId) ?? 0),
      0,
    );

    if (blueprint.capabilityId === null) {
      // The authority checkpoint. No capability, no worker, no budget, and no
      // deadline of its own: a human is not on a compute clock.
      const withoutHash = {
        nodeId: blueprint.nodeId,
        nodeType: blueprint.nodeType,
        capabilityId: null,
        workerKind: null,
        providerBindingId: null,
        dependencyIds: [...blueprint.dependencyIds],
        inputRefs: [...blueprint.inputRefs],
        authorityRequirement: "human_approval_bound_to_candidate_hash" as const,
        budget: {
          maxToolCalls: 0,
          maxModelCalls: 0,
          maxDurationMs: 0,
          maxTokens: null,
          maxCostMicros: null,
        },
        deadlineOffsetMs: dependencyOffset,
        attemptLimit: 1,
        reconciliationMode: "human_decision_lookup",
        evidencePolicy: { minimumItems: 0, requireAcceptedContextReference: false },
      };
      offsetByNode.set(blueprint.nodeId, dependencyOffset);
      nodes.push({ ...withoutHash, payloadHash: createAgenticNodePayloadHash(withoutHash) });
      for (const dependencyId of blueprint.dependencyIds) {
        edges.push({ fromNodeId: dependencyId, toNodeId: blueprint.nodeId });
      }
      continue;
    }

    const decision = routeAgenticNode(intent, blueprint.nodeId, blueprint.capabilityId);
    routing.push(decision);
    const capability = requireAgenticCapability(blueprint.capabilityId);
    // The budget follows the routing decision, not the capability's default: a
    // node that became a model worker runs under the model budget, and the
    // deadline offsets accumulated along the critical path have to reflect that
    // or the Governor will withhold admission from a node it just admitted.
    const routedBudget = budgetForWorkerKind(capability, decision.selectedWorkerKind);
    const nodeBudget = decision.selectedWorkerKind === "model_worker"
      && intent.modelNodeCostCeilingMicros !== null
      ? { ...routedBudget, maxCostMicros: intent.modelNodeCostCeilingMicros }
      : { ...routedBudget };
    const offset = dependencyOffset + nodeBudget.maxDurationMs;
    offsetByNode.set(blueprint.nodeId, offset);

    const withoutHash = {
      nodeId: blueprint.nodeId,
      nodeType: blueprint.nodeType,
      capabilityId: blueprint.capabilityId,
      workerKind: decision.selectedWorkerKind,
      providerBindingId: decision.providerBindingId,
      dependencyIds: [...blueprint.dependencyIds],
      inputRefs: [...blueprint.inputRefs],
      authorityRequirement: decision.authorityRequirement,
      budget: nodeBudget,
      deadlineOffsetMs: offset,
      // Any side effect gets the single-attempt treatment, not just an artifact
      // write. A second automatic try at a connector action whose outcome is
      // unknown is exactly how one reconciliation becomes two.
      attemptLimit: capability.sideEffectClass === "none"
        ? PURE_NODE_ATTEMPT_LIMIT
        : WRITE_NODE_ATTEMPT_LIMIT,
      reconciliationMode: capability.reconciliationMode,
      evidencePolicy: { ...capability.evidencePolicy },
    };
    nodes.push({ ...withoutHash, payloadHash: createAgenticNodePayloadHash(withoutHash) });
    for (const dependencyId of blueprint.dependencyIds) {
      edges.push({ fromNodeId: dependencyId, toNodeId: blueprint.nodeId });
    }
  }

  assertPlanIsWellFormed(nodes, edges);

  const planHash = createAgenticPlanHash({
    missionId: intent.missionId,
    intentHash: intent.intentHash,
    contextBundleId: context.contextBundleId,
    maxParallelism: intent.maxParallelism,
    nodes,
    edges,
  });

  return {
    plan: {
      schemaVersion: AGENTIC_PLAN_SCHEMA_VERSION,
      planId: agenticPlanIdFor(planHash),
      missionId: intent.missionId,
      intentHash: intent.intentHash,
      contextBundleId: context.contextBundleId,
      nodes,
      edges,
      maxParallelism: intent.maxParallelism,
      planHash,
    },
    routing,
  };
}

/**
 * Structural invariants of any compiled plan.
 *
 * These can only fail if the blueprint above is edited incorrectly, which is
 * exactly when they need to fire: a malformed plan must fail at compile time,
 * never become a durable graph that the Governor then has to reason about.
 */
function assertPlanIsWellFormed(
  nodes: readonly AgenticPlanNode[],
  edges: readonly AgenticPlanEdge[],
): void {
  const ids = new Set(nodes.map((node) => node.nodeId));
  if (ids.size !== nodes.length) {
    throw new OperatorError("Compiled plan contains a duplicate node id.", 500, "AGENTIC_PLAN_MALFORMED");
  }
  for (const node of nodes) {
    for (const dependencyId of node.dependencyIds) {
      if (!ids.has(dependencyId)) {
        throw new OperatorError(
          `Node ${node.nodeId} depends on unknown node ${dependencyId}.`,
          500,
          "AGENTIC_PLAN_MALFORMED",
        );
      }
    }
    for (const inputRef of node.inputRefs) {
      if (!ids.has(inputRef)) {
        throw new OperatorError(
          `Node ${node.nodeId} references unknown node output ${inputRef}.`,
          500,
          "AGENTIC_PLAN_MALFORMED",
        );
      }
    }
  }
  // Kahn's algorithm: a cycle would make the Governor's readiness question
  // unanswerable, so it must be impossible to persist one.
  const pending = new Map(nodes.map((node) => [node.nodeId, new Set(node.dependencyIds)]));
  let progressed = true;
  while (pending.size > 0 && progressed) {
    progressed = false;
    for (const nodeId of [...pending.keys()].sort()) {
      if (pending.get(nodeId)?.size === 0) {
        pending.delete(nodeId);
        for (const remaining of pending.values()) remaining.delete(nodeId);
        progressed = true;
        break;
      }
    }
  }
  if (pending.size > 0) {
    throw new OperatorError(
      `Compiled plan contains a dependency cycle involving ${[...pending.keys()].sort().join(", ")}.`,
      500,
      "AGENTIC_PLAN_MALFORMED",
    );
  }
  const edgeKeys = new Set(edges.map((edge) => `${edge.fromNodeId}->${edge.toNodeId}`));
  if (edgeKeys.size !== edges.length) {
    throw new OperatorError("Compiled plan contains a duplicate edge.", 500, "AGENTIC_PLAN_MALFORMED");
  }
}

/** The exact node ids this fabric compiles, for callers that assert on shape. */
export const AGENTIC_PLAN_NODE_IDS: readonly string[] = Object.freeze(
  PLAN_BLUEPRINT.map((blueprint) => blueprint.nodeId),
);

export const AGENTIC_EXCEPTION_PLAN_NODE_IDS: readonly string[] = Object.freeze(
  EXCEPTION_PLAN_BLUEPRINT.map((blueprint) => blueprint.nodeId),
);
