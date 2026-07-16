/**
 * Phase 2D versioned mission graph compiler — `chanter.mission.graph.v1`.
 *
 * A pure, deterministic, closed-world compiler: structured graph input in,
 * canonical normalized graph + stable SHA-256 graph hash out. Nothing here
 * touches the database, the clock, or randomness — repeated compilation of
 * the same envelope is byte-identical by construction, which is what lets
 * the Operator graph authority bind founder approval to an exact hash.
 *
 * Every node must resolve through the existing Phase 2C closed-world action
 * registry on the generic lane, and every node input must pass the exact
 * adapter-owned validation the mission spine enforces at submission — a graph
 * that could never execute is refused before it can become durable.
 */
import { createHash } from "node:crypto";
import {
  canonicalEnvelopeJson,
  envelopeToRuntimeMissionRequest,
  validateManualLoopInput,
  validateMissionEnvelope,
  type ChanterMissionEnvelopeV1,
  type JsonValue,
} from "chanter-agent-runtime";
import { resolveRegisteredMissionAction } from "./missionActionRegistry.js";

export const MISSION_GRAPH_SCHEMA_VERSION = "chanter.mission.graph.v1" as const;

/** Bounded closed world: a P0 graph is small by design. */
export const MISSION_GRAPH_MAX_NODES = 8;

const GRAPH_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHAR_PATTERN = /[\u0000-\u001f\u007f]/;
const MAX_TRACE_LENGTH = 120;
const MAX_KEY_LENGTH = 160;
const MAX_ACTOR_LENGTH = 120;
const MAX_TENANT_LENGTH = 160;
const MAX_OBJECTIVE_LENGTH = 2_000;

const GRAPH_ENVELOPE_FIELDS = new Set([
  "schemaVersion", "graphId", "traceId", "idempotencyKey",
  "source", "objective", "tenant", "nodes", "requestedAt",
]);
const GRAPH_SOURCE_FIELDS = new Set(["system", "requestedBy"]);
const GRAPH_TENANT_FIELDS = new Set(["userId", "workspaceId", "accountId"]);
const GRAPH_NODE_FIELDS = new Set(["nodeId", "target", "objective", "input", "dependsOn"]);
const GRAPH_NODE_TARGET_FIELDS = new Set(["product", "action"]);
const VALID_SOURCE_SYSTEMS = new Set([
  "operator", "mcp", "mission_compiler", "loop_governor", "human",
]);

export interface MissionGraphCompileError {
  code: string;
  message: string;
  /** HTTP status the Operator gateway should surface (400 unless stated). */
  status: number;
}

export interface CompiledMissionGraphNode {
  nodeId: string;
  target: { product: string; action: string };
  objective: string;
  input: Record<string, JsonValue>;
  dependsOn: string[];
}

export interface CompiledMissionGraph {
  schemaVersion: typeof MISSION_GRAPH_SCHEMA_VERSION;
  graphId: string;
  traceId: string;
  idempotencyKey: string;
  source: { system: string; requestedBy: string };
  objective: string;
  tenant: { userId: string; workspaceId: string | null; accountId: string | null };
  requestedAt: string;
  nodeCount: number;
  nodes: CompiledMissionGraphNode[];
}

export type MissionGraphCompileResult =
  | {
      ok: true;
      compiled: CompiledMissionGraph;
      /** Deterministic canonical serialization of `compiled` (sorted keys). */
      normalizedJson: string;
      /** SHA-256 over `normalizedJson` — the exact approval-binding hash. */
      graphHash: string;
    }
  | { ok: false; errors: MissionGraphCompileError[] };

/** Deterministic child mission identity for one graph node. */
export function missionGraphChildMissionId(graphId: string, nodeId: string): string {
  return `graph:${graphId}:node:${nodeId}`;
}

export function missionGraphChildTraceId(graphTraceId: string, nodeId: string): string {
  return `graph:${graphTraceId}:node:${nodeId}`;
}

