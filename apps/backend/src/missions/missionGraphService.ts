/**
 * Phase 2D durable mission graph authority.
 *
 * One Operator-owned orchestration layer over reviewed durable child mission
 * authorities. The graph layer never executes anything itself and never talks
 * to a downstream port: each node materializes with deterministic child
 * identity through the closed-world dispatcher, then runs through its existing
 * mission journal, ledger lineage, crash boundaries, and bounded retry. What
 * this service adds — and all it adds — is:
 *
 *   deterministic compilation (chanter.mission.graph.v1 -> hash)
 *   -> durable graph/node/edge/event persistence (approval_required)
 *   -> independent control approval bound to the exact graph hash
 *   -> bounded dependency-aware scheduling (a node runs only after every
 *      dependency completed; recoverable failure keeps dependents blocked;
 *      terminal failure deterministically terminates the graph)
 *   -> restart-safe resume derived from canonical durable state.
 */
import { createHash } from "node:crypto";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { validateMissionEnvelope } from "chanter-agent-runtime";
import { withTransaction } from "../db/database.js";
import { OperatorError } from "../services/operatorService.js";
import {
  MissionGraphChildDispatcher,
  type MissionGraphChildMission,
  type MissionGraphChildReference,
} from "./missionGraphChildDispatcher.js";
import {
  compileMissionGraph,
  missionGraphChildEnvelope,
  missionGraphChildIdempotencyKey,
  missionGraphChildMissionId,
  missionGraphChildTraceId,
  type CompiledMissionGraph,
} from "./missionGraphCompiler.js";
import {
  MissionGraphJournal,
  type MissionGraphEdgeRecord,
  type MissionGraphEventRecord,
  type MissionGraphNodeRecord,
  type MissionGraphNodeState,
  type MissionGraphRecord,
  type MissionGraphState,
  type MissionGraphTypedError,
} from "./missionGraphJournal.js";

const ACTOR_ID = "chanter-operator";
const MAX_ACTOR_LENGTH = 120;
const MAX_NODE_ATTEMPTS = 3;
const GRAPH_HASH_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Child-mission refusals that no amount of retrying can change: the durable
 * identity or payload binding itself conflicts. Everything else stays
 * recoverable and is resolved through resume / child-level reconciliation.
 */
const TERMINAL_CHILD_ERROR_CODES = new Set([
  "OPERATOR_IDEMPOTENCY_MISMATCH",
  "OPERATOR_TRACE_MISMATCH",
  "OPERATOR_MISSION_SCOPE_MISMATCH",
  "OPERATOR_MISSION_PAYLOAD_MISMATCH",
  "OPERATOR_MISSION_TARGET_MISMATCH",
  "OPERATOR_MISSION_IDENTITY_INVALID",
  "OPERATOR_APPROVAL_BINDING_MISMATCH",
  "GRAPH_CHILD_ENVELOPE_INVALID",
  "GRAPH_CHILD_AUTHORITY_UNREGISTERED",
  "GRAPH_CHILD_IDENTITY_MISMATCH",
  "GRAPH_AUTOPOSTER_RESULT_UNSAFE",
]);

export type MissionGraphFailureBoundary =
  | "after_graph_approval_persistence"
  | "after_node_running_persistence"
  | "after_child_mission_created"
  | "after_node_completed_persistence";

interface MissionGraphServiceOptions {
  now?: () => Date;
  idFactory?: () => string;
  protectedValues?: string[];
  failureInjector?: (
    boundary: MissionGraphFailureBoundary,
    graphId: string,
    nodeId: string | null,
  ) => void;
  /**
   * Phase 2E-C: durable observation scheduling for completed AutoPoster
   * schedule nodes. The hook is fire-and-forget from the graph authority's
   * perspective — it must never mutate graph truth and never throw back
   * into the scheduler (interrupted scheduling is recreated by the bounded
   * observation-batch backfill).
   */
  observationScheduler?: {
    onAutoPosterNodeCompleted(graphId: string, nodeId: string): void;
  };
}

export interface MissionGraphNodeChildSummary {
  status: string;
  executionState: string | null;
  nextPermittedActions: string[];
  downstreamIds: unknown | null;
  retryCount: number | null;
}

export interface MissionGraphNodeView {
  nodeId: string;
  product: string;
  action: string;
  objective: string;
  dependsOn: string[];
  childMissionId: string;
  childTraceId: string;
  childIdempotencyKey: string;
  status: MissionGraphNodeState;
  attempts: number;
  resultStatus: string | null;
  resultSummary: unknown | null;
  typedError: MissionGraphTypedError | null;
  childMission: MissionGraphNodeChildSummary | null;
  createdAt: string;
  updatedAt: string;
}

