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
  type AgenticNodeType,
  type AgenticPlanEdge,
  type AgenticPlanNode,
} from "./agenticMissionContract.js";
import { requireAgenticCapability } from "./agenticCapabilityRegistry.js";
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

  for (const blueprint of PLAN_BLUEPRINT) {
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
    const offset = dependencyOffset + capability.defaultBudget.maxDurationMs;
    offsetByNode.set(blueprint.nodeId, offset);

    const withoutHash = {
      nodeId: blueprint.nodeId,
      nodeType: blueprint.nodeType,
      capabilityId: blueprint.capabilityId,
      workerKind: decision.selectedWorkerKind,
      dependencyIds: [...blueprint.dependencyIds],
      inputRefs: [...blueprint.inputRefs],
      authorityRequirement: decision.authorityRequirement,
      budget: { ...capability.defaultBudget },
      deadlineOffsetMs: offset,
      attemptLimit: capability.sideEffectClass === "local_artifact"
        ? WRITE_NODE_ATTEMPT_LIMIT
        : PURE_NODE_ATTEMPT_LIMIT,
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
