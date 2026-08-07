/**
 * CHANTER OS — governed agentic execution fabric service.
 *
 * The orchestration authority. It compiles a human mission into an immutable
 * intent contract, an admitted context bundle, and a deterministic plan; asks
 * the Loop Governor which nodes may run; executes admitted nodes through the
 * Agent Runtime's bounded node contract; and commits every outcome to the plan
 * journal before doing anything else.
 *
 * Four boundaries this service holds and never crosses:
 *
 *   1. **It does not decide admission.** Which nodes may be leased is the
 *      Governor's answer, obtained per tick. This service leases exactly what it
 *      was told and nothing more.
 *   2. **It does not enforce worker bounds.** Tool allowlists, budgets, schema
 *      validation, and evidence requirements are the Runtime's, enforced inside
 *      `executeAgenticNode`. This service supplies the bounds; it never re-checks
 *      them permissively.
 *   3. **It does not grant authority.** A consequential node runs only when a
 *      durable human approval bound to the exact candidate hash exists, is
 *      unexpired, and still matches the bytes on record.
 *   4. **It never speculates.** An unestablished outcome becomes
 *      `reconciliation_required`, and the only route out is a reconcile that
 *      reads real durable truth followed by an explicit resume.
 *
 * ## Scheduling
 *
 * `advance` is one bounded loop of: read durable snapshot -> ask the Governor ->
 * lease every admitted node -> execute them concurrently -> commit each outcome.
 * Leases are taken for the whole batch *before* any worker starts, so two
 * independent nodes are durably `running` at the same time and the event journal
 * records it — which is how observed parallelism is measured after the fact
 * rather than sampled by a racing reader.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  executeAgenticNode,
  type AgenticNodeRecordStore,
  type GovernedModelInvocationOptions,
  type AgenticNodeRequest,
  type AgenticNodeResult,
  type AgenticNodeWorkerRegistry,
  type JsonValue,
} from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import {
  AGENTIC_MISSION_VIEW_SCHEMA_VERSION,
  createAgenticCandidateHash,
  type AgenticAcceptanceCriterion,
  type AgenticNodeState,
  type AgenticValueObservation,
} from "./agenticMissionContract.js";
import {
  assertAgenticIntentUnchanged,
  compileAgenticIntent,
} from "./agenticIntentCompiler.js";
import { compileVerifiedContext, type AgenticContextSourcePort } from "./agenticContextCompiler.js";
import { compileAgenticPlan } from "./agenticPlanCompiler.js";
import { requireAgenticCapability } from "./agenticCapabilityRegistry.js";
import {
  AgenticPlanJournal,
  type AgenticEventRecord,
  type AgenticMissionRecord,
  type AgenticNodeRecord,
  type AgenticReconciliationOutcome,
} from "./agenticPlanJournal.js";
import {
  createAgenticPlanGovernorPort,
  type AgenticGovernanceDecision,
  type AgenticGovernanceSnapshot,
  type AgenticPlanGovernorPort,
} from "./agenticPlanGovernorPort.js";
import { createAgenticToolSurface, type AgenticFabricPaths, type AgenticToolSurface } from "./agenticToolSurface.js";
import { createAgenticContextSourcePort } from "./agenticContextSources.js";
import { createAgenticWorkerSet } from "./agenticWorkers.js";
import { createOperatorProviderBindingRegistry, type AgenticProviderConfiguration } from "./agenticProviderRegistry.js";
import { createAgenticProviderAdapters } from "./agenticProviderAdapters.js";
import { renderAgenticCandidate } from "./agenticCandidateRenderer.js";

/** Grace added to a node lease beyond its own duration ceiling. */
const LEASE_GRACE_MS = 5_000;

/** Bound on scheduling ticks per `advance` call, so a defect cannot spin. */
const MAX_SCHEDULING_TICKS = 32;

export interface AgenticFabricConfiguration {
  readonly paths: AgenticFabricPaths;
  readonly governor: { readonly pythonExecutable: string; readonly governorRoot: string; readonly timeoutMs: number };
  /** How long a candidate approval stays valid. */
  readonly approvalTtlMs: number;
  /** Committed revision an approval is bound to. `null` when none is configured. */
  readonly authorityRevision: string | null;
  /** Which reviewed provider bindings this deployment has actually enabled. */
  readonly providers: AgenticProviderConfiguration;
}

export interface AgenticFabricDependencies {
  readonly database: DatabaseSync;
  readonly configuration: AgenticFabricConfiguration;
  readonly clock?: () => string;
  readonly governor?: AgenticPlanGovernorPort;
  /**
   * Interruption boundaries for recovery proofs. Throwing aborts at exactly that
   * point, leaving whatever durable state exists on either side.
   */
  readonly failureInjector?: (
    boundary: "after_worker_record_before_node_commit" | "before_node_lease",
    context: { readonly missionId: string; readonly nodeId: string },
  ) => void;
  /**
   * Interruption boundary inside a provider call, for the model-worker recovery
   * proof. Distinct from `failureInjector` because it fires one layer deeper —
   * between the provider answering and the worker returning.
   */
  readonly providerFailureInjector?: GovernedModelInvocationOptions["failureInjector"];
}

export interface AgenticMissionView {
  readonly schemaVersion: typeof AGENTIC_MISSION_VIEW_SCHEMA_VERSION;
  readonly missionId: string;
  readonly traceId: string;
  readonly workspaceId: string;
  readonly actorId: string;
  readonly objective: string;
  readonly status: AgenticMissionRecord["status"];
  readonly missionRevision: number;
  readonly intentHash: string;
  readonly contextBundleId: string;
  readonly planId: string;
  readonly planHash: string;
  readonly authority: {
    readonly executionApprovalRequired: true;
    readonly executionApprovedBy: string | null;
    readonly candidateHash: string | null;
    readonly approvedCandidateHash: string | null;
    readonly candidateApprovedBy: string | null;
    readonly candidateApprovalExpiresAt: string | null;
    readonly authorityRevision: string | null;
  };
  readonly artifact: {
    readonly artifactName: string | null;
    readonly artifactHash: string | null;
    readonly writeCount: number;
  };
  readonly valueObservation: AgenticValueObservation | null;
  readonly typedError: AgenticMissionRecord["typedError"];
  readonly nextPermittedActions: readonly string[];
  readonly requestedAt: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireApprover(body: unknown, field = "approvedBy"): string {
  const record = jsonObject(body) ?? {};
  const approver = record[field];
  if (typeof approver !== "string" || !approver.trim() || approver.length > 200) {
    throw new OperatorError(
      `${field} must name the human authority making this decision.`,
      400,
      "AGENTIC_AUTHORITY_APPROVER_REQUIRED",
    );
  }
  return approver.trim();
}

/**
 * Maximum number of nodes durably `running` at the same moment.
 *
 * Replayed from the append-only event journal rather than sampled while
 * executing: a sampled reader can miss an overlap that lasted milliseconds,
 * whereas the journal's ordering records it permanently.
 */
export function observedParallelism(events: readonly AgenticEventRecord[]): number {
  let current = 0;
  let peak = 0;
  for (const event of events) {
    if (event.scope !== "node") continue;
    if (event.newState === "running") {
      current += 1;
      peak = Math.max(peak, current);
    } else if (
      event.previousState === "running"
      && event.newState !== null
      && event.newState !== "running"
    ) {
      current = Math.max(0, current - 1);
    }
  }
  return peak;
}

export class AgenticMissionService {
  private readonly journal: AgenticPlanJournal;
  private readonly governor: AgenticPlanGovernorPort;
  private readonly recordStore: AgenticNodeRecordStore;
  private readonly tools: AgenticToolSurface;
  private readonly contextPort: AgenticContextSourcePort;
  private readonly now: () => string;
  private readonly providerInvocation: GovernedModelInvocationOptions;