export function missionGraphChildIdempotencyKey(graphId: string, nodeId: string): string {
  return `graph:${graphId}:node:${nodeId}`;
}

/**
 * The exact `chanter.mission.v1` envelope one node materializes into. Every
 * field is a pure function of durable graph state so replay after any crash
 * reconstructs a byte-identical submission (Phase 2C durable create then
 * replays instead of duplicating).
 */
export function missionGraphChildEnvelope(
  graph: CompiledMissionGraph,
  node: CompiledMissionGraphNode,
): ChanterMissionEnvelopeV1 {
  return {
    schemaVersion: "chanter.mission.v1",
    missionId: missionGraphChildMissionId(graph.graphId, node.nodeId),
    traceId: missionGraphChildTraceId(graph.traceId, node.nodeId),
    idempotencyKey: missionGraphChildIdempotencyKey(graph.graphId, node.nodeId),
    source: { system: "operator", requestedBy: graph.source.requestedBy },
    objective: node.objective,
    target: node.target as ChanterMissionEnvelopeV1["target"],
    tenant: {
      userId: graph.tenant.userId,
      ...(graph.tenant.workspaceId ? { workspaceId: graph.tenant.workspaceId } : {}),
      ...(graph.tenant.accountId ? { accountId: graph.tenant.accountId } : {}),
    },
    input: node.input,
    constraints: [],
    acceptanceCriteria: [],
    requestedAt: graph.requestedAt,
    metadata: { graphId: graph.graphId, nodeId: node.nodeId, graphTraceId: graph.traceId },
  };
}

function error(code: string, message: string, status = 400): MissionGraphCompileError {
  return { code, message, status };
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string"
    && Boolean(value)
    && value === value.trim()
    && value.length <= maxLength
    && !CONTROL_CHAR_PATTERN.test(value)
  );
}

function rejectUnknownFields(
  record: Record<string, unknown>,
  allowed: Set<string>,
  scope: string,
  errors: MissionGraphCompileError[],
): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      errors.push(error(
        "GRAPH_FIELD_UNSUPPORTED",
        `${scope} contains a field that is not part of ${MISSION_GRAPH_SCHEMA_VERSION}: ${JSON.stringify(key)}.`,
      ));
    }
  }
}

interface ParsedNode {
  nodeId: string;
  product: string;
  action: string;
  objective: string;
  input: Record<string, JsonValue>;
  dependsOn: string[];
}

