/**
 * Phase 2D durable mission graph journal.
 *
 * Owns the additive `operator_mission_graphs` / `_graph_nodes` /
 * `_graph_edges` / `_graph_events` tables: closed graph and node lifecycle
 * state machines, guarded compare-and-swap transitions, and one append-only
 * per-graph event journal (`UNIQUE(graph_id, sequence)`), mirroring the
 * accepted Phase 2C GenericMissionJournal semantics. Orchestration policy
 * lives in MissionGraphService; this module only guards durable truth.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { OperatorError } from "../services/operatorService.js";

export type MissionGraphState =
  | "approval_required"
  | "approved"
  | "running"
  | "completed"
  | "failed_recoverable"
  | "failed_terminal"
  | "cancelled";

export type MissionGraphNodeState =
  | "blocked"
  | "ready"
  | "running"
  | "completed"
  | "failed_recoverable"
  | "failed_terminal"
  | "cancelled";

export interface MissionGraphTypedError {
  code: string;
  message: string;
}

export interface MissionGraphRecord {
  graphId: string;
  traceId: string;
  idempotencyKey: string;
  schemaVersion: string;
  sourceSystem: string;
  requestedBy: string;
  tenantUserId: string;
  workspaceId: string | null;
  accountId: string | null;
  objective: string;
  compiledGraphJson: string;
  graphHash: string;
  nodeCount: number;
  status: MissionGraphState;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedGraphHash: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface MissionGraphNodeRecord {
  graphId: string;
  nodeId: string;
  product: string;
  action: string;
  objective: string;
  input: unknown;
  dependsOn: string[];
  childMissionId: string;
  childTraceId: string;
  childIdempotencyKey: string;
  status: MissionGraphNodeState;
  attempts: number;
  resultStatus: string | null;
  resultSummary: unknown | null;
  typedError: MissionGraphTypedError | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionGraphEdgeRecord {
  fromNodeId: string;
  toNodeId: string;
}

export interface MissionGraphEventRecord {
  eventId: string;
  graphId: string;
  sequence: number;
  scope: "graph" | "node";
  nodeId: string | null;
  eventType: string;
  previousState: string | null;
  newState: string | null;
  actor: string;
  reason: string;
  timestamp: string;
  evidenceReferences: string[];
  typedError: MissionGraphTypedError | null;
}

interface GraphRow {
  graph_id: string;
  trace_id: string;
  idempotency_key: string;
  schema_version: string;
  source_system: string;
  requested_by: string;
  tenant_user_id: string;
  workspace_id: string | null;
  account_id: string | null;
  objective: string;
  compiled_graph_json: string;
  graph_hash: string;
  node_count: number;
  status: MissionGraphState;
  approved_by: string | null;
  approved_at: string | null;
  approved_graph_hash: string | null;
  requested_at: string;
  created_at: string;
  updated_at: string;
}

interface NodeRow {
  graph_id: string;
  node_id: string;
  product: string;
  action: string;
  objective: string;
  input_json: string;
  depends_on_json: string;
  child_mission_id: string;
  child_trace_id: string;
  child_idempotency_key: string;
  status: MissionGraphNodeState;
  attempts: number;
  result_status: string | null;
  result_summary_json: string | null;
  typed_error_json: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  event_id: string;
  graph_id: string;
  sequence: number;
  scope: "graph" | "node";
  node_id: string | null;
  event_type: string;
  previous_state: string | null;
  new_state: string | null;
  actor: string;
  reason: string;
  timestamp: string;
  evidence_refs_json: string;
  typed_error_json: string | null;
}

const allowedGraphTransitions = new Map<MissionGraphState, ReadonlySet<MissionGraphState>>([
  ["approval_required", new Set(["approved", "cancelled"])],
  ["approved", new Set(["running", "cancelled"])],
  ["running", new Set(["completed", "failed_recoverable", "failed_terminal", "cancelled"])],
  ["failed_recoverable", new Set(["running", "failed_terminal", "cancelled"])],
  ["completed", new Set()],
  ["failed_terminal", new Set()],
  ["cancelled", new Set()],
]);

const allowedNodeTransitions = new Map<MissionGraphNodeState, ReadonlySet<MissionGraphNodeState>>([
  ["blocked", new Set(["ready", "cancelled"])],
  ["ready", new Set(["running", "cancelled"])],
  ["running", new Set(["completed", "failed_recoverable", "failed_terminal"])],
  ["failed_recoverable", new Set(["running", "failed_terminal", "cancelled"])],
  ["completed", new Set()],
  ["failed_terminal", new Set()],
  ["cancelled", new Set()],
]);

function parseJson<T>(value: string | null): T | null {
  return value ? (JSON.parse(value) as T) : null;
}

function mapGraph(row: GraphRow): MissionGraphRecord {
  return {
    graphId: row.graph_id,
    traceId: row.trace_id,
    idempotencyKey: row.idempotency_key,
    schemaVersion: row.schema_version,
    sourceSystem: row.source_system,
    requestedBy: row.requested_by,
    tenantUserId: row.tenant_user_id,
    workspaceId: row.workspace_id,
    accountId: row.account_id,
    objective: row.objective,
    compiledGraphJson: row.compiled_graph_json,
    graphHash: row.graph_hash,
    nodeCount: Number(row.node_count),
    status: row.status,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvedGraphHash: row.approved_graph_hash,
    requestedAt: row.requested_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapNode(row: NodeRow): MissionGraphNodeRecord {
  return {
    graphId: row.graph_id,
    nodeId: row.node_id,
    product: row.product,
    action: row.action,
    objective: row.objective,
    input: JSON.parse(row.input_json),
    dependsOn: JSON.parse(row.depends_on_json) as string[],
    childMissionId: row.child_mission_id,
    childTraceId: row.child_trace_id,
    childIdempotencyKey: row.child_idempotency_key,
    status: row.status,
    attempts: Number(row.attempts),
    resultStatus: row.result_status,
    resultSummary: parseJson(row.result_summary_json),
    typedError: parseJson<MissionGraphTypedError>(row.typed_error_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): MissionGraphEventRecord {
  return {
    eventId: row.event_id,
    graphId: row.graph_id,
    sequence: Number(row.sequence),
    scope: row.scope,
    nodeId: row.node_id,
    eventType: row.event_type,
    previousState: row.previous_state,
    newState: row.new_state,
    actor: row.actor,
    reason: row.reason,
    timestamp: row.timestamp,
    evidenceReferences: JSON.parse(row.evidence_refs_json) as string[],
    typedError: parseJson<MissionGraphTypedError>(row.typed_error_json),
  };
}

export interface MissionGraphInsertInput {
  graphId: string;
  traceId: string;
  idempotencyKey: string;
  schemaVersion: string;
  sourceSystem: string;
  requestedBy: string;
  tenantUserId: string;
  workspaceId: string | null;
  accountId: string | null;
  objective: string;
  compiledGraphJson: string;
  graphHash: string;
  requestedAt: string;
  timestamp: string;
  nodes: Array<{
    nodeId: string;
    product: string;
    action: string;
    objective: string;
    inputJson: string;
    dependsOn: string[];
    childMissionId: string;
    childTraceId: string;
    childIdempotencyKey: string;
  }>;
}

export interface MissionGraphEventInput {
  actor: string;
  reason: string;
  timestamp: string;
  evidenceReferences?: string[];
  typedError?: MissionGraphTypedError | null;
}

export interface MissionGraphNodeTransitionInput extends MissionGraphEventInput {
  attempts?: number;
  resultStatus?: string | null;
  resultSummary?: unknown | null;
}

export class MissionGraphJournal {
  constructor(
    private readonly database: DatabaseSync,
    private readonly idFactory: () => string = randomUUID,
  ) {}

  getGraph(graphId: string): MissionGraphRecord | null {
    const row = this.database
      .prepare("SELECT * FROM operator_mission_graphs WHERE graph_id = ?")
      .get(graphId) as GraphRow | undefined;
    return row ? mapGraph(row) : null;
  }

  getGraphBy(column: "trace_id" | "idempotency_key", value: string): MissionGraphRecord | null {
    const row = this.database
      .prepare(`SELECT * FROM operator_mission_graphs WHERE ${column} = ?`)
      .get(value) as GraphRow | undefined;
    return row ? mapGraph(row) : null;
  }

  requireGraph(graphId: string): MissionGraphRecord {
    const graph = this.getGraph(graphId);
    if (!graph) throw new OperatorError("Mission graph was not found.", 404);
    return graph;
  }

  listGraphs(limit: number): MissionGraphRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM operator_mission_graphs ORDER BY created_at DESC, graph_id DESC LIMIT ?",
      )
      .all(limit)
      .map((row) => mapGraph(row as unknown as GraphRow));
  }

  listNodes(graphId: string): MissionGraphNodeRecord[] {
    return this.database
      .prepare("SELECT * FROM operator_mission_graph_nodes WHERE graph_id = ? ORDER BY node_id ASC")
      .all(graphId)
      .map((row) => mapNode(row as unknown as NodeRow));
  }

  requireNode(graphId: string, nodeId: string): MissionGraphNodeRecord {
    const row = this.database
      .prepare("SELECT * FROM operator_mission_graph_nodes WHERE graph_id = ? AND node_id = ?")
      .get(graphId, nodeId) as NodeRow | undefined;
    if (!row) throw new OperatorError("Mission graph node was not found.", 404);
    return mapNode(row);
  }

  listEdges(graphId: string): MissionGraphEdgeRecord[] {
    return this.database
      .prepare(
        `SELECT from_node_id, to_node_id FROM operator_mission_graph_edges
          WHERE graph_id = ? ORDER BY from_node_id ASC, to_node_id ASC`,
      )
      .all(graphId)
      .map((row) => {
        const edge = row as { from_node_id: string; to_node_id: string };
        return { fromNodeId: edge.from_node_id, toNodeId: edge.to_node_id };
      });
  }

  listEvents(graphId: string): MissionGraphEventRecord[] {
    return this.database
      .prepare("SELECT * FROM operator_mission_graph_events WHERE graph_id = ? ORDER BY sequence ASC")
      .all(graphId)
      .map((row) => mapEvent(row as unknown as EventRow));
  }

  /** Durable graph create: graph row + node rows + edges + first event. */
  insertGraph(input: MissionGraphInsertInput): MissionGraphRecord {
    return this.withSavepoint(() => {
      this.database.prepare(
        `INSERT INTO operator_mission_graphs (
          graph_id, trace_id, idempotency_key, schema_version, source_system,
          requested_by, tenant_user_id, workspace_id, account_id, objective,
          compiled_graph_json, graph_hash, node_count, status,
          approval_required, approved_by, approved_at, approved_graph_hash,
          requested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approval_required', 1, NULL, NULL, NULL, ?, ?, ?)`,
      ).run(
        input.graphId,
        input.traceId,
        input.idempotencyKey,
        input.schemaVersion,
        input.sourceSystem,
        input.requestedBy,
        input.tenantUserId,
        input.workspaceId,
        input.accountId,
        input.objective,
        input.compiledGraphJson,
        input.graphHash,
        input.nodes.length,
        input.requestedAt,
        input.timestamp,
        input.timestamp,
      );
      const insertNode = this.database.prepare(
        `INSERT INTO operator_mission_graph_nodes (
          graph_id, node_id, product, action, objective, input_json,
          depends_on_json, child_mission_id, child_trace_id,
          child_idempotency_key, status, attempts, result_status,
          result_summary_json, typed_error_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'blocked', 0, NULL, NULL, NULL, ?, ?)`,
      );
      const insertEdge = this.database.prepare(
        `INSERT INTO operator_mission_graph_edges (graph_id, from_node_id, to_node_id)
         VALUES (?, ?, ?)`,
      );
      for (const node of input.nodes) {
        insertNode.run(
          input.graphId,
          node.nodeId,
          node.product,
          node.action,
          node.objective,
          node.inputJson,
          JSON.stringify(node.dependsOn),
          node.childMissionId,
          node.childTraceId,
          node.childIdempotencyKey,
          input.timestamp,
          input.timestamp,
        );
        for (const dependency of node.dependsOn) {
          insertEdge.run(input.graphId, dependency, node.nodeId);
        }
      }
      this.appendEvent(input.graphId, {
        scope: "graph",
        nodeId: null,
        eventType: "graph_compiled_and_persisted",
        previousState: null,
        newState: "approval_required",
        actor: input.requestedBy,
        reason: "Compiled graph persisted durably; explicit control approval of the exact graph hash is required.",
        timestamp: input.timestamp,
        evidenceReferences: [`graph:${input.graphId}`, `graph-sha256:${input.graphHash}`],
      });
      return this.requireGraph(input.graphId);
    });
  }

  /** Guarded graph state transition with an appended journal event. */
  transitionGraph(
    graphId: string,
    newState: MissionGraphState,
    options: MissionGraphEventInput & {
      approvedBy?: string;
      approvedAt?: string;
      approvedGraphHash?: string;
    },
  ): MissionGraphRecord {
    const current = this.requireGraph(graphId);
    if (!allowedGraphTransitions.get(current.status)?.has(newState)) {
      throw new OperatorError(
        `Invalid durable mission graph transition ${current.status} -> ${newState}.`,
        409,
        "GRAPH_JOURNAL_INVALID_TRANSITION",
      );
    }
    return this.withSavepoint(() => {
      const update = options.approvedBy !== undefined
        ? this.database.prepare(
          `UPDATE operator_mission_graphs
             SET status = ?, approved_by = ?, approved_at = ?, approved_graph_hash = ?, updated_at = ?
           WHERE graph_id = ? AND status = ?`,
        ).run(
          newState,
          options.approvedBy,
          options.approvedAt ?? options.timestamp,
          options.approvedGraphHash ?? current.graphHash,
          options.timestamp,
          graphId,
          current.status,
        )
        : this.database.prepare(
          `UPDATE operator_mission_graphs SET status = ?, updated_at = ?
           WHERE graph_id = ? AND status = ?`,
        ).run(newState, options.timestamp, graphId, current.status);
      if (Number(update.changes) !== 1) {
        throw new OperatorError(
          "Durable mission graph state changed before the transition could be recorded.",
          409,
          "GRAPH_JOURNAL_CONCURRENT_TRANSITION",
        );
      }
      this.appendEvent(graphId, {
        scope: "graph",
        nodeId: null,
        eventType: `graph_${newState}`,
        previousState: current.status,
        newState,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
      return this.requireGraph(graphId);
    });
  }

  /** Guarded node state transition with an appended journal event. */
  transitionNode(
    graphId: string,
    nodeId: string,
    newState: MissionGraphNodeState,
    options: MissionGraphNodeTransitionInput,
  ): MissionGraphNodeRecord {
    const current = this.requireNode(graphId, nodeId);
    if (!allowedNodeTransitions.get(current.status)?.has(newState)) {
      throw new OperatorError(
        `Invalid durable graph node transition ${current.status} -> ${newState} for node ${nodeId}.`,
        409,
        "GRAPH_JOURNAL_INVALID_NODE_TRANSITION",
      );
    }
    return this.withSavepoint(() => {
      const update = this.database.prepare(
        `UPDATE operator_mission_graph_nodes
           SET status = ?, attempts = ?, result_status = ?, result_summary_json = ?,
               typed_error_json = ?, updated_at = ?
         WHERE graph_id = ? AND node_id = ? AND status = ?`,
      ).run(
        newState,
        options.attempts ?? current.attempts,
        options.resultStatus === undefined ? current.resultStatus : options.resultStatus,
        options.resultSummary === undefined
          ? (current.resultSummary === null ? null : JSON.stringify(current.resultSummary))
          : (options.resultSummary === null ? null : JSON.stringify(options.resultSummary)),
        options.typedError === undefined
          ? (current.typedError ? JSON.stringify(current.typedError) : null)
          : (options.typedError ? JSON.stringify(options.typedError) : null),
        options.timestamp,
        graphId,
        nodeId,
        current.status,
      );
      if (Number(update.changes) !== 1) {
        throw new OperatorError(
          "Durable graph node state changed before the transition could be recorded.",
          409,
          "GRAPH_JOURNAL_CONCURRENT_TRANSITION",
        );
      }
      this.appendEvent(graphId, {
        scope: "node",
        nodeId,
        eventType: `node_${newState}`,
        previousState: current.status,
        newState,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
      return this.requireNode(graphId, nodeId);
    });
  }

  /** Append a non-transition audit event (e.g. an exact approval replay). */
  appendAuditEvent(
    graphId: string,
    eventType: string,
    options: MissionGraphEventInput & { nodeId?: string | null },
  ): void {
    const graph = this.requireGraph(graphId);
    this.withSavepoint(() => {
      this.appendEvent(graphId, {
        scope: options.nodeId ? "node" : "graph",
        nodeId: options.nodeId ?? null,
        eventType,
        previousState: graph.status,
        newState: graph.status,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      });
    });
  }

  /** Atomic insert-or-read for the one authoritative submission replay event. */
  appendAuthoritativeReplayEvent(
    graphId: string,
    replayIdentity: string,
    options: MissionGraphEventInput,
  ): MissionGraphEventRecord {
    const graph = this.requireGraph(graphId);
    return this.withSavepoint(() => {
      const existing = this.database.prepare(`
        SELECT e.*
          FROM operator_mission_graph_replays r
          JOIN operator_mission_graph_events e ON e.event_id = r.event_id
         WHERE r.graph_id = ? AND r.event_type = 'graph_submission_replayed' AND r.replay_identity = ?
      `).get(graphId, replayIdentity) as EventRow | undefined;
      if (existing) return mapEvent(existing);
      const eventId = this.idFactory();
      this.appendEvent(graphId, {
        scope: "graph",
        nodeId: null,
        eventType: "graph_submission_replayed",
        previousState: graph.status,
        newState: graph.status,
        actor: options.actor,
        reason: options.reason,
        timestamp: options.timestamp,
        evidenceReferences: options.evidenceReferences ?? [],
        typedError: options.typedError ?? null,
      }, eventId);
      this.database.prepare(`
        INSERT INTO operator_mission_graph_replays (
          graph_id, event_type, replay_identity, event_id, created_at
        ) VALUES (?, 'graph_submission_replayed', ?, ?, ?)
      `).run(graphId, replayIdentity, eventId, options.timestamp);
      const created = this.database.prepare(
        "SELECT * FROM operator_mission_graph_events WHERE event_id = ?",
      ).get(eventId) as unknown as EventRow;
      return mapEvent(created);
    });
  }

  private appendEvent(
    graphId: string,
    event: {
      scope: "graph" | "node";
      nodeId: string | null;
      eventType: string;
      previousState: string | null;
      newState: string | null;
      actor: string;
      reason: string;
      timestamp: string;
      evidenceReferences?: string[];
      typedError?: MissionGraphTypedError | null;
    },
    eventId = this.idFactory(),
  ): void {
    const sequenceRow = this.database
      .prepare(
        "SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM operator_mission_graph_events WHERE graph_id = ?",
      )
      .get(graphId) as { next_sequence: number };
    this.database.prepare(
      `INSERT INTO operator_mission_graph_events (
        event_id, graph_id, sequence, scope, node_id, event_type,
        previous_state, new_state, actor, reason, timestamp,
        evidence_refs_json, typed_error_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      eventId,
      graphId,
      Number(sequenceRow.next_sequence),
      event.scope,
      event.nodeId,
      event.eventType,
      event.previousState,
      event.newState,
      event.actor,
      event.reason,
      event.timestamp,
      JSON.stringify(event.evidenceReferences ?? []),
      event.typedError ? JSON.stringify(event.typedError) : null,
    );
  }

  private withSavepoint<T>(operation: () => T): T {
    this.database.exec("SAVEPOINT mission_graph_journal_atomic");
    try {
      const result = operation();
      this.database.exec("RELEASE SAVEPOINT mission_graph_journal_atomic");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK TO SAVEPOINT mission_graph_journal_atomic");
      this.database.exec("RELEASE SAVEPOINT mission_graph_journal_atomic");
      throw error;
    }
  }
}