export interface MissionGraphView {
  replayed: boolean;
  graphId: string;
  traceId: string;
  idempotencyKey: string;
  schemaVersion: string;
  source: { system: string; requestedBy: string };
  objective: string;
  tenant: { userId: string; workspaceId: string | null; accountId: string | null };
  graphHash: string;
  status: MissionGraphState;
  approvalRequired: true;
  approvedBy: string | null;
  approvedAt: string | null;
  approvedGraphHash: string | null;
  requestedAt: string;
  createdAt: string;
  updatedAt: string;
  nodeCount: number;
  normalizedGraph: CompiledMissionGraph;
  nodes: MissionGraphNodeView[];
  edges: Array<{ fromNodeId: string; toNodeId: string }>;
  events: MissionGraphEventRecord[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class MissionGraphService {
  private readonly now: () => Date;
  private readonly journal: MissionGraphJournal;
  private readonly protectedValues: string[];
  private readonly failureInjector?: MissionGraphServiceOptions["failureInjector"];
  private readonly observationScheduler?: MissionGraphServiceOptions["observationScheduler"];

  constructor(
    private readonly database: DatabaseSync,
    private readonly children: MissionGraphChildDispatcher,
    options: MissionGraphServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.journal = new MissionGraphJournal(database, options.idFactory ?? randomUUID);
    this.failureInjector = options.failureInjector;
    this.observationScheduler = options.observationScheduler;
    this.protectedValues = (options.protectedValues ?? [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  hasGraph(graphId: string): boolean {
    const normalized = String(graphId || "").trim();
    return Boolean(normalized && this.journal.getGraph(normalized));
  }

  getGraph(graphId: string): MissionGraphView {
    const graph = this.journal.requireGraph(String(graphId || "").trim());
    return this.buildView(graph);
  }

  listGraphs(limit = 50): MissionGraphView[] {
    const boundedLimit = Math.max(1, Math.min(Number.isFinite(limit) ? Math.trunc(limit) : 50, 100));
    return this.journal.listGraphs(boundedLimit).map((graph) => this.buildView(graph));
  }

  // -------------------------------------------------------------------------
  // Durable submission (compiles, persists, never approves, never executes)
  // -------------------------------------------------------------------------

  submitGraph(envelope: unknown): MissionGraphView {
    const result = compileMissionGraph(envelope);
    if (!result.ok) {
      const first = result.errors[0]!;
      throw new OperatorError(first.message, first.status, first.code);
    }
    const { compiled, normalizedJson, graphHash } = result;
    this.assertContainsNoProtectedValue([normalizedJson]);

    const existing = this.journal.getGraph(compiled.graphId);
    if (existing) {
      this.assertExistingSubmitBinding(existing, compiled, graphHash);
      this.journal.appendAuthoritativeReplayEvent(
        existing.graphId,
        `${existing.graphHash}:${existing.idempotencyKey}`,
        {
          actor: compiled.source.requestedBy,
          reason: "Exact graph submission replay returned the existing authoritative graph identity without execution.",
          timestamp: this.now().toISOString(),
          evidenceReferences: [
            `graph:${existing.graphId}`,
            `graph-sha256:${existing.graphHash}`,
            `idempotency-key:${existing.idempotencyKey}`,
          ],
        },
      );
      return this.buildView(this.journal.requireGraph(existing.graphId), true);
    }

    const timestamp = this.now().toISOString();
    const created = withTransaction(this.database, () => {
      const raced = this.journal.getGraph(compiled.graphId);
      if (raced) {
        this.assertExistingSubmitBinding(raced, compiled, graphHash);
        return { graphId: raced.graphId, replayed: true };
      }
      this.assertIdentifiersAvailable(compiled);
      this.journal.insertGraph({
        graphId: compiled.graphId,
        traceId: compiled.traceId,
        idempotencyKey: compiled.idempotencyKey,
        schemaVersion: compiled.schemaVersion,
        sourceSystem: compiled.source.system,
        requestedBy: compiled.source.requestedBy,
        tenantUserId: compiled.tenant.userId,
        workspaceId: compiled.tenant.workspaceId,
        accountId: compiled.tenant.accountId,
        objective: compiled.objective,
        compiledGraphJson: normalizedJson,
        graphHash,
        requestedAt: compiled.requestedAt,
        timestamp,
        nodes: compiled.nodes.map((node) => ({
          nodeId: node.nodeId,
          product: node.target.product,
          action: node.target.action,
          objective: node.objective,
          inputJson: JSON.stringify(node.input),
          dependsOn: node.dependsOn,
          childMissionId: missionGraphChildMissionId(compiled.graphId, node.nodeId),
          childTraceId: missionGraphChildTraceId(compiled.traceId, node.nodeId),
          childIdempotencyKey: missionGraphChildIdempotencyKey(compiled.graphId, node.nodeId),
        })),
      });
      return { graphId: compiled.graphId, replayed: false };
    });
    if (created.replayed) {
      const raced = this.journal.requireGraph(created.graphId);
      this.journal.appendAuthoritativeReplayEvent(
        raced.graphId,
        `${raced.graphHash}:${raced.idempotencyKey}`,
        {
          actor: compiled.source.requestedBy,
          reason: "Exact concurrent graph submission replay returned the existing authoritative graph identity without execution.",
          timestamp: this.now().toISOString(),
          evidenceReferences: [
            `graph:${raced.graphId}`,
            `graph-sha256:${raced.graphHash}`,
            `idempotency-key:${raced.idempotencyKey}`,
          ],
        },
      );
    }
    return this.buildView(this.journal.requireGraph(created.graphId), created.replayed);
  }

  // -------------------------------------------------------------------------
  // Control approval bound to the exact immutable graph hash
  // -------------------------------------------------------------------------

  async approveGraph(
    graphId: string,
    body: { approvedBy?: unknown; graphHash?: unknown },
  ): Promise<MissionGraphView> {
    const approvedBy = typeof body.approvedBy === "string" ? body.approvedBy.trim() : "";
    if (!approvedBy || approvedBy.length > MAX_ACTOR_LENGTH) {
      throw new OperatorError(
        `approvedBy is required and must be at most ${MAX_ACTOR_LENGTH} characters.`,
        400,
      );
    }
    this.assertContainsNoProtectedValue([approvedBy]);
    const suppliedHash = typeof body.graphHash === "string" ? body.graphHash.trim() : "";
    if (!GRAPH_HASH_PATTERN.test(suppliedHash)) {
      throw new OperatorError(
        "graphHash is required and must be the exact 64-hex compiled graph hash.",
        400,
        "OPERATOR_GRAPH_APPROVAL_HASH_REQUIRED",
      );
    }

    const graph = this.journal.requireGraph(String(graphId || "").trim());
    this.assertGraphIntegrity(graph);
    if (suppliedHash !== graph.graphHash) {
      throw new OperatorError(
        "The supplied graph hash does not match the immutable compiled graph.",
        409,
        "OPERATOR_GRAPH_APPROVAL_HASH_MISMATCH",
      );
    }

    if (graph.status === "cancelled" || graph.status === "failed_terminal") {
      throw new OperatorError(
        `Mission graph cannot be approved from terminal status ${graph.status}.`,
        409,
        "OPERATOR_GRAPH_STATE_TERMINAL",
      );
    }

    if (graph.status !== "approval_required") {
      // Approval replay: the identity and basis must match the durable
      // binding exactly; a completed graph returns its authoritative result.
      if (graph.approvedBy !== approvedBy || graph.approvedGraphHash !== suppliedHash) {
        throw new OperatorError(
          "Replay approval identity does not match the durable approval binding.",
          409,
          "OPERATOR_GRAPH_APPROVAL_BINDING_MISMATCH",
        );
      }
      if (graph.status === "completed") {
        this.journal.appendAuditEvent(graph.graphId, "graph_approval_replayed", {
          actor: approvedBy,
          reason: "Exact approval replay returned the existing authoritative graph result without execution.",
          timestamp: this.now().toISOString(),
          evidenceReferences: [`graph:${graph.graphId}`, `graph-sha256:${graph.graphHash}`],
        });
        return this.buildView(this.journal.requireGraph(graph.graphId), true);
      }
      if (graph.status === "approved" || graph.status === "running") {
        await this.runScheduler(graph.graphId);
      }
      // failed_recoverable: approval replay reports state; recovery is the
      // explicit resume control action, never an approval side effect.
      return this.buildView(this.journal.requireGraph(graph.graphId), true);
    }

    const approvedAt = this.now().toISOString();
    this.journal.transitionGraph(graph.graphId, "approved", {
      actor: approvedBy,
      reason: "Founder control approval was durably bound to the exact compiled graph hash.",
      timestamp: approvedAt,
      approvedBy,
      approvedAt,
      approvedGraphHash: graph.graphHash,
      evidenceReferences: [
        `approval:${approvedBy}`,
        `graph-sha256:${graph.graphHash}`,
      ],
    });
    this.injectFailure("after_graph_approval_persistence", graph.graphId, null);

    await this.runScheduler(graph.graphId);
    return this.buildView(this.journal.requireGraph(graph.graphId));
  }

  // -------------------------------------------------------------------------
  // Restart-safe resume (control capability)
  // -------------------------------------------------------------------------

  async resumeGraph(graphId: string): Promise<MissionGraphView> {
    const graph = this.journal.requireGraph(String(graphId || "").trim());
    if (graph.status === "approval_required") {
      throw new OperatorError(
        "Mission graph is awaiting approval; resume cannot bypass approval.",
        409,
        "OPERATOR_GRAPH_APPROVAL_REQUIRED",
      );
    }
    if (
      graph.status === "completed"
      || graph.status === "cancelled"
      || graph.status === "failed_terminal"
    ) {
      throw new OperatorError(
        `Mission graph cannot resume from terminal status ${graph.status}.`,
        409,
        "OPERATOR_GRAPH_RECOVERY_NOT_PERMITTED",
      );
    }
    this.assertGraphIntegrity(graph);
    if (!graph.approvedBy || !graph.approvedGraphHash) {
      throw new OperatorError(
        "Mission graph approval is missing; recovery cannot bypass approval.",
        409,
        "OPERATOR_GRAPH_APPROVAL_REQUIRED",
      );
    }

    if (graph.status === "failed_recoverable") {
      this.journal.transitionGraph(graph.graphId, "running", {
        actor: ACTOR_ID,
        reason: "Operator claimed one bounded graph recovery pass under the durable approval.",
        timestamp: this.now().toISOString(),
        evidenceReferences: [`approval:${graph.approvedBy}`],
      });
    }

    // Bounded recovery pass: resolve every interrupted or recoverable node
    // once from canonical durable child truth, then re-enter the scheduler.
    const current = this.journal.requireGraph(graph.graphId);
    for (const node of this.journal.listNodes(graph.graphId)) {
      if (node.status === "running") {
        await this.recoverRunningNode(current, node);
      } else if (node.status === "failed_recoverable") {
        if (node.attempts >= MAX_NODE_ATTEMPTS) {
          this.journal.transitionNode(graph.graphId, node.nodeId, "failed_terminal", {
            actor: ACTOR_ID,
            reason: "The bounded graph-level dispatch budget for this node is exhausted.",
            timestamp: this.now().toISOString(),
            typedError: {
              code: "GRAPH_NODE_ATTEMPTS_EXHAUSTED",
              message: `Node ${node.nodeId} exhausted its ${MAX_NODE_ATTEMPTS} bounded dispatch attempts.`,
            },
          });
          continue;
        }
        this.journal.transitionNode(graph.graphId, node.nodeId, "running", {
          actor: ACTOR_ID,
          reason: "Operator claimed one bounded node recovery attempt.",
          timestamp: this.now().toISOString(),
          attempts: node.attempts + 1,
          typedError: null,
          evidenceReferences: [`child-mission:${node.childMissionId}`],
        });
        await this.recoverRunningNode(current, this.journal.requireNode(graph.graphId, node.nodeId));
      }
    }

    await this.runScheduler(graph.graphId);
    return this.buildView(this.journal.requireGraph(graph.graphId));
  }

  // -------------------------------------------------------------------------
  // Cancellation (control capability)
  // -------------------------------------------------------------------------

  cancelGraph(graphId: string, body: { cancelledBy?: unknown; reason?: unknown }): MissionGraphView {
    const cancelledBy = typeof body.cancelledBy === "string" ? body.cancelledBy.trim() : "";
    if (!cancelledBy || cancelledBy.length > MAX_ACTOR_LENGTH) {
      throw new OperatorError(
        `cancelledBy is required and must be at most ${MAX_ACTOR_LENGTH} characters.`,
        400,
      );
    }
    this.assertContainsNoProtectedValue([cancelledBy]);
    const reason = typeof body.reason === "string" && body.reason.trim()
      ? body.reason.trim().slice(0, 500)
      : "A human cancelled the mission graph before completion.";
    this.assertContainsNoProtectedValue([reason]);

    const graph = this.journal.requireGraph(String(graphId || "").trim());
    if (
      graph.status === "completed"
      || graph.status === "cancelled"
      || graph.status === "failed_terminal"
    ) {
      throw new OperatorError(
        `Mission graph cannot be cancelled from terminal status ${graph.status}.`,
        409,
        "OPERATOR_GRAPH_STATE_TERMINAL",
      );
    }
    const nodes = this.journal.listNodes(graph.graphId);
    if (nodes.some((node) => node.status === "running")) {
      throw new OperatorError(
        "Mission graph has a running node; recover or complete it before cancelling.",
        409,
        "OPERATOR_GRAPH_CANCEL_BLOCKED",
      );
    }

    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      for (const node of nodes) {
        if (node.status === "blocked" || node.status === "ready" || node.status === "failed_recoverable") {
          this.journal.transitionNode(graph.graphId, node.nodeId, "cancelled", {
            actor: cancelledBy,
            reason,
            timestamp,
          });
        }
      }
      this.journal.transitionGraph(graph.graphId, "cancelled", {
        actor: cancelledBy,
        reason,
        timestamp,
        evidenceReferences: [`cancellation:${cancelledBy}`],
      });
    });
    return this.buildView(this.journal.requireGraph(graph.graphId));
  }

  // -------------------------------------------------------------------------
  // Bounded dependency-aware scheduler
  // -------------------------------------------------------------------------

  private async runScheduler(graphId: string): Promise<void> {
    const bound = this.journal.requireGraph(graphId).nodeCount + 1;
    for (let pass = 0; pass < bound; pass += 1) {
      let graph = this.journal.requireGraph(graphId);
      if (graph.status === "approved") {
        graph = this.journal.transitionGraph(graphId, "running", {
          actor: ACTOR_ID,
          reason: "Dependency-aware node scheduling began under the durable approval.",
          timestamp: this.now().toISOString(),
          evidenceReferences: [`approval:${graph.approvedBy ?? ""}`],
        });
      }
      if (graph.status !== "running") return;

      // Re-derive interrupted node truth read-only before every pass.
      for (const node of this.journal.listNodes(graphId)) {
        if (node.status === "running") this.syncNodeFromChildTruth(graph, node);
      }

      const nodes = this.journal.listNodes(graphId);
      const terminalNode = nodes.find((node) => node.status === "failed_terminal");
      if (terminalNode) {
        this.terminateGraphForNode(graph, terminalNode);
        return;
      }
      if (nodes.some((node) => node.status === "failed_recoverable")) {
        this.journal.transitionGraph(graphId, "failed_recoverable", {
          actor: ACTOR_ID,
          reason: "A node failed recoverably; dependents stay blocked until an explicit resume.",
          timestamp: this.now().toISOString(),
        });
        return;
      }
      if (nodes.some((node) => node.status === "running")) {
        // An interrupted child needs child-level reconciliation first; the
        // graph stays running and resume drives the bounded recovery.
        return;
      }
      if (nodes.every((node) => node.status === "completed")) {
        const completionReason = nodes.every((node) => node.product === "auto_poster")
          ? "Every requested AutoPoster queue draft was durably scheduled and remains unapproved."
          : "Every node completed with an authoritative child mission result.";
        this.journal.transitionGraph(graphId, "completed", {
          actor: ACTOR_ID,
          reason: completionReason,
          timestamp: this.now().toISOString(),
          evidenceReferences: nodes.map((node) => `child-mission:${node.childMissionId}`),
        });
        return;
      }

      const completed = new Set(
        nodes.filter((node) => node.status === "completed").map((node) => node.nodeId),
      );
      const ready = nodes
        .filter((node) => node.status === "blocked"
          && node.dependsOn.every((dependency) => completed.has(dependency)))
        .sort((left, right) => (left.nodeId < right.nodeId ? -1 : 1));
      if (ready.length === 0) return;

      for (const node of ready) {
        await this.dispatchNode(this.journal.requireGraph(graphId), node);
        const after = this.journal.requireNode(graphId, node.nodeId);
        if (after.status === "failed_terminal") {
          this.terminateGraphForNode(this.journal.requireGraph(graphId), after);
          return;
        }
        if (after.status === "failed_recoverable") {
          this.journal.transitionGraph(graphId, "failed_recoverable", {
            actor: ACTOR_ID,
            reason: "A node failed recoverably; dependents stay blocked until an explicit resume.",
            timestamp: this.now().toISOString(),
            typedError: after.typedError,
          });
          return;
        }
      }
    }
  }

  private async dispatchNode(
    graph: MissionGraphRecord,
    node: MissionGraphNodeRecord,
  ): Promise<void> {
    this.journal.transitionNode(graph.graphId, node.nodeId, "ready", {
      actor: ACTOR_ID,
      reason: node.dependsOn.length > 0
        ? `Every dependency completed: ${node.dependsOn.join(", ")}.`
        : "The node has no dependencies.",
      timestamp: this.now().toISOString(),
      evidenceReferences: node.dependsOn.map((dependency) => `node:${dependency}`),
    });
    this.journal.transitionNode(graph.graphId, node.nodeId, "running", {
      actor: ACTOR_ID,
      reason: node.product === "auto_poster"
        ? "The node was dispatched to the reviewed AutoPoster schedule-draft mission spine."
        : "The node was dispatched to the Phase 2C generic mission spine.",
      timestamp: this.now().toISOString(),
      attempts: node.attempts + 1,
      evidenceReferences: [`child-mission:${node.childMissionId}`],
    });
    this.injectFailure("after_node_running_persistence", graph.graphId, node.nodeId);
    await this.executeChildMission(graph, this.journal.requireNode(graph.graphId, node.nodeId));
  }

  /**
   * Materialize and drive one node's child mission through the existing
   * Phase 2C spine. Every submission field is a pure function of durable
   * graph state, so a replayed dispatch reconstructs a byte-identical child
   * envelope and the durable create replays instead of duplicating.
   */
  private async executeChildMission(
    graph: MissionGraphRecord,
    node: MissionGraphNodeRecord,
  ): Promise<void> {
    try {
      const compiled = this.parseCompiledGraph(graph);
      const compiledNode = compiled.nodes.find((entry) => entry.nodeId === node.nodeId);
      if (!compiledNode) {
        throw new OperatorError(
          `The immutable compiled graph has no node ${node.nodeId}.`,
          409,
          "GRAPH_CHILD_ENVELOPE_INVALID",
        );
      }
      const childEnvelope = missionGraphChildEnvelope(compiled, compiledNode);
      const validation = validateMissionEnvelope(childEnvelope);
      if (!validation.ok) {
        throw new OperatorError(
          validation.errors[0]?.message ?? "The reconstructed child envelope is invalid.",
          409,
          "GRAPH_CHILD_ENVELOPE_INVALID",
        );
      }
      await this.children.createMissionFromEnvelope(validation.value);
      this.injectFailure("after_child_mission_created", graph.graphId, node.nodeId);
      const mission = await this.children.approveAndExecute(
        this.childReference(node),
        graph.approvedBy ?? "",
      );
      this.applyChildOutcome(graph, node.nodeId, mission);
    } catch (error) {
      this.recordChildDispatchError(graph, node.nodeId, error);
    }
  }

  /**
   * Bounded single-pass recovery of one running node from canonical child
   * mission truth, reusing the proven Phase 2C reconcile / resume machinery.
   * Anything still unresolved after one pass parks the node as
   * failed_recoverable for the next explicit resume (or child-level control).
   */
  private async recoverRunningNode(
    graph: MissionGraphRecord,
    node: MissionGraphNodeRecord,
  ): Promise<void> {
    const reference = this.childReference(node);
    if (!this.children.hasMission(reference)) {
      // Crash landed between the node running boundary and the durable child
      // create: the deterministic envelope makes re-dispatch exactly safe.
      await this.executeChildMission(graph, node);
      return;
    }
    try {
      let mission = this.children.getMission(reference);
      let state = mission.executionState;
      if (state === "approval_required") {
        mission = await this.children.approveAndExecute(reference, graph.approvedBy ?? "");
        this.applyChildOutcome(graph, node.nodeId, mission);
        return;
      }
      if (state === "completed") {
        this.applyChildOutcome(graph, node.nodeId, mission);
        return;
      }
      if (
        state === "approved"
        || state === "downstream_result_observed"
        || state === "result_persisted"
      ) {
        // Safe resumes: zero or replay-only downstream interaction.
        mission = await this.children.resumeSafely(reference);
        this.applyChildOutcome(graph, node.nodeId, mission);
        return;
      }
      if (
        state === "execution_started"
        || state === "downstream_request_prepared"
        || state === "failed_recoverable"
      ) {
        mission = await this.children.reconcileMission(reference);
        state = mission.executionState;
        const canResume = mission.nextPermittedActions.includes("Resume safely");
        if (
          (state === "downstream_result_observed" || state === "failed_recoverable")
          && canResume
        ) {
          mission = await this.children.resumeSafely(reference);
        }
        this.applyChildOutcome(graph, node.nodeId, mission);
        return;
      }
      // reconciliation_required / recovery_in_progress and any other durable
      // state require explicit child-level control decisions.
      this.applyChildOutcome(graph, node.nodeId, mission);
    } catch (error) {
      this.recordChildDispatchError(graph, node.nodeId, error);
    }
  }

  /** Read-only projection of child truth onto an interrupted running node. */
  private syncNodeFromChildTruth(
    graph: MissionGraphRecord,
    node: MissionGraphNodeRecord,
  ): void {
    try {
      const reference = this.childReference(node);
      if (!this.children.hasMission(reference)) return;
      const mission = this.children.getMission(reference);
      const state = mission.executionState;
      if (
        state === "completed"
        || state === "failed_terminal"
        || state === "failed_recoverable"
        || state === "reconciliation_required"
      ) {
        this.applyChildOutcome(graph, node.nodeId, mission);
      }
    } catch (error) {
      this.recordChildDispatchError(graph, node.nodeId, error);
    }
  }

  private applyChildOutcome(
    graph: MissionGraphRecord,
    nodeId: string,
    mission: MissionGraphChildMission,
  ): void {
    const node = this.journal.requireNode(graph.graphId, nodeId);
    if (node.status !== "running") return;
    const state = mission.executionState;
    const timestamp = this.now().toISOString();

    if (
      mission.outcome === "completed"
    ) {
      this.journal.transitionNode(graph.graphId, nodeId, "completed", {
        actor: ACTOR_ID,
        reason: mission.lane === "autoposter_legacy"
          ? "The AutoPoster child mission completed with one authoritative unapproved scheduled queue draft."
          : "The child mission completed with an authoritative durable result.",
        timestamp,
        resultStatus: mission.status,
        resultSummary: mission.resultSummary,
        typedError: null,
        evidenceReferences: mission.evidenceReferences,
      });
      this.injectFailure("after_node_completed_persistence", graph.graphId, nodeId);
      if (node.product === "auto_poster" && this.observationScheduler) {
        // Phase 2E-C: the durably completed schedule node gets exactly one
        // idempotent observation job; the hook never throws into the graph.
        this.observationScheduler.onAutoPosterNodeCompleted(graph.graphId, nodeId);
      }
      return;
    }

    if (mission.outcome === "failed_terminal") {
      this.journal.transitionNode(graph.graphId, nodeId, "failed_terminal", {
        actor: ACTOR_ID,
        reason: "The child mission reached a deterministic terminal failure.",
        timestamp,
        resultStatus: mission.status,
        typedError: mission.typedError ?? {
          code: "GRAPH_CHILD_FAILED_TERMINAL",
          message: "The child mission failed terminally without a typed error.",
        },
        evidenceReferences: [`child-mission:${mission.missionId}`],
      });
      return;
    }

    // failed_recoverable, reconciliation_required, or an interrupted child:
    // the node parks recoverably and dependents stay blocked.
    this.journal.transitionNode(graph.graphId, nodeId, "failed_recoverable", {
      actor: ACTOR_ID,
      reason: "The child mission has not produced an authoritative result yet; a bounded recovery is required.",
      timestamp,
      resultStatus: mission.status,
      typedError: mission.typedError ?? {
        code: "GRAPH_CHILD_EXECUTION_UNRESOLVED",
        message: `The child mission is in durable state ${state ?? "unknown"} and needs recovery.`,
      },
      evidenceReferences: [`child-mission:${mission.missionId}`],
    });
  }

  private recordChildDispatchError(
    graph: MissionGraphRecord,
    nodeId: string,
    error: unknown,
  ): void {
    if (!(error instanceof OperatorError)) throw error;
    const node = this.journal.requireNode(graph.graphId, nodeId);
    if (node.status !== "running") throw error;
    const terminal = error.code ? TERMINAL_CHILD_ERROR_CODES.has(error.code) : false;
    this.journal.transitionNode(graph.graphId, nodeId, terminal ? "failed_terminal" : "failed_recoverable", {
      actor: ACTOR_ID,
      reason: terminal
        ? "The child mission refused the dispatch with a deterministic binding conflict."
        : "The child mission dispatch failed recoverably; a bounded recovery is required.",
      timestamp: this.now().toISOString(),
      typedError: {
        code: error.code ?? "GRAPH_CHILD_DISPATCH_FAILED",
        message: error.message,
      },
      evidenceReferences: [`child-mission:${node.childMissionId}`],
    });
  }

  private terminateGraphForNode(
    graph: MissionGraphRecord,
    failedNode: MissionGraphNodeRecord,
  ): void {
    const timestamp = this.now().toISOString();
    withTransaction(this.database, () => {
      for (const node of this.journal.listNodes(graph.graphId)) {
        if (node.status === "blocked" || node.status === "ready" || node.status === "failed_recoverable") {
          this.journal.transitionNode(graph.graphId, node.nodeId, "cancelled", {
            actor: ACTOR_ID,
            reason: `Node ${failedNode.nodeId} failed terminally; this node can never satisfy its dependencies.`,
            timestamp,
            evidenceReferences: [`node:${failedNode.nodeId}`],
          });
        }
      }
      this.journal.transitionGraph(graph.graphId, "failed_terminal", {
        actor: ACTOR_ID,
        reason: `Node ${failedNode.nodeId} failed terminally; the graph terminates deterministically.`,
        timestamp,
        typedError: failedNode.typedError ?? {
          code: "GRAPH_NODE_FAILED_TERMINAL",
          message: `Node ${failedNode.nodeId} failed terminally.`,
        },
        evidenceReferences: [
          `node:${failedNode.nodeId}`,
          `child-mission:${failedNode.childMissionId}`,
        ],
      });
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private childReference(node: MissionGraphNodeRecord): MissionGraphChildReference {
    return {
      product: node.product,
      action: node.action,
      childMissionId: node.childMissionId,
      childTraceId: node.childTraceId,
      childIdempotencyKey: node.childIdempotencyKey,
    };
  }

  private parseCompiledGraph(graph: MissionGraphRecord): CompiledMissionGraph {
    return JSON.parse(graph.compiledGraphJson) as CompiledMissionGraph;
  }

  /** The immutable compiled document must still hash to the durable binding. */
  private assertGraphIntegrity(graph: MissionGraphRecord): void {
    if (sha256(graph.compiledGraphJson) !== graph.graphHash) {
      throw new OperatorError(
        "The durable compiled graph no longer matches its immutable graph hash.",
        409,
        "OPERATOR_GRAPH_INTEGRITY_VIOLATION",
      );
    }
  }

  private assertExistingSubmitBinding(
    existing: MissionGraphRecord,
    compiled: CompiledMissionGraph,
    graphHash: string,
  ): void {
    if (compiled.idempotencyKey !== existing.idempotencyKey) {
      throw new OperatorError(
        "The supplied idempotency identity does not match its durable graph binding.",
        409,
        "OPERATOR_GRAPH_IDEMPOTENCY_MISMATCH",
      );
    }
    if (compiled.traceId !== existing.traceId) {
      throw new OperatorError(
        "The supplied trace identity does not match its durable graph binding.",
        409,
        "OPERATOR_GRAPH_TRACE_MISMATCH",
      );
    }
    if (graphHash !== existing.graphHash) {
      throw new OperatorError(
        "The graph is already bound to a different exact compiled graph hash.",
        409,
        "OPERATOR_GRAPH_PAYLOAD_MISMATCH",
      );
    }
  }

  private assertIdentifiersAvailable(compiled: CompiledMissionGraph): void {
    const conflictingTrace = this.journal.getGraphBy("trace_id", compiled.traceId);
    if (conflictingTrace && conflictingTrace.graphId !== compiled.graphId) {
      throw new OperatorError(
        "The supplied trace identity is already bound to another mission graph.",
        409,
        "OPERATOR_GRAPH_TRACE_MISMATCH",
      );
    }
    const conflictingKey = this.journal.getGraphBy("idempotency_key", compiled.idempotencyKey);
    if (conflictingKey && conflictingKey.graphId !== compiled.graphId) {
      throw new OperatorError(
        "The supplied idempotency identity is already bound to another mission graph.",
        409,
        "OPERATOR_GRAPH_IDEMPOTENCY_MISMATCH",
      );
    }
  }

  private assertContainsNoProtectedValue(values: string[]): void {
    if (
      this.protectedValues.some((protectedValue) =>
        values.some((value) => value.includes(protectedValue)))
    ) {
      throw new OperatorError(
        "Mission graph input must not contain protected configuration data.",
        400,
      );
    }
  }

  private buildView(graph: MissionGraphRecord, replayed = false): MissionGraphView {
    const nodes = this.journal.listNodes(graph.graphId).map((node): MissionGraphNodeView => {
      let childMission: MissionGraphNodeChildSummary | null = null;
      const reference = this.childReference(node);
      if (this.children.hasMission(reference)) {
        const mission = this.children.getMission(reference);
        childMission = {
          status: mission.status,
          executionState: mission.executionState,
          nextPermittedActions: mission.nextPermittedActions,
          downstreamIds: mission.downstreamIds,
          retryCount: mission.retryCount,
        };
      }
      return {
        nodeId: node.nodeId,
        product: node.product,
        action: node.action,
        objective: node.objective,
        dependsOn: node.dependsOn,
        childMissionId: node.childMissionId,
        childTraceId: node.childTraceId,
        childIdempotencyKey: node.childIdempotencyKey,
        status: node.status,
        attempts: node.attempts,
        resultStatus: node.resultStatus,
        resultSummary: node.resultSummary,
        typedError: node.typedError,
        childMission,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
      };
    });
    return {
      replayed,
      graphId: graph.graphId,
      traceId: graph.traceId,
      idempotencyKey: graph.idempotencyKey,
      schemaVersion: graph.schemaVersion,
      source: { system: graph.sourceSystem, requestedBy: graph.requestedBy },
      objective: graph.objective,
      tenant: {
        userId: graph.tenantUserId,
        workspaceId: graph.workspaceId,
        accountId: graph.accountId,
      },
      graphHash: graph.graphHash,
      status: graph.status,
      approvalRequired: true,
      approvedBy: graph.approvedBy,
      approvedAt: graph.approvedAt,
      approvedGraphHash: graph.approvedGraphHash,
      requestedAt: graph.requestedAt,
      createdAt: graph.createdAt,
      updatedAt: graph.updatedAt,
      nodeCount: graph.nodeCount,
      normalizedGraph: this.parseCompiledGraph(graph),
      nodes,
      edges: this.journal.listEdges(graph.graphId) as MissionGraphEdgeRecord[],
      events: this.journal.listEvents(graph.graphId),
    };
  }

  private injectFailure(
    boundary: MissionGraphFailureBoundary,
    graphId: string,
    nodeId: string | null,
  ): void {
    this.failureInjector?.(boundary, graphId, nodeId);
  }
}