function parseNode(
  value: unknown,
  index: number,
  errors: MissionGraphCompileError[],
): ParsedNode | null {
  const node = jsonObject(value);
  if (!node) {
    errors.push(error("GRAPH_NODE_INVALID", `nodes[${index}] must be a JSON object.`));
    return null;
  }
  rejectUnknownFields(node, GRAPH_NODE_FIELDS, `nodes[${index}]`, errors);

  if (typeof node.nodeId !== "string" || !NODE_ID_PATTERN.test(node.nodeId)) {
    errors.push(error(
      "GRAPH_NODE_ID_INVALID",
      `nodes[${index}].nodeId must match ${NODE_ID_PATTERN} (bounded safe identifier).`,
    ));
    return null;
  }
  const nodeLabel = `nodes[${index}] (${node.nodeId})`;

  const target = jsonObject(node.target);
  if (!target) {
    errors.push(error("GRAPH_NODE_TARGET_INVALID", `${nodeLabel}.target must be an object.`));
    return null;
  }
  rejectUnknownFields(target, GRAPH_NODE_TARGET_FIELDS, `${nodeLabel}.target`, errors);
  const registered = resolveRegisteredMissionAction(target.product, target.action);
  if (!registered || registered.lane !== "generic") {
    errors.push(error(
      "GRAPH_NODE_TARGET_UNREGISTERED",
      `${nodeLabel}.target is not registered with the Operator graph authority.`,
      409,
    ));
    return null;
  }

  if (typeof node.objective !== "string" || !node.objective.trim()
    || node.objective.length > MAX_OBJECTIVE_LENGTH
    || node.objective !== node.objective.trim()
    || CONTROL_CHAR_PATTERN.test(node.objective)) {
    errors.push(error(
      "GRAPH_NODE_OBJECTIVE_INVALID",
      `${nodeLabel}.objective must be a trimmed nonblank string of at most ${MAX_OBJECTIVE_LENGTH} characters.`,
    ));
    return null;
  }

  const input = jsonObject(node.input);
  if (!input) {
    errors.push(error("GRAPH_NODE_INPUT_INVALID", `${nodeLabel}.input must be an object payload.`));
    return null;
  }

  let dependsOn: string[] = [];
  if (node.dependsOn !== undefined) {
    if (!Array.isArray(node.dependsOn)) {
      errors.push(error(
        "GRAPH_DEPENDENCY_INVALID",
        `${nodeLabel}.dependsOn must be an array of node ids when provided.`,
      ));
      return null;
    }
    for (const dependency of node.dependsOn) {
      if (typeof dependency !== "string" || !NODE_ID_PATTERN.test(dependency)) {
        errors.push(error(
          "GRAPH_DEPENDENCY_INVALID",
          `${nodeLabel}.dependsOn entries must be bounded safe node ids.`,
        ));
        return null;
      }
    }
    dependsOn = node.dependsOn as string[];
  }

  return {
    nodeId: node.nodeId,
    product: registered.product,
    action: registered.action,
    objective: node.objective,
    input: input as Record<string, JsonValue>,
    dependsOn,
  };
}

function detectCycle(nodes: ParsedNode[]): string[] | null {
  // Kahn's algorithm: whatever cannot be topologically consumed is cyclic.
  const remainingDependencies = new Map<string, Set<string>>();
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    remainingDependencies.set(node.nodeId, new Set(node.dependsOn));
    for (const dependency of node.dependsOn) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.nodeId]);
    }
  }
  const queue = nodes.filter((node) => node.dependsOn.length === 0).map((node) => node.nodeId);
  let consumed = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    consumed += 1;
    for (const dependent of dependents.get(current) ?? []) {
      const remaining = remainingDependencies.get(dependent)!;
      remaining.delete(current);
      if (remaining.size === 0) queue.push(dependent);
    }
  }
  if (consumed === nodes.length) return null;
  return [...remainingDependencies.entries()]
    .filter(([, remaining]) => remaining.size > 0)
    .map(([nodeId]) => nodeId)
    .sort();
}