  constructor(private readonly dependencies: AgenticFabricDependencies) {
    this.now = dependencies.clock ?? (() => new Date().toISOString());
    this.journal = new AgenticPlanJournal(dependencies.database);
    this.governor = dependencies.governor
      ?? createAgenticPlanGovernorPort(dependencies.configuration.governor);
    this.recordStore = this.journal.createWorkerRecordStore(this.now);
    this.providerInvocation = {
      registry: createOperatorProviderBindingRegistry(dependencies.configuration.providers),
      adapters: createAgenticProviderAdapters(dependencies.configuration.providers),
      usageStore: this.journal.createProviderUsageStore(),
      ...(dependencies.providerFailureInjector
        ? { failureInjector: dependencies.providerFailureInjector }
        : {}),
    };
    this.tools = createAgenticToolSurface(dependencies.configuration.paths, {
      read: (missionId) => {
        const mission = this.journal.getMission(missionId);
        return mission
          ? ({
            missionId: mission.missionId,
            status: mission.status,
            planId: mission.planId,
            intentHash: mission.intentHash,
            artifactHash: mission.artifactHash,
          } satisfies Record<string, JsonValue>)
          : null;
      },
    });
    this.contextPort = createAgenticContextSourcePort(this.tools, this.now);
  }

  get governorConfigured(): boolean {
    return this.governor.configured;
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Compiles and persists one mission.
   *
   * A resubmission with the identical compiled intent replays the durable
   * mission unchanged; a resubmission whose intent bytes differ is a typed
   * conflict, never an update — see `assertAgenticIntentUnchanged`.
   */
  async submit(rawBody: unknown): Promise<{ view: AgenticMissionView; replayed: boolean }> {
    const intent = compileAgenticIntent(rawBody);
    const existing = this.journal.getMission(intent.missionId);
    if (existing) {
      assertAgenticIntentUnchanged(existing.intentHash, intent);
      return { view: this.project(existing), replayed: true };
    }

    const compiledAt = this.now();
    const contextBundle = await compileVerifiedContext(intent, this.contextPort, { compiledAt });
    const compiled = compileAgenticPlan(intent, contextBundle);
    const mission = this.journal.insertMission({
      intent,
      contextBundle,
      plan: compiled.plan,
      routing: compiled.routing,
      timestamp: compiledAt,
      idempotencyKeyFor: (nodeId) => `${intent.missionId}:${compiled.plan.planId}:${nodeId}`,
    });
    return { view: this.project(mission), replayed: false };
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  get(missionId: string): AgenticMissionView {
    return this.project(this.journal.requireMission(missionId));
  }

  has(missionId: string): boolean {
    return this.journal.getMission(missionId) !== null;
  }

  record(missionId: string): AgenticMissionRecord {
    return this.journal.requireMission(missionId);
  }

  list(limit: number): AgenticMissionView[] {
    return this.journal.listMissions(limit).map((mission) => this.project(mission));
  }

  plan(missionId: string): Record<string, unknown> {
    const mission = this.journal.requireMission(missionId);
    return {
      planId: mission.planId,
      planHash: mission.planHash,
      intentHash: mission.intentHash,
      contextBundleId: mission.contextBundleId,
      intent: mission.intent,
      contextBundle: mission.contextBundle,
      plan: mission.plan,
      routing: mission.routing,
    };
  }

  nodes(missionId: string): AgenticNodeRecord[] {
    const mission = this.journal.requireMission(missionId);
    return this.journal.listNodes(mission.planId);
  }

  node(missionId: string, nodeId: string): AgenticNodeRecord {
    const mission = this.journal.requireMission(missionId);
    return this.journal.requireNode(mission.planId, nodeId);
  }

  evidence(missionId: string): Record<string, unknown> {
    const mission = this.journal.requireMission(missionId);
    return {
      missionId,
      contextBundle: mission.contextBundle,
      nodeEvidence: this.journal.listEvidence(missionId),
      events: this.journal.listEvents(missionId),
    };
  }

  events(missionId: string): AgenticEventRecord[] {
    return this.journal.listEvents(missionId);
  }

  // -------------------------------------------------------------------------
  // Authority
  // -------------------------------------------------------------------------

  /** Authorizes execution of the exact compiled plan. No worker runs before this. */
  async approveExecution(missionId: string, rawBody: unknown): Promise<AgenticMissionView> {
    const mission = this.journal.requireMission(missionId);
    const approver = requireApprover(rawBody);
    if (mission.status === "approval_required") {
      const body = jsonObject(rawBody) ?? {};
      // The approval names the exact plan it authorizes when the caller supplies
      // one. A mismatch is refused rather than tolerated: an approval given for
      // a different plan hash is an approval for different work.
      if (typeof body.planHash === "string" && body.planHash !== mission.planHash) {
        throw new OperatorError(
          "The approval names a different plan hash than the durable compiled plan.",
          409,
          "AGENTIC_AUTHORITY_PLAN_HASH_MISMATCH",
          { expected: mission.planHash, supplied: body.planHash },
        );
      }
      this.journal.transitionMission(missionId, "approved", {
        actor: approver,
        reason: "A human authorized execution of this exact compiled plan.",
        timestamp: this.now(),
        executionApprovedBy: approver,
        executionApprovedPlanHash: mission.planHash,
        evidenceReferences: [`plan-sha256:${mission.planHash}`],
      });
    }
    return this.advance(missionId);
  }

  /**
   * Authorizes the one consequential write, bound to exact candidate bytes.
   *
   * The supplied hash must equal the durable candidate hash. That is the whole
   * binding: a caller approving a hash it computed from bytes it saw earlier
   * cannot authorize bytes that have since changed.
   */
  async approveCandidate(missionId: string, rawBody: unknown): Promise<AgenticMissionView> {
    const mission = this.journal.requireMission(missionId);
    const approver = requireApprover(rawBody);
    const body = jsonObject(rawBody) ?? {};
    if (mission.status !== "awaiting_authority") {
      throw new OperatorError(
        `This mission is ${mission.status}; no candidate is awaiting authority.`,
        409,
        "AGENTIC_AUTHORITY_NOT_AWAITED",
      );
    }
    if (!mission.candidateHash || !mission.candidateMarkdown) {
      throw new OperatorError(
        "No durable candidate exists to approve.",
        409,
        "AGENTIC_AUTHORITY_CANDIDATE_ABSENT",
      );
    }
    const suppliedHash = body.candidateHash;
    if (typeof suppliedHash !== "string" || !suppliedHash) {
      throw new OperatorError(
        "candidateHash must name the exact candidate bytes being approved.",
        400,
        "AGENTIC_AUTHORITY_CANDIDATE_HASH_REQUIRED",
      );
    }
    if (suppliedHash !== mission.candidateHash) {
      throw new OperatorError(
        "The approval binds a different candidate than the durable one.",
        409,
        "AGENTIC_AUTHORITY_CANDIDATE_MISMATCH",
        { expected: mission.candidateHash, supplied: suppliedHash },
      );
    }

    const timestamp = this.now();
    const expiresAt = new Date(
      Date.parse(timestamp) + this.dependencies.configuration.approvalTtlMs,
    ).toISOString();
    this.journal.updateMission(missionId, {
      eventType: "candidate_approved",
      actor: approver,
      reason: "A human authorized one bounded local artifact write for these exact candidate bytes.",
      timestamp,
      candidateApprovedBy: approver,
      approvedCandidateHash: mission.candidateHash,
      candidateApprovalExpiresAt: expiresAt,
      candidateAuthorityRevision: this.dependencies.configuration.authorityRevision,
      evidenceReferences: [`candidate-sha256:${mission.candidateHash}`],
    });
    // The checkpoint traverses the same `ready -> running -> completed` path
    // every other node does. Its "work" is the human decision, and giving it a
    // shortcut edge would open one for worker nodes too — a node that could
    // reach `completed` without ever being `running` is a node that could be
    // reported done without anything having happened.
    this.journal.transitionNode(mission.planId, "N6", "running", {
      actor: approver,
      reason: "A human began deciding this authority checkpoint.",
      timestamp,
      startedAt: timestamp,
    });
    this.journal.transitionNode(mission.planId, "N6", "completed", {
      actor: approver,
      reason: "Human authority for the bounded local artifact write was recorded.",
      timestamp,
      completedAt: timestamp,
      output: { approvedBy: approver, candidateHash: mission.candidateHash },
      outputHash: mission.candidateHash,
      evidenceReferences: [`candidate-sha256:${mission.candidateHash}`],
    });
    this.journal.transitionMission(missionId, "running", {
      actor: approver,
      reason: "Authority was granted, so the plan resumes at its consequential node.",
      timestamp,
    });
    return this.advance(missionId);
  }

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------

  /** Runs scheduling ticks until the Governor admits nothing further. */
  async advance(missionId: string): Promise<AgenticMissionView> {
    for (let tick = 0; tick < MAX_SCHEDULING_TICKS; tick += 1) {
      const mission = this.journal.requireMission(missionId);
      if (mission.status !== "approved" && mission.status !== "running") break;
      if (mission.status === "approved") {
        this.journal.transitionMission(missionId, "running", {
          actor: mission.actorId,
          reason: "Approved plan execution began.",
          timestamp: this.now(),
        });
        continue;
      }

      const nodes = this.journal.listNodes(mission.planId);
      this.openReadyNodes(mission, nodes);
      const refreshed = this.journal.listNodes(mission.planId);
      const decision = await this.governor.govern(this.snapshot(mission, refreshed));
      const admitted = decision.admitted
        .map((nodeId) => refreshed.find((node) => node.nodeId === nodeId))
        .filter((node): node is AgenticNodeRecord => node !== undefined);

      if (admitted.length === 0) {
        this.settleTerminalState(mission, refreshed, decision);
        break;
      }

      // The authority checkpoint is not executable work. When it becomes
      // admissible the plan stops and waits for a human, which is the boundary
      // the whole fabric exists to hold.
      const checkpoint = admitted.find((node) => node.nodeType === "authority_checkpoint");
      if (checkpoint) {
        this.journal.transitionMission(missionId, "awaiting_authority", {
          actor: mission.actorId,
          reason: "The plan reached its human authority checkpoint and cannot proceed without approval.",
          timestamp: this.now(),
          evidenceReferences: mission.candidateHash ? [`candidate-sha256:${mission.candidateHash}`] : [],
        });
        break;
      }

      const executed = await this.executeBatch(mission, admitted);
      if (!executed) break;
    }
    return this.get(missionId);
  }

  /**
   * Leases every admitted node, then runs them concurrently.
   *
   * Leases are committed for the whole batch first. Two independent nodes are
   * therefore durably `running` at the same instant, and the event journal shows
   * two `node_running` entries before any `node_completed` — the durable form of
   * "both became running before either completed".
   */
  private async executeBatch(
    mission: AgenticMissionRecord,
    admitted: readonly AgenticNodeRecord[],
  ): Promise<boolean> {
    const leased: AgenticNodeRecord[] = [];
    for (const node of admitted) {
      this.dependencies.failureInjector?.("before_node_lease", {
        missionId: mission.missionId,
        nodeId: node.nodeId,
      });
      const timestamp = this.now();
      const deadlineAt = new Date(Date.parse(timestamp) + node.budget.maxDurationMs).toISOString();
      leased.push(this.journal.transitionNode(mission.planId, node.nodeId, "running", {
        actor: mission.actorId,
        reason: `The Loop Governor admitted this node for one bounded attempt.`,
        timestamp,
        attempts: node.attempts + 1,
        leaseOwner: `${mission.missionId}:${node.nodeId}:${node.attempts + 1}`,
        leaseExpiresAt: new Date(
          Date.parse(timestamp) + node.budget.maxDurationMs + LEASE_GRACE_MS,
        ).toISOString(),
        deadlineAt,
        startedAt: timestamp,
      }));
    }
    if (leased.length === 0) return false;

    const workers = this.workersFor(mission);
    const results = await Promise.all(
      leased.map(async (node) => ({
        node,
        result: await this.runNode(mission, node, workers),
      })),
    );
    for (const { node, result } of results) {
      this.dependencies.failureInjector?.("after_worker_record_before_node_commit", {
        missionId: mission.missionId,
        nodeId: node.nodeId,
      });
      this.commitNodeResult(mission, node, result);
    }
    return true;
  }

  private workersFor(mission: AgenticMissionRecord): AgenticNodeWorkerRegistry {
    return createAgenticWorkerSet({
      intent: mission.intent,
      contextBundle: mission.contextBundle,
      tools: this.tools,
      candidate: () => {
        const current = this.journal.requireMission(mission.missionId);
        return current.candidateMarkdown && current.candidateHash
          ? { markdown: current.candidateMarkdown, candidateHash: current.candidateHash }
          : null;
      },
      artifactWriteCount: () => this.journal.countArtifactWrites(mission.missionId),
      // The routed plan decides which capabilities became model workers, and
      // against which reviewed binding. Passing the *durable* nodes rather than
      // re-deriving from the intent means a resumed mission builds exactly the
      // workers its committed plan named, even if the registry has since moved.
      modelNodes: this.journal
        .listNodes(mission.planId)
        .filter((node) => node.workerKind === "model_worker" && node.capabilityId !== null)
        .map((node) => ({
          capabilityId: node.capabilityId as string,
          bindingId: node.providerBindingId,
          maxTotalTokens: node.budget.maxTokens,
          maxCostMicros: node.budget.maxCostMicros,
          attempts: node.attempts,
        })),
      providerInvocation: this.providerInvocation,
    });
  }

  private runNode(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
    workers: AgenticNodeWorkerRegistry,
  ): Promise<AgenticNodeResult> {
    const capability = requireAgenticCapability(node.capabilityId ?? "");
    const request: AgenticNodeRequest = {
      identity: {
        missionId: mission.missionId,
        planId: mission.planId,
        nodeId: node.nodeId,
        traceId: mission.traceId,
      },
      capability: {
        capabilityId: capability.capabilityId,
        workerKind: (node.workerKind ?? capability.allowedWorkerKinds[0]) as
          AgenticNodeRequest["capability"]["workerKind"],
        riskClass: capability.riskClass,
        verifiability: capability.verifiability,
        sideEffectClass: capability.sideEffectClass,
        allowedTools: capability.allowedTools,
        outputSchema: capability.outputSchema,
        evidencePolicy: node.evidencePolicy,
      },
      input: this.inputFor(mission, node),
      budget: node.budget,
      deadlineAt: node.deadlineAt ?? new Date(Date.now() + node.budget.maxDurationMs).toISOString(),
      idempotencyKey: node.idempotencyKey,
      acceptedContextIds: this.acceptedContextIdsFor(mission, node),
    };
    return executeAgenticNode(request, {
      workers,
      recordStore: this.recordStore,
      tools: this.tools,
    });
  }

  // -------------------------------------------------------------------------
  // Node input assembly
  // -------------------------------------------------------------------------

  /**
   * The exact bounded input one node receives.
   *
   * Built only from this mission's compiled intent and from the *accepted*
   * outputs of the nodes the plan declared as this node's `inputRefs`. There is
   * no path by which a node reads a sibling it has no edge to, which is what
   * makes the two specialists genuinely independent.
   */
  private inputFor(mission: AgenticMissionRecord, node: AgenticNodeRecord): JsonValue {
    const outputOf = (nodeId: string): Record<string, JsonValue> => {
      const source = this.journal.requireNode(mission.planId, nodeId);
      const output = source.output;
      return output !== null && typeof output === "object" && !Array.isArray(output)
        ? (output as Record<string, JsonValue>)
        : {};
    };

    switch (node.nodeId) {
      case "N1":
        return { requirementIds: mission.intent.contextRequirements.map((requirement) => requirement.requirementId) };
      case "N2":
      case "N3": {
        const collected = outputOf("N1");
        return {
          contextBundleId: String(collected.contextBundleId ?? mission.contextBundleId),
          acceptedContextIds: (collected.acceptedContextIds as string[] | undefined) ?? [],
          focus: node.nodeId === "N2" ? "architecture" : "risk",
        };
      }
      case "N4": {
        const collected = outputOf("N1");
        return {
          contextBundleId: String(collected.contextBundleId ?? mission.contextBundleId),
          acceptedContextIds: (collected.acceptedContextIds as string[] | undefined) ?? [],
          claimSets: [
            { nodeId: "N2", claims: (outputOf("N2").claims as JsonValue) ?? [] },
            { nodeId: "N3", claims: (outputOf("N3").claims as JsonValue) ?? [] },
          ],
        };
      }
      case "N5": {
        const verified = outputOf("N4");
        return {
          acceptedClaims: (verified.acceptedClaims as JsonValue) ?? [],
          requiredSections: [...mission.intent.outputContract.requiredSections],
          acceptanceCriteria: mission.intent.acceptanceCriteria.map(
            (criterion: AgenticAcceptanceCriterion) => ({ ...criterion }),
          ),
          remainingUncertainty: [
            ...((verified.missingEvidence as string[] | undefined) ?? []),
            ...mission.contextBundle.rejectedRequirementIds,
          ],
        };
      }
      case "N7":
        return {
          artifactName: mission.intent.outputContract.artifactName,
          candidateHash: String(mission.approvedCandidateHash ?? ""),
          approvalId: `${mission.missionId}:N6`,
        };
      case "N8": {
        const verified = outputOf("N4");
        const synthesis = outputOf("N5");
        const rejected = (verified.rejectedClaims as Array<Record<string, JsonValue>> | undefined) ?? [];
        return {
          artifactName: mission.intent.outputContract.artifactName,
          approvedCandidateHash: String(mission.approvedCandidateHash ?? ""),
          requiredSections: [...mission.intent.outputContract.requiredSections],
          rejectedClaimStatements: rejected.map((claim) => String(claim.statement)),
          evidenceIndex: (synthesis.evidenceIndex as string[] | undefined) ?? [],
        };
      }
      /* c8 ignore next 2 -- unreachable: the compiled plan has exactly these nodes. */
      default:
        return {};
    }
  }

  /** Context ids a node may cite: the admitted set N1 confirmed, or the bundle. */
  private acceptedContextIdsFor(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
  ): readonly string[] {
    if (node.nodeId === "N1") {
      return mission.contextBundle.items.map((item) => item.contextItemId);
    }
    const collected = this.journal.getNode(mission.planId, "N1");
    const output = collected?.output;
    if (output !== null && typeof output === "object" && !Array.isArray(output)) {
      const accepted = (output as Record<string, JsonValue>).acceptedContextIds;
      if (Array.isArray(accepted)) return accepted.map((entry) => String(entry));
    }
    return mission.contextBundle.items.map((item) => item.contextItemId);
  }

  // -------------------------------------------------------------------------
  // Result commitment
  // -------------------------------------------------------------------------

  private commitNodeResult(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
    result: AgenticNodeResult,
  ): void {
    const timestamp = this.now();
    if (result.status === "succeeded" || result.status === "duplicate") {
      this.journal.recordNodeEvidence(
        mission.missionId,
        mission.planId,
        node.nodeId,
        result.evidence,
        timestamp,
      );
      this.afterNodeSuccess(mission, node, result, timestamp);
      return;
    }

    // An unavailable or in-flight outcome means the answer is genuinely unknown,
    // so the node becomes `reconciliation_required` rather than a retry
    // candidate. Everything else is a decided failure this attempt can own.
    const unknownOutcome = result.status === "unavailable";
    this.journal.transitionNode(
      mission.planId,
      node.nodeId,
      unknownOutcome ? "reconciliation_required" : "failed_recoverable",
      {
        actor: mission.actorId,
        reason: unknownOutcome
          ? "The node's outcome was never established, so it must be reconciled before any retry."
          : `The node attempt failed: ${result.typedError?.code ?? "unknown"}.`,
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        cost: result.cost,
        latencyMs: result.latencyMs,
        typedError: result.typedError
          ? { code: result.typedError.code, message: result.typedError.message }
          : null,
      },
    );
    this.journal.transitionMission(mission.missionId, unknownOutcome ? "reconciliation_required" : "failed_recoverable", {
      actor: mission.actorId,
      reason: `Node ${node.nodeId} did not complete.`,
      timestamp,
      typedError: result.typedError
        ? { code: result.typedError.code, message: result.typedError.message }
        : null,
    });
  }

  /**
   * Commits one successful node and derives whatever it makes true.
   *
   * The verifier is the one node whose *content* changes the plan's shape: a
   * `failed` verdict makes the node terminal rather than complete, which leaves
   * synthesis and the write structurally unreachable. That is deliberate — a
   * critical contradiction must remove the possibility of a write, not merely
   * discourage it.
   */
  private afterNodeSuccess(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
    result: AgenticNodeResult,
    timestamp: string,
  ): void {
    const output = result.structuredOutput;
    const record = output !== null && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, JsonValue>)
      : {};

    if (node.nodeId === "N4" && record.verificationVerdict === "failed") {
      this.journal.transitionNode(mission.planId, node.nodeId, "failed_terminal", {
        actor: mission.actorId,
        reason: "Verification found a critical contradiction, so no result may be synthesized or written.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        output,
        outputHash: result.outputHash,
        cost: result.cost,
        latencyMs: result.latencyMs,
        completedAt: timestamp,
        typedError: {
          code: "AGENTIC_VERIFICATION_FAILED",
          message: "A critical contradiction between specialist claims blocks synthesis and any write.",
        },
      });
      this.journal.transitionMission(mission.missionId, "failed_terminal", {
        actor: mission.actorId,
        reason: "Verification failed, so artifact write authority is unavailable for this mission.",
        timestamp,
        typedError: {
          code: "AGENTIC_VERIFICATION_FAILED",
          message: "A critical contradiction between specialist claims blocks synthesis and any write.",
        },
      });
      return;
    }

    this.journal.transitionNode(mission.planId, node.nodeId, "completed", {
      actor: mission.actorId,
      reason: result.idempotencyOutcome === "duplicate"
        ? "An existing durable worker record was committed; no second worker invocation occurred."
        : "The node produced a schema-valid, evidence-backed result.",
      timestamp,
      leaseOwner: null,
      leaseExpiresAt: null,
      output,
      outputHash: result.outputHash,
      cost: result.cost,
      latencyMs: result.latencyMs,
      completedAt: timestamp,
      evidenceReferences: result.evidence.map((item) => item.evidenceId),
    });

    if (node.nodeId === "N5") {
      // The candidate is rendered from the accepted synthesis, hashed, and made
      // durable *before* any human sees it, so what gets approved and what gets
      // written are the same bytes by construction.
      const markdown = renderAgenticCandidate(mission, record);
      const candidateHash = createAgenticCandidateHash(markdown);
      this.journal.updateMission(mission.missionId, {
        eventType: "candidate_prepared",
        actor: mission.actorId,
        reason: "A candidate result was composed from accepted claims and bound to an exact hash.",
        timestamp,
        candidateHash,
        candidateMarkdown: markdown,
        evidenceReferences: [`candidate-sha256:${candidateHash}`],
      });
    }

    if (node.nodeId === "N7") {
      const current = this.journal.requireMission(mission.missionId);
      this.journal.recordArtifactWrite({
        missionId: mission.missionId,
        artifactName: String(record.artifactName ?? current.intent.outputContract.artifactName),
        artifactHash: String(record.artifactHash ?? ""),
        approvedCandidateHash: String(current.approvedCandidateHash ?? ""),
        byteLength: Number(record.bytesWritten ?? 0),
        artifactPath: this.dependencies.configuration.paths.artifactRoot,
        writtenAt: timestamp,
      });
      this.journal.updateMission(mission.missionId, {
        eventType: "artifact_written",
        actor: mission.actorId,
        reason: "Exactly one approved local artifact was written atomically.",
        timestamp,
        artifactHash: String(record.artifactHash ?? ""),
        artifactName: String(record.artifactName ?? ""),
        evidenceReferences: [`artifact-sha256:${String(record.artifactHash ?? "")}`],
      });
    }

    if (node.nodeId === "N8") {
      this.finishMission(mission.missionId, record, timestamp);
    }
  }

  /**
   * Only N8 may complete a mission.
   *
   * Its verdict is the terminal authority: a plan whose artifact does not verify
   * ends `failed_terminal` with the artifact still on disk and the reason
   * recorded, rather than being reported as a success nobody checked.
   */
  private finishMission(
    missionId: string,
    outcome: Record<string, JsonValue>,
    timestamp: string,
  ): void {
    const verified = outcome.outcomeVerified === true;
    const observation = this.computeValueObservation(missionId, verified);
    this.journal.transitionMission(missionId, verified ? "completed" : "failed_terminal", {
      actor: this.journal.requireMission(missionId).actorId,
      reason: verified
        ? "Independent outcome verification passed, so the mission is complete."
        : "Independent outcome verification failed, so the mission cannot be reported complete.",
      timestamp,
      valueObservation: observation,
      ...(verified
        ? {}
        : {
          typedError: {
            code: "AGENTIC_OUTCOME_VERIFICATION_FAILED",
            message: "The written artifact did not satisfy independent outcome verification.",
          },
        }),
      evidenceReferences: [`artifact-sha256:${String(outcome.artifactHash ?? "")}`],
    });
  }

  // -------------------------------------------------------------------------
  // Node-level recovery
  // -------------------------------------------------------------------------

  /**
   * Investigates one ambiguous node. Executes nothing.
   *
   * The finding is durable and is the only thing that can make a resume legal.
   * Reconcile deliberately has no path to a worker: its entire job is to read
   * what already happened.
   */
  reconcileNode(missionId: string, nodeId: string): AgenticNodeRecord {
    const mission = this.journal.requireMission(missionId);
    let node = this.journal.requireNode(mission.planId, nodeId);
    const timestamp = this.now();

    // A node still marked `running` after its executing process is gone is the
    // unknown-outcome case, so it is moved into the state that names it before
    // anything is investigated.
    //
    // This accepts a node whose lease has not yet lapsed, which is deliberate:
    // after a process kill nothing observes that the holder died, and waiting
    // out a lease that will never be released turns a recoverable interruption
    // into a stall. Doing so is safe because reconcile only *reads*, and because
    // the real mutual exclusion is the Runtime's durable execution claim — a
    // genuinely live worker still holds it, so any resume that tried to re-run
    // the node would be refused as in-flight rather than duplicated.
    if (node.state === "running") {
      const lapsed = this.leaseHasLapsed(node, timestamp);
      node = this.journal.transitionNode(mission.planId, nodeId, "reconciliation_required", {
        actor: mission.actorId,
        reason: lapsed
          ? "The execution lease lapsed while the node was running, so its outcome is unknown."
          : "The node was left running by an interrupted execution, so its outcome is unknown.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
    if (node.state !== "reconciliation_required" && node.state !== "failed_recoverable") {
      throw new OperatorError(
        `Node ${nodeId} is ${node.state}; there is nothing ambiguous to reconcile.`,
        409,
        "AGENTIC_NODE_RECONCILIATION_NOT_APPLICABLE",
      );
    }

    const outcome = this.investigate(mission, node);
    return this.journal.appendNodeAuditEvent(mission.planId, nodeId, "node_reconciled", {
      actor: mission.actorId,
      reason: `Reconciliation read durable downstream truth and found: ${outcome}.`,
      timestamp,
      reconciliationOutcome: outcome,
      reconciledAt: timestamp,
      evidenceReferences: [`worker-record:${node.idempotencyKey}`],
    });
  }

  /** Reads real durable truth for one node. Never guesses, never executes. */
  private investigate(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
  ): AgenticReconciliationOutcome {
    if (node.reconciliationMode === "artifact_lookup_before_retry") {
      const written = this.journal.getArtifactWrite(
        mission.missionId,
        mission.intent.outputContract.artifactName,
      );
      if (written) return "worker_result_found";
      // A worker record without an artifact-write row means the write node ran
      // but its journal commit did not land. That is genuinely ambiguous for a
      // side-effecting node, so it escalates rather than being retried.
      return this.recordStore.read(node.idempotencyKey) ? "conflict" : "no_worker_result";
    }
    if (this.recordStore.read(node.idempotencyKey)) return "worker_result_found";
    // No recorded outcome. Whether a claim is still held or no row exists at all,
    // the finding is the same for a capability whose side-effect class is `none`:
    // no result exists, and the node is owed one genuine attempt. The two cases
    // differ only in what a live worker would do next, and that is settled by the
    // Runtime's own claim — a second execution under this identity is refused as
    // in-flight rather than duplicated.
    return "no_worker_result";
  }

  /**
   * Continues one reconciled node.
   *
   * Refuses outright when reconciliation has not happened — that refusal is the
   * property that stops a resume from becoming a speculative second execution.
   */
  async resumeNode(missionId: string, nodeId: string): Promise<AgenticNodeRecord> {
    const mission = this.journal.requireMission(missionId);
    const node = this.journal.requireNode(mission.planId, nodeId);
    // Two shapes of "outcome not established", refused identically. A node left
    // `running` by an interrupted process is exactly as unknown as one already
    // marked `reconciliation_required`; refusing only the latter would let the
    // more dangerous case through, because that is the one still holding a
    // lease nobody has read.
    if (
      node.state === "running"
      || (node.state === "reconciliation_required" && node.reconciliationOutcome === null)
    ) {
      throw new OperatorError(
        `Node ${nodeId} has no established outcome; resume is refused until it is reconciled.`,
        409,
        "AGENTIC_NODE_RECONCILIATION_REQUIRED",
        { missionId, nodeId, nodeState: node.state, requiredAction: "reconcile" },
      );
    }
    if (node.reconciliationOutcome === "conflict") {
      throw new OperatorError(
        `Node ${nodeId} reconciled to a conflict and must be resolved by a human before any resume.`,
        409,
        "AGENTIC_NODE_RECONCILIATION_CONFLICT",
        { missionId, nodeId },
      );
    }

    const timestamp = this.now();
    if (node.state === "reconciliation_required" && node.reconciliationOutcome === "worker_result_found") {
      const recorded = this.recordStore.read(node.idempotencyKey);
      if (!recorded) {
        throw new OperatorError(
          `Node ${nodeId} reconciled to an existing worker result that can no longer be read.`,
          409,
          "AGENTIC_NODE_RECONCILIATION_CONFLICT",
        );
      }
      // The worker already ran. Committing its exact recorded result is the
      // whole of the resume — no worker is invoked, so the invocation count for
      // this node stays at one across the interruption.
      this.journal.recordNodeEvidence(
        mission.missionId,
        mission.planId,
        nodeId,
        recorded.evidence,
        timestamp,
      );
      this.journal.transitionNode(mission.planId, nodeId, "completed", {
        actor: mission.actorId,
        reason: "Resume committed the existing durable worker result; no second worker invocation occurred.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        output: recorded.structuredOutput,
        outputHash: recorded.outputHash,
        cost: recorded.cost,
        latencyMs: recorded.latencyMs,
        completedAt: timestamp,
        evidenceReferences: [`worker-record:${node.idempotencyKey}`],
      });
      // Everything a completed node makes true — a candidate, an artifact-write
      // row, a mission verdict — is derived by the same path a first execution
      // would have taken, so a recovered node converges to the same result.
      this.deriveAfterRecoveredCompletion(mission, nodeId, recorded.structuredOutput, timestamp);
    } else if (node.state === "reconciliation_required") {
      this.journal.transitionNode(mission.planId, nodeId, "failed_recoverable", {
        actor: mission.actorId,
        reason: "Reconciliation proved no worker result exists, so one bounded attempt is owed.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }

    const current = this.journal.requireMission(missionId);
    if (current.status === "reconciliation_required" || current.status === "failed_recoverable") {
      this.journal.transitionMission(missionId, "running", {
        actor: current.actorId,
        reason: `Node ${nodeId} was reconciled and resumed.`,
        timestamp,
      });
    }
    await this.advance(missionId);
    return this.journal.requireNode(mission.planId, nodeId);
  }

  /** Re-derives the consequences of a node completing, after a recovery. */
  private deriveAfterRecoveredCompletion(
    mission: AgenticMissionRecord,
    nodeId: string,
    output: JsonValue | null,
    timestamp: string,
  ): void {
    const record = output !== null && typeof output === "object" && !Array.isArray(output)
      ? (output as Record<string, JsonValue>)
      : {};
    if (nodeId === "N5") {
      const markdown = renderAgenticCandidate(mission, record);
      const candidateHash = createAgenticCandidateHash(markdown);
      this.journal.updateMission(mission.missionId, {
        eventType: "candidate_prepared",
        actor: mission.actorId,
        reason: "A candidate was composed from the recovered synthesis result.",
        timestamp,
        candidateHash,
        candidateMarkdown: markdown,
        evidenceReferences: [`candidate-sha256:${candidateHash}`],
      });
    }
  }

  /** Stops one node and every node that can no longer be reached without it. */
  async stopNode(missionId: string, nodeId: string, rawBody: unknown): Promise<AgenticNodeRecord> {
    const mission = this.journal.requireMission(missionId);
    const nodes = this.journal.listNodes(mission.planId);
    const node = this.journal.requireNode(mission.planId, nodeId);
    const actor = requireApprover(rawBody, "stoppedBy");
    const timestamp = this.now();

    const dependents = await this.governor.dependents(this.snapshot(mission, nodes), nodeId);
    if (node.state !== "failed_terminal" && node.state !== "cancelled" && node.state !== "completed") {
      this.journal.transitionNode(mission.planId, nodeId, "failed_terminal", {
        actor,
        reason: "A human stopped this node and escalated it.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        typedError: { code: "AGENTIC_NODE_STOPPED", message: "Stopped for human escalation." },
      });
    }
    for (const dependentId of dependents) {
      const dependent = this.journal.requireNode(mission.planId, dependentId);
      if (dependent.state === "completed" || dependent.state === "cancelled"
        || dependent.state === "failed_terminal") {
        continue;
      }
      this.journal.transitionNode(mission.planId, dependentId, "cancelled", {
        actor,
        reason: `Cancelled because ${nodeId} was stopped and this node depends on it.`,
        timestamp,
      });
    }
    const current = this.journal.requireMission(missionId);
    if (current.status !== "failed_terminal" && current.status !== "completed"
      && current.status !== "cancelled") {
      this.journal.transitionMission(missionId, "failed_terminal", {
        actor,
        reason: `Node ${nodeId} was stopped, so its downstream path can never complete.`,
        timestamp,
        typedError: { code: "AGENTIC_NODE_STOPPED", message: `Node ${nodeId} was stopped by a human.` },
      });
    }
    return this.journal.requireNode(mission.planId, nodeId);
  }

  /** Stops the whole mission. */
  stop(missionId: string, rawBody: unknown): AgenticMissionView {
    const mission = this.journal.requireMission(missionId);
    const actor = requireApprover(rawBody, "stoppedBy");
    const timestamp = this.now();
    if (mission.status === "completed" || mission.status === "cancelled"
      || mission.status === "failed_terminal") {
      return this.project(mission);
    }
    for (const node of this.journal.listNodes(mission.planId)) {
      if (node.state === "completed" || node.state === "cancelled"
        || node.state === "failed_terminal") {
        continue;
      }
      this.journal.transitionNode(mission.planId, node.nodeId, "cancelled", {
        actor,
        reason: "The mission was stopped by a human.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
      });
    }
    return this.project(this.journal.transitionMission(missionId, "cancelled", {
      actor,
      reason: "A human stopped this mission and escalated it.",
      timestamp,
    }));
  }

  /** Reconciles every ambiguous node, then resumes the plan. */
  async reconcile(missionId: string): Promise<AgenticMissionView> {
    const mission = this.journal.requireMission(missionId);
    const ambiguous = this.journal
      .listNodes(mission.planId)
      .filter((node) => node.state === "reconciliation_required" || node.state === "running");
    if (ambiguous.length === 0) {
      throw new OperatorError(
        "No node on this plan is awaiting reconciliation.",
        409,
        "AGENTIC_NODE_RECONCILIATION_NOT_APPLICABLE",
      );
    }
    for (const node of ambiguous) this.reconcileNode(missionId, node.nodeId);
    return this.get(missionId);
  }

  /** Resumes every reconciled node, then advances the plan. */
  async resume(missionId: string): Promise<AgenticMissionView> {
    const mission = this.journal.requireMission(missionId);
    const pending = this.journal
      .listNodes(mission.planId)
      .filter((node) => node.state === "reconciliation_required" || node.state === "failed_recoverable");
    for (const node of pending) await this.resumeNode(missionId, node.nodeId);
    if (pending.length === 0) await this.advance(missionId);
    return this.get(missionId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private leaseHasLapsed(node: AgenticNodeRecord, now: string): boolean {
    return node.leaseExpiresAt !== null && Date.parse(node.leaseExpiresAt) <= Date.parse(now);
  }

  /** Opens every blocked node whose dependencies are all durably completed. */
  private openReadyNodes(
    mission: AgenticMissionRecord,
    nodes: readonly AgenticNodeRecord[],
  ): void {
    const byId = new Map(nodes.map((node) => [node.nodeId, node]));
    for (const node of nodes) {
      if (node.state !== "blocked") continue;
      const satisfied = node.dependsOn.every((dependencyId) => byId.get(dependencyId)?.state === "completed");
      if (!satisfied) continue;
      this.journal.transitionNode(mission.planId, node.nodeId, "ready", {
        actor: mission.actorId,
        reason: "Every dependency of this node is durably completed.",
        timestamp: this.now(),
      });
    }
  }

  private snapshot(
    mission: AgenticMissionRecord,
    nodes: readonly AgenticNodeRecord[],
  ): AgenticGovernanceSnapshot {
    // The time budget is a compute budget, not a wall clock: only measured node
    // latency consumes it, so a plan waiting on a human never runs out of time.
    const consumedMs = nodes.reduce((total, node) => total + (node.latencyMs ?? 0), 0);
    const remainingMs = Math.max(0, mission.intent.timeBudgetMs - consumedMs);
    const spentMicros = nodes.reduce(
      (total, node) => total + (node.cost?.monetaryCostMicros ?? 0),
      0,
    );
    return {
      planId: mission.planId,
      now: this.now(),
      maxParallelism: mission.plan.maxParallelism,
      nodes,
      planDeadlineAt: new Date(Date.parse(this.now()) + remainingMs).toISOString(),
      costBudgetMicros: mission.intent.costBudgetMicros,
      costSpentMicros: spentMicros,
      cancellationRequested: mission.status === "cancelled",
    };
  }

  /**
   * Records the plan's terminal state when the Governor admits nothing.
   *
   * "Nothing admitted" is not by itself a failure — a plan awaiting authority or
   * already complete also admits nothing — so this only writes a terminal state
   * when the Governor reports that a node can never be reached.
   */
  private settleTerminalState(
    mission: AgenticMissionRecord,
    nodes: readonly AgenticNodeRecord[],
    decision: AgenticGovernanceDecision,
  ): void {
    const current = this.journal.requireMission(mission.missionId);
    if (current.status !== "running") return;
    const outstanding = nodes.filter((node) =>
      node.state !== "completed" && node.state !== "cancelled" && node.state !== "failed_terminal");
    if (outstanding.length === 0) return;
    if (decision.unreachable.length === 0) return;
    this.journal.transitionMission(mission.missionId, "failed_terminal", {
      actor: mission.actorId,
      reason: `The Governor reports ${decision.unreachable.join(", ")} can never be reached.`,
      timestamp: this.now(),
      typedError: {
        code: "AGENTIC_PLAN_UNREACHABLE",
        message: `Nodes ${decision.unreachable.join(", ")} can never complete.`,
      },
    });
  }

  /**
   * The mission's measured value.
   *
   * Every field is read from durable truth. Cost fields stay `null` unless a
   * worker actually reported a measured value, because a fabricated cost is
   * worse than an absent one for every decision this record feeds.
   */
  private computeValueObservation(missionId: string, verified: boolean): AgenticValueObservation {
    const mission = this.journal.requireMission(missionId);
    const nodes = this.journal.listNodes(mission.planId);
    const events = this.journal.listEvents(missionId);
    const verifier = nodes.find((node) => node.nodeId === "N4");
    const synthesis = nodes.find((node) => node.nodeId === "N5");

    const verifierOutput = verifier?.output as Record<string, JsonValue> | null | undefined;
    const synthesisOutput = synthesis?.output as Record<string, JsonValue> | null | undefined;
    const acceptedClaims = Array.isArray(verifierOutput?.acceptedClaims)
      ? verifierOutput.acceptedClaims.length
      : 0;
    const rejectedClaims = Array.isArray(verifierOutput?.rejectedClaims)
      ? verifierOutput.rejectedClaims.length
      : 0;
    const evidenceIndex = Array.isArray(synthesisOutput?.evidenceIndex)
      ? synthesisOutput.evidenceIndex.length
      : 0;
    const acceptanceEvaluation = Array.isArray(synthesisOutput?.acceptanceEvaluation)
      ? (synthesisOutput.acceptanceEvaluation as Array<Record<string, JsonValue>>)
      : [];
    const machineCheckable = mission.intent.acceptanceCriteria.filter(
      (criterion) => criterion.check !== "human_judgment",
    );
    const machineCheckableIds = new Set(machineCheckable.map((criterion) => criterion.criterionId));

    const tokenCosts = nodes
      .map((node) => node.cost?.tokenCost)
      .filter((value): value is number => typeof value === "number");
    const monetaryCosts = nodes
      .map((node) => node.cost?.monetaryCostMicros)
      .filter((value): value is number => typeof value === "number");

    const workerNodes = nodes.filter((node) => node.nodeType !== "authority_checkpoint");

    // Model usage is read from the durable provider usage rows, not from the
    // node cost fields. Those two agree today, but the usage rows are the
    // primary record of "a provider was reached", and a summary should be
    // derived from the fact rather than from a copy of it.
    const providerUsage = this.journal.listProviderUsage(missionId);
    const measured = providerUsage.filter((usage) => usage.typedError === null);
    const inputTokens = measured
      .map((usage) => usage.inputTokens)
      .filter((value): value is number => typeof value === "number");
    const outputTokens = measured
      .map((usage) => usage.outputTokens)
      .filter((value): value is number => typeof value === "number");
    const monetary = measured
      .map((usage) => usage.monetaryCostMicros)
      .filter((value): value is number => typeof value === "number");
    const costSources = new Set(measured.map((usage) => usage.monetaryCostSource));
    const sum = (values: readonly number[]): number =>
      values.reduce((total, value) => total + value, 0);

    return {
      objectiveSatisfied: verified,
      acceptanceCriteriaPassed: machineCheckable.length > 0
        && acceptanceEvaluation
          .filter((entry) => machineCheckableIds.has(String(entry.criterionId)))
          .every((entry) => entry.passed === true),
      acceptedClaimCount: acceptedClaims,
      rejectedClaimCount: rejectedClaims,
      evidenceCoverage: evidenceIndex,
      uncertaintyCount: Array.isArray(synthesisOutput?.remainingUncertainty)
        ? synthesisOutput.remainingUncertainty.length
        : 0,
      artifactHash: mission.artifactHash,
      artifactWriteCount: this.journal.countArtifactWrites(missionId),
      workerCount: workerNodes.filter((node) => node.state === "completed").length,
      parallelismObserved: observedParallelism(events),
      toolCallCount: nodes.reduce((total, node) => total + (node.cost?.toolCalls ?? 0), 0),
      modelCallCount: nodes.reduce((total, node) => total + (node.cost?.modelCalls ?? 0), 0),
      tokenCost: tokenCosts.length > 0 ? tokenCosts.reduce((total, value) => total + value, 0) : null,
      monetaryCost: monetaryCosts.length > 0
        ? monetaryCosts.reduce((total, value) => total + value, 0)
        : null,
      latencyMs: nodes.reduce((total, node) => total + (node.latencyMs ?? 0), 0),
      humanApprovals: (mission.executionApprovedBy ? 1 : 0) + (mission.candidateApprovedBy ? 1 : 0),
      recoveryEvents: events.filter((event) => event.eventType === "node_reconciled").length,
      duplicateExecutionsPrevented: events.filter((event) =>
        event.reason.includes("no second worker invocation occurred")).length,
      modelWorkerCount: nodes.filter((node) => node.workerKind === "model_worker").length,
      providerCallCount: providerUsage.length,
      providerFallbackCount: providerUsage.filter(
        (usage) => usage.fallbackDecision === "fallback_used",
      ).length,
      inputTokenCount: inputTokens.length > 0 ? sum(inputTokens) : null,
      outputTokenCount: outputTokens.length > 0 ? sum(outputTokens) : null,
      totalTokenCount: inputTokens.length > 0 && outputTokens.length > 0
        ? sum(inputTokens) + sum(outputTokens)
        : null,
      tokenCostSource: inputTokens.length > 0 ? "provider_measured" : "not_measured",
      // `null`, not zero, whenever nothing measured a charge. An unpriced local
      // provider produces no invoice, and reporting `0` would be a claim about
      // a bill that was never issued.
      monetaryCostMicros: monetary.length > 0 ? sum(monetary) : null,
      monetaryCostSource: costSources.size === 0
        ? "not_measured"
        : costSources.size === 1
          ? ([...costSources][0] as AgenticValueObservation["monetaryCostSource"])
          : "mixed",
      // A model node that completed because a reconcile *found* its durable
      // worker result is a provider call that would otherwise have been made
      // twice. Keyed on the reconciliation outcome rather than on an attempt
      // count, because the whole point of recovery is that attempts do **not**
      // increase — counting attempts would report zero exactly when a duplicate
      // was most decisively prevented.
      duplicateModelCallsPrevented: nodes.filter((node) =>
        node.workerKind === "model_worker"
        && node.reconciliationOutcome === "worker_result_found"
        && this.journal.countProviderCallsForNode(node.idempotencyKey) > 0).length,
      // Only calls that actually carried a charge. A local unbilled call and a
      // failed dispatch both cost nothing, and counting them here would make an
      // unbilled run indistinguishable from a billed one.
      billedProviderCallCount: measured.filter((usage) => usage.monetaryCostMicros !== null).length,
      billingReconciliationVerdict: (() => {
        const billed = measured.filter((usage) => usage.monetaryCostMicros !== null);
        if (billed.length === 0) return "not_attempted";
        const verdicts = new Set(billed.map((usage) => usage.reconciliation.verdict));
        // A single disagreement is reported as such even when other calls
        // matched: `mixed` is the honest answer, and collapsing it to the
        // majority verdict would hide the only charge worth investigating.
        return verdicts.size === 1
          ? ([...verdicts][0] as AgenticValueObservation["billingReconciliationVerdict"])
          : "mixed";
      })(),
      modelIdentitiesUsed: [...new Set(
        providerUsage.map((usage) => `${usage.providerName}/${usage.modelId}`),
      )].sort(),
      providerUsageReferences: providerUsage.map((usage) => usage.providerCallKey).sort(),
    };
  }

  private project(mission: AgenticMissionRecord): AgenticMissionView {
    const events = this.journal.listEvents(mission.missionId);
    return {
      schemaVersion: AGENTIC_MISSION_VIEW_SCHEMA_VERSION,
      missionId: mission.missionId,
      traceId: mission.traceId,
      workspaceId: mission.workspaceId,
      actorId: mission.actorId,
      objective: mission.objective,
      status: mission.status,
      missionRevision: events.length,
      intentHash: mission.intentHash,
      contextBundleId: mission.contextBundleId,
      planId: mission.planId,
      planHash: mission.planHash,
      authority: {
        executionApprovalRequired: true,
        executionApprovedBy: mission.executionApprovedBy,
        candidateHash: mission.candidateHash,
        approvedCandidateHash: mission.approvedCandidateHash,
        candidateApprovedBy: mission.candidateApprovedBy,
        candidateApprovalExpiresAt: mission.candidateApprovalExpiresAt,
        authorityRevision: mission.candidateAuthorityRevision,
      },
      artifact: {
        artifactName: mission.artifactName,
        artifactHash: mission.artifactHash,
        writeCount: this.journal.countArtifactWrites(mission.missionId),
      },
      valueObservation: mission.valueObservation,
      typedError: mission.typedError,
      nextPermittedActions: this.permittedActions(mission),
      requestedAt: mission.requestedAt,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    };
  }

  /**
   * Advisory guidance only.
   *
   * Whether an action is accepted stays a decision of the code that owns it —
   * re-deciding it here would create a second authority that can only diverge
   * from the first.
   */
  private permittedActions(mission: AgenticMissionRecord): string[] {
    switch (mission.status) {
      case "compiled":
      case "approval_required":
        return ["approve", "stop"];
      case "approved":
      case "running":
        return ["stop"];
      case "awaiting_authority":
        return ["approve-candidate", "stop"];
      case "reconciliation_required":
        return ["reconcile", "stop"];
      case "failed_recoverable":
        return ["reconcile", "resume", "stop"];
      case "completed":
      case "failed_terminal":
      case "cancelled":
        return [];
    }
  }
}