export function compileMissionGraph(envelope: unknown): MissionGraphCompileResult {
  const errors: MissionGraphCompileError[] = [];
  const e = jsonObject(envelope);
  if (!e) {
    return { ok: false, errors: [error("GRAPH_ENVELOPE_INVALID", "Graph envelope must be a JSON object.")] };
  }

  rejectUnknownFields(e, GRAPH_ENVELOPE_FIELDS, "envelope", errors);

  if (e.schemaVersion !== MISSION_GRAPH_SCHEMA_VERSION) {
    errors.push(error(
      "GRAPH_SCHEMA_VERSION_UNSUPPORTED",
      `schemaVersion must be "${MISSION_GRAPH_SCHEMA_VERSION}".`,
    ));
  }
  if (typeof e.graphId !== "string" || !GRAPH_ID_PATTERN.test(e.graphId)) {
    errors.push(error("GRAPH_ID_INVALID", `graphId must match ${GRAPH_ID_PATTERN} (bounded safe identifier).`));
  }
  if (!exactString(e.traceId, MAX_TRACE_LENGTH)) {
    errors.push(error("GRAPH_TRACE_ID_INVALID", `traceId must be a trimmed nonblank string of at most ${MAX_TRACE_LENGTH} characters.`));
  }
  if (e.idempotencyKey !== undefined && !exactString(e.idempotencyKey, MAX_KEY_LENGTH)) {
    errors.push(error("GRAPH_IDEMPOTENCY_KEY_INVALID", `idempotencyKey must be a trimmed nonblank string of at most ${MAX_KEY_LENGTH} characters when provided.`));
  }

  const source = jsonObject(e.source);
  if (!source) {
    errors.push(error("GRAPH_SOURCE_INVALID", "source is required and must be an object."));
  } else {
    rejectUnknownFields(source, GRAPH_SOURCE_FIELDS, "source", errors);
    if (typeof source.system !== "string" || !VALID_SOURCE_SYSTEMS.has(source.system)) {
      errors.push(error("GRAPH_SOURCE_SYSTEM_INVALID", `source.system must be one of: ${[...VALID_SOURCE_SYSTEMS].join(", ")}.`));
    }
    if (!exactString(source.requestedBy, MAX_ACTOR_LENGTH)) {
      errors.push(error("GRAPH_SOURCE_REQUESTED_BY_INVALID", `source.requestedBy must be a trimmed nonblank string of at most ${MAX_ACTOR_LENGTH} characters.`));
    }
  }

  if (typeof e.objective !== "string" || !e.objective.trim()
    || e.objective !== e.objective.trim()
    || e.objective.length > MAX_OBJECTIVE_LENGTH
    || CONTROL_CHAR_PATTERN.test(e.objective)) {
    errors.push(error("GRAPH_OBJECTIVE_INVALID", `objective must be a trimmed nonblank string of at most ${MAX_OBJECTIVE_LENGTH} characters.`));
  }

  const tenant = jsonObject(e.tenant);
  if (!tenant) {
    errors.push(error("GRAPH_TENANT_INVALID", "tenant is required and must be an object."));
  } else {
    rejectUnknownFields(tenant, GRAPH_TENANT_FIELDS, "tenant", errors);
    if (!exactString(tenant.userId, MAX_TENANT_LENGTH)) {
      errors.push(error("GRAPH_TENANT_USER_ID_INVALID", `tenant.userId must be a trimmed nonblank string of at most ${MAX_TENANT_LENGTH} characters.`));
    }
    if (tenant.workspaceId !== undefined && !exactString(tenant.workspaceId, MAX_TENANT_LENGTH)) {
      errors.push(error("GRAPH_TENANT_WORKSPACE_ID_INVALID", "tenant.workspaceId must be a trimmed nonblank string when provided."));
    }
    if (tenant.accountId !== undefined && !exactString(tenant.accountId, MAX_TENANT_LENGTH)) {
      errors.push(error("GRAPH_TENANT_ACCOUNT_ID_INVALID", "tenant.accountId must be a trimmed nonblank string when provided."));
    }
  }

  if (typeof e.requestedAt !== "string" || Number.isNaN(Date.parse(e.requestedAt))) {
    errors.push(error("GRAPH_REQUESTED_AT_INVALID", "requestedAt must be a valid ISO-8601 timestamp."));
  }

  if (!Array.isArray(e.nodes) || e.nodes.length === 0) {
    errors.push(error("GRAPH_NODES_INVALID", "nodes must be a nonempty array of graph nodes."));
    return { ok: false, errors };
  }
  if (e.nodes.length > MISSION_GRAPH_MAX_NODES) {
    errors.push(error(
      "GRAPH_NODE_LIMIT_EXCEEDED",
      `nodes must contain at most ${MISSION_GRAPH_MAX_NODES} nodes; received ${e.nodes.length}.`,
    ));
    return { ok: false, errors };
  }

  const parsedNodes: ParsedNode[] = [];
  const nodeIds = new Set<string>();
  for (const [index, value] of e.nodes.entries()) {
    const parsed = parseNode(value, index, errors);
    if (!parsed) continue;
    if (nodeIds.has(parsed.nodeId)) {
      errors.push(error("GRAPH_NODE_DUPLICATE", `nodeId ${JSON.stringify(parsed.nodeId)} is declared more than once.`));
      continue;
    }
    nodeIds.add(parsed.nodeId);
    parsedNodes.push(parsed);
  }

  // Dependency shape: known targets only, no self-references, no duplicates.
  for (const node of parsedNodes) {
    const seen = new Set<string>();
    for (const dependency of node.dependsOn) {
      if (dependency === node.nodeId) {
        errors.push(error("GRAPH_DEPENDENCY_SELF", `node ${JSON.stringify(node.nodeId)} must not depend on itself.`));
      } else if (!nodeIds.has(dependency)) {
        errors.push(error("GRAPH_DEPENDENCY_MISSING", `node ${JSON.stringify(node.nodeId)} depends on unknown node ${JSON.stringify(dependency)}.`));
      }
      if (seen.has(dependency)) {
        errors.push(error("GRAPH_DEPENDENCY_DUPLICATE", `node ${JSON.stringify(node.nodeId)} declares dependency ${JSON.stringify(dependency)} more than once.`));
      }
      seen.add(dependency);
    }
  }

  if (errors.length === 0 && parsedNodes.length === e.nodes.length) {
    const cyclic = detectCycle(parsedNodes);
    if (cyclic) {
      errors.push(error(
        "GRAPH_DEPENDENCY_CYCLE",
        `the dependency graph contains a cycle involving: ${cyclic.join(", ")}.`,
      ));
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const compiled: CompiledMissionGraph = {
    schemaVersion: MISSION_GRAPH_SCHEMA_VERSION,
    graphId: e.graphId as string,
    traceId: e.traceId as string,
    idempotencyKey: (e.idempotencyKey as string | undefined)
      ?? `operator-mission-graph:${e.graphId as string}`,
    source: {
      system: (source as Record<string, unknown>).system as string,
      requestedBy: (source as Record<string, unknown>).requestedBy as string,
    },
    objective: e.objective as string,
    tenant: {
      userId: (tenant as Record<string, unknown>).userId as string,
      workspaceId: ((tenant as Record<string, unknown>).workspaceId as string | undefined) ?? null,
      accountId: ((tenant as Record<string, unknown>).accountId as string | undefined) ?? null,
    },
    requestedAt: e.requestedAt as string,
    nodeCount: parsedNodes.length,
    nodes: [...parsedNodes]
      .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1))
      .map((node) => ({
        nodeId: node.nodeId,
        target: { product: node.product, action: node.action },
        objective: node.objective,
        input: node.input,
        dependsOn: [...node.dependsOn].sort(),
      })),
  };

  // Adapter-owned closed-world input validation through the exact machinery
  // the Phase 2C mission spine runs at submission: each node must already be
  // a valid, executable child mission or the graph never becomes durable.
  for (const node of compiled.nodes) {
    const childEnvelope = missionGraphChildEnvelope(compiled, node);
    const envelopeValidation = validateMissionEnvelope(childEnvelope);
    if (!envelopeValidation.ok) {
      const first = envelopeValidation.errors[0]!;
      return {
        ok: false,
        errors: [error(first.code, `node ${JSON.stringify(node.nodeId)}: ${first.message}`)],
      };
    }
    const inputErrors = validateManualLoopInput(
      envelopeToRuntimeMissionRequest(envelopeValidation.value),
    ).errors;
    if (inputErrors.length > 0) {
      const first = inputErrors[0]!;
      return {
        ok: false,
        errors: [error(first.code, `node ${JSON.stringify(node.nodeId)}: ${first.message}`)],
      };
    }
  }

  const normalizedJson = canonicalEnvelopeJson(compiled as unknown as JsonValue);
  const graphHash = createHash("sha256").update(normalizedJson).digest("hex");
  return { ok: true, compiled, normalizedJson, graphHash };
}
