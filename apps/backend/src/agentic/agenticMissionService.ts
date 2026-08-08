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
  reconcileRecordedCharges,
  type AgenticBillingReconciliationSummary,
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
  requireArtifactOutputContract,
  requireExceptionContract,
  type AgenticAcceptanceCriterion,
  type AgenticIntentContract,
  type AgenticNodeState,
  type AgenticValueObservation,
} from "./agenticMissionContract.js";
import type { AgenticExceptionIntakeState } from "./agenticPlanJournal.js";
import type { OperationalConnector } from "./agenticSimulatedConnector.js";
import {
  compileActionContract,
  computeStateDelta,
  createDesiredStateHash,
  createObservationHash,
  exceptionFieldsFrom,
  OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  renderActionContractCandidate,
  type ActionContract,
  type DesiredState,
  type ExceptionFieldValue,
  type ExceptionValueObservation,
  type ObservedState,
  type OperationalExceptionTerminalState,
  type TerminalOutcome,
  ABSENT_SOURCE_REVISION,
} from "./agenticExceptionContract.js";

/**
 * The capability a compensating connector write runs under.
 *
 * Named here rather than imported from the registry to keep the value
 * projection free of a dependency on capability wiring — it needs the identity,
 * not the definition.
 */
const EXCEPTION_COMPENSATE_CAPABILITY = "connector.state.compensate" as const;

/** Why a mission is in each terminal state. One sentence, no interpretation. */
const TERMINAL_OUTCOME_REASONS: Readonly<Record<OperationalExceptionTerminalState, string>> =
  Object.freeze({
    completed_verified:
      "An independent oracle re-observed the source and confirmed it satisfies the desired state.",
    completed_verified_compensated:
      "A real external write was performed, independently verified, then removed by the approved "
      + "compensating action, and its absence independently verified. The external system is back "
      + "in the state it was observed in.",
    blocked: "The mission is waiting on an authority decision it cannot make for itself.",
    failed: "The mission stopped without reaching a verified resolution.",
    unknown_requires_human:
      "An outcome is ambiguous and must be reconciled by a human before anything else happens.",
    shadow_verified_ready:
      "The real source was observed, an exact action was compiled and approved, no write was "
      + "performed or reachable, and an independent read-only re-read confirmed the source is "
      + "unchanged. The external exception is NOT resolved.",
    shadow_stale_reobserve:
      "The real source moved after it was observed, so the compiled action no longer applies and "
      + "the mission must re-observe before anything is claimed.",
    shadow_blocked:
      "The shadow mission stopped before establishing readiness; no write was performed.",
    shadow_unknown_requires_human:
      "A shadow outcome is ambiguous and must be resolved by a human. No write was performed.",
  });
import {
  assertAgenticIntentUnchanged,
  compileAgenticIntent,
} from "./agenticIntentCompiler.js";
import { compileVerifiedContext, type AgenticContextSourcePort } from "./agenticContextCompiler.js";
import {
  authorityCheckpointNodeId,
  compileAgenticPlan,
  executionModeOf,
  terminalVerificationNodeId,
} from "./agenticPlanCompiler.js";
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
import { createAgenticExceptionWorkerSet, createAgenticWorkerSet } from "./agenticWorkers.js";
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
  /**
   * How billing lookups wait between polls. Injected only so a test can prove
   * the poll sequence without sleeping through the real backoff schedule.
   */
  readonly billingReconciliationWait?: (milliseconds: number) => Promise<void>;
  /**
   * Provider transports, overriding those derived from configuration.
   *
   * Injected the same way `governor` is, and for the same reason: a transport is
   * a dependency, not a policy. It cannot change *what is bought* — model
   * identity, price mode, and data handling all come from the code-defined
   * binding registry, which this does not touch. It only changes how the request
   * travels, which is what lets a test drive a billing-record endpoint without a
   * live account.
   */
  readonly providerAdapters?: GovernedModelInvocationOptions["adapters"];
  /**
   * The operational connector this deployment can reach, if any.
   *
   * Optional because a deployment may run the artifact lane alone. Without one,
   * an operational-exception submission is refused at intake rather than
   * compiled into a plan whose one consequential node could never execute.
   */
  readonly connector?: OperationalConnector;
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
      adapters: dependencies.providerAdapters
        ?? createAgenticProviderAdapters(dependencies.configuration.providers),
      usageStore: this.journal.createProviderUsageStore(),
      ...(dependencies.providerFailureInjector
        ? { failureInjector: dependencies.providerFailureInjector }
        : {}),
      // The inline billing lookup polls past a provider's eventual consistency,
      // which means it genuinely waits. Threading the same injected wait here
      // keeps a test from sleeping through a real backoff schedule on the
      // node's critical path.
      ...(dependencies.billingReconciliationWait
        ? { reconciliationWait: dependencies.billingReconciliationWait }
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
    }, dependencies.connector === undefined ? undefined : {
      manifest: () => dependencies.connector!.manifest() as unknown as JsonValue,
      read: (targetId) => (dependencies.connector!.read(targetId) ?? null) as unknown as JsonValue,
      // Forwarded only when the connector actually has them. A read-only
      // connector produces a port with these properties absent, so the tool
      // surface refuses at the boundary rather than calling into nothing.
      ...(typeof dependencies.connector.readAction === "function"
        ? {
          readAction: (key: string, targetId?: string) =>
            (dependencies.connector!.readAction!(key, targetId) ?? null) as unknown as JsonValue,
        }
        : {}),
      ...(typeof dependencies.connector.apply === "function"
        ? {
          apply: (request: {
            readonly capability: string;
            readonly targetId: string;
            readonly expectedPreStateHash: string;
            readonly writePayload: readonly { readonly field: string; readonly value: JsonValue }[];
            readonly writePayloadHash: string;
            readonly idempotencyKey: string;
          }) => dependencies.connector!.apply!({
            capability: request.capability,
            targetId: request.targetId,
            expectedPreStateHash: request.expectedPreStateHash,
            writePayload: request.writePayload.map((entry) => ({
              field: entry.field,
              value: entry.value as ExceptionFieldValue,
            })),
            writePayloadHash: request.writePayloadHash,
            idempotencyKey: request.idempotencyKey,
          }) as unknown as JsonValue,
        }
        : {}),
      // Forwarded on the same terms as `apply`, and separately from it: a
      // connector that can write is not automatically one that can undo, and
      // the port must be able to represent that difference.
      ...(typeof dependencies.connector.compensate === "function"
        ? {
          compensate: (request: {
            readonly capability: string;
            readonly targetId: string;
            readonly expectedRevision: string;
            readonly idempotencyKey: string;
          }) => dependencies.connector!.compensate!({
            capability: request.capability,
            targetId: request.targetId,
            expectedRevision: request.expectedRevision,
            idempotencyKey: request.idempotencyKey,
          }) as unknown as JsonValue,
        }
        : {}),
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
    // Established before the plan is compiled, because the plan's authority
    // checkpoint exists to gate an action derived from this delta. A mission
    // whose source record is missing, whose connector is unregistered, or whose
    // delta is empty is refused here — before any node exists to approve.
    const exceptionState = intent.missionKind === "operational_exception"
      ? this.compileExceptionIntake(intent, compiledAt)
      : null;
    const compiled = compileAgenticPlan(intent, contextBundle);
    const mission = this.journal.insertMission({
      intent,
      contextBundle,
      plan: compiled.plan,
      routing: compiled.routing,
      timestamp: compiledAt,
      idempotencyKeyFor: (nodeId) => `${intent.missionId}:${compiled.plan.planId}:${nodeId}`,
      exceptionState,
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
    const checkpointNodeId = authorityCheckpointNodeId(
      mission.intent.missionKind,
      executionModeOf(mission.intent),
    );
    const consequence = mission.intent.missionKind !== "operational_exception"
      ? "one bounded local artifact write"
      : executionModeOf(mission.intent) === "shadow"
        // Named for what it is. A human approving a shadow action is authorizing
        // a record of intent, and telling them otherwise would be the one lie
        // this whole slice exists to avoid.
        ? "one bounded connector action that will be recorded and deliberately not performed"
        : "one bounded connector action";
    this.journal.updateMission(missionId, {
      eventType: "candidate_approved",
      actor: approver,
      reason: `A human authorized ${consequence} for these exact candidate bytes.`,
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
    this.journal.transitionNode(mission.planId, checkpointNodeId, "running", {
      actor: approver,
      reason: "A human began deciding this authority checkpoint.",
      timestamp,
      startedAt: timestamp,
    });
    this.journal.transitionNode(mission.planId, checkpointNodeId, "completed", {
      actor: approver,
      reason: `Human authority for ${consequence} was recorded.`,
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
    const candidate = (): { markdown: string; candidateHash: string } | null => {
      const current = this.journal.requireMission(mission.missionId);
      return current.candidateMarkdown && current.candidateHash
        ? { markdown: current.candidateMarkdown, candidateHash: current.candidateHash }
        : null;
    };

    // A mission is built with exactly the workers its own plan can route to.
    // An exception mission therefore holds no artifact-writing worker at all,
    // which is a stronger statement than refusing to call one.
    if (mission.intent.missionKind === "operational_exception") {
      return createAgenticExceptionWorkerSet({
        intent: mission.intent,
        contextBundle: mission.contextBundle,
        tools: this.tools,
        candidate,
        artifactWriteCount: () => 0,
        exceptionState: () => mission.exceptionState,
        actionDeadline: () => new Date(
          Date.parse(mission.requestedAt) + mission.intent.timeBudgetMs,
        ).toISOString(),
        executionMode: executionModeOf(mission.intent),
        // Read from the bound connector's manifest rather than derived from the
        // action's capability. The connector is the only authority on what its
        // own undo is called, and inferring `document.delete` from
        // `document.create` by string surgery would be a guess that happens to
        // work on today's names.
        ...(this.dependencies.connector !== undefined
          ? {
            compensationCapability: this.dependencies.connector
              .manifest()
              .writeCapabilitiesDeclared
              .find((entry) => entry.endsWith(".delete")),
          }
          : {}),
      });
    }

    return createAgenticWorkerSet({
      intent: mission.intent,
      contextBundle: mission.contextBundle,
      tools: this.tools,
      candidate,
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

    if (mission.intent.missionKind === "operational_exception") {
      return this.exceptionInputFor(mission, node, outputOf);
    }

    const outputContract = requireArtifactOutputContract(mission.intent);
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
          requiredSections: [...outputContract.requiredSections],
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
          artifactName: outputContract.artifactName,
          candidateHash: String(mission.approvedCandidateHash ?? ""),
          approvalId: `${mission.missionId}:N6`,
        };
      case "N8": {
        const verified = outputOf("N4");
        const synthesis = outputOf("N5");
        const rejected = (verified.rejectedClaims as Array<Record<string, JsonValue>> | undefined) ?? [];
        return {
          artifactName: outputContract.artifactName,
          approvedCandidateHash: String(mission.approvedCandidateHash ?? ""),
          requiredSections: [...outputContract.requiredSections],
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
    this.convergePlanFailure(
      mission.missionId,
      mission.actorId,
      unknownOutcome ? "reconciliation_required" : "failed_recoverable",
      `Node ${node.nodeId} did not complete.`,
      timestamp,
      result.typedError
        ? { code: result.typedError.code, message: result.typedError.message }
        : null,
    );
  }

  /**
   * Moves the plan to its aggregate failure state, once.
   *
   * Plan failure is a **convergence, not an event**. Every failed node
   * independently reports that the plan can no longer make progress, and one
   * admitted batch routinely produces several such reports — two independent
   * specialists failing for the same systematic reason is the ordinary case, not
   * an exotic one. The first report moves the plan; the rest re-assert a fact
   * that is already durable.
   *
   * Applying them anyway asks the state machine for `X -> X`, which it correctly
   * refuses. The visible symptom is perverse: the mission fails on its *second*
   * piece of bad news rather than its first, and reports a transition defect
   * instead of whatever actually went wrong.
   *
   * Fixed here rather than by admitting self-transitions to the journal's map.
   * `X -> X` genuinely is not a valid *transition*, and permitting it globally
   * would let every other state silently re-enter itself — including terminal
   * ones. What is legitimate is a caller recognising it has nothing left to
   * change. That is orchestration policy, and the service owns it; the journal
   * owns only whether a change is valid.
   *
   * Severity is never lowered. `reconciliation_required` means some node's
   * outcome is genuinely *unknown*, which is strictly more conservative than a
   * decided failure. A later decided failure must not downgrade it, or the plan
   * would read as merely recoverable while an unresolved side effect stands —
   * and a human would be invited to resume rather than to reconcile.
   */
  private convergePlanFailure(
    missionId: string,
    actor: string,
    targetState: Extract<AgenticNodeState, "reconciliation_required" | "failed_recoverable">,
    reason: string,
    timestamp: string,
    typedError: { code: string; message: string } | null,
  ): void {
    const current = this.journal.requireMission(missionId).status;
    if (current === targetState) return;
    if (current === "reconciliation_required" && targetState === "failed_recoverable") return;
    this.journal.transitionMission(missionId, targetState, {
      actor,
      reason,
      timestamp,
      typedError,
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
        artifactName: String(
          record.artifactName ?? requireArtifactOutputContract(current.intent).artifactName,
        ),
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

    // The candidate for an exception mission is the compiled ActionContract
    // itself, so the human approves the exact write rather than a description
    // of it. Rendered and hashed here, before anyone sees it, for the same
    // reason the artifact candidate is: what is approved and what is applied
    // must be the same bytes by construction.
    if (node.nodeId === "X2") {
      const contract = this.exceptionActionContract(mission, record);
      const candidate = renderActionContractCandidate(contract);
      const candidateHash = createAgenticCandidateHash(candidate);
      this.journal.updateMission(mission.missionId, {
        eventType: "candidate_prepared",
        actor: mission.actorId,
        reason:
          "An action contract was compiled from the approved state delta and bound to an exact hash.",
        timestamp,
        candidateHash,
        candidateMarkdown: candidate,
        evidenceReferences: [
          `candidate-sha256:${candidateHash}`,
          `action-contract:${contract.actionContractHash}`,
        ],
      });
    }

    if (node.nodeId === terminalVerificationNodeId(mission.intent.missionKind, executionModeOf(mission.intent))) {
      this.finishMission(mission.missionId, record, timestamp);
    }
  }

  /**
   * Rebuilds the ActionContract from durable intake state and X2's own output.
   *
   * Recompiled rather than trusted from the node's output: the worker reports
   * hashes, and this is the one place those hashes are checked against a
   * contract derived independently from the delta the human is about to see. A
   * worker that reported a payload it did not compute is caught here.
   */
  private exceptionActionContract(
    mission: AgenticMissionRecord,
    record: Record<string, JsonValue>,
  ): ActionContract {
    const exception = requireExceptionContract(mission.intent);
    const intake = this.exceptionIntake(mission);
    const contract = compileActionContract({
      missionId: mission.missionId,
      connectorId: exception.connectorId,
      capability: String(record.capability ?? ""),
      targetId: exception.targetId,
      expectedPreStateHash: intake.observed.observationHash,
      delta: intake.delta,
      deadline: new Date(
        Date.parse(mission.requestedAt) + mission.intent.timeBudgetMs,
      ).toISOString(),
    });
    if (contract.actionContractHash !== String(record.actionContractHash ?? "")) {
      throw new OperatorError(
        "The compiled action contract does not match the hash the node reported.",
        409,
        "AGENTIC_EXCEPTION_ACTION_CONTRACT_MISMATCH",
      );
    }
    return contract;
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
    // Each oracle reports its own verdict under its own name, and the terminal
    // check reads the one that belongs to this plan. A shadow oracle judges the
    // shadow contract, so calling its answer `outcomeVerified` would have meant
    // one word carrying two different claims — and the whole point of the shadow
    // vocabulary is that those two claims never get confused.
    // `absenceVerified` joins them for the same reason the shadow verdict has
    // its own name: the compensated plan's terminal oracle judges that the
    // object is *gone*, and reusing `outcomeVerified` for that would make one
    // word mean both "the write is there" and "the write is not there".
    const verified = outcome.outcomeVerified === true
      || outcome.shadowVerified === true
      || outcome.absenceVerified === true;
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
            message: "Independent verification did not confirm this mission's terminal condition.",
          },
        }),
      evidenceReferences: [`artifact-sha256:${String(outcome.artifactHash ?? "")}`],
    });
  }

  /**
   * The mission's terminal answer, projected from durable plan truth.
   *
   * A projection, never a stored second opinion. The fabric owns one reviewed
   * lifecycle with one set of legal transitions, and writing these four states
   * into their own column would create a second authority over the same fact —
   * one that could disagree with the plan it claims to summarize.
   *
   * `completed_verified` is unreachable except through a passing oracle, and
   * structurally so: the plan cannot reach `completed` without one.
   */
  terminalOutcome(missionId: string): TerminalOutcome {
    const mission = this.journal.requireMission(missionId);
    const verificationNodeId = terminalVerificationNodeId(mission.intent.missionKind, executionModeOf(mission.intent));
    const oracle = this.journal.getNode(mission.planId, verificationNodeId);
    const output = oracle?.output;
    const verified = output !== null && output !== undefined && typeof output === "object"
      && !Array.isArray(output)
      && (output as Record<string, JsonValue>).outcomeVerified === true;

    // Shadow missions project into their own terminal vocabulary. Separate
    // names rather than a flag beside the live ones, because
    // `shadow_verified_ready` must never be readable as "the exception was
    // resolved" — nothing was changed, and the whole slice is worthless if that
    // distinction can be lost in a projection.
    const shadow = executionModeOf(mission.intent) === "shadow";
    const shadowVerified = verified
      || (output !== null && output !== undefined && typeof output === "object"
        && !Array.isArray(output)
        && (output as Record<string, JsonValue>).shadowVerified === true);
    const revisionMoved = output !== null && output !== undefined && typeof output === "object"
      && !Array.isArray(output)
      && (output as Record<string, JsonValue>).revisionUnchanged === false;

    // A compensated mission's terminal oracle judges *absence*, so its verdict
    // lives under a different key. Reading `outcomeVerified` here would find
    // nothing and quietly report unverified, which is the failure mode a
    // separate oracle was introduced to avoid.
    const compensated = executionModeOf(mission.intent) === "live_compensated";
    const absenceVerified = output !== null && output !== undefined && typeof output === "object"
      && !Array.isArray(output)
      && (output as Record<string, JsonValue>).absenceVerified === true;
    // §16: worker success alone is insufficient. The write must have been
    // verified present before it can be claimed verified absent — otherwise a
    // mission that never wrote anything would reach the compensated terminal by
    // observing an emptiness it never disturbed.
    const primaryVerified = (() => {
      if (!compensated) return false;
      const primary = this.journal.getNode(mission.planId, "X5")?.output;
      return primary !== null && primary !== undefined && typeof primary === "object"
        && !Array.isArray(primary)
        && (primary as Record<string, JsonValue>).outcomeVerified === true;
    })();

    const state: OperationalExceptionTerminalState = compensated
      ? mission.status === "completed" && primaryVerified && absenceVerified
        ? "completed_verified_compensated"
        : mission.status === "reconciliation_required"
          ? "unknown_requires_human"
          : mission.status === "failed_terminal" || mission.status === "failed_recoverable"
            ? "failed"
            : "blocked"
      : shadow
      ? mission.status === "completed"
        ? "shadow_verified_ready"
        : mission.status === "reconciliation_required"
          ? "shadow_unknown_requires_human"
          : revisionMoved
            // The source moved under us. Not a failure of this fabric — someone
            // else may have pushed — but a reason to re-observe rather than to
            // claim readiness against a state that no longer exists.
            ? "shadow_stale_reobserve"
            : mission.status === "failed_terminal" || mission.status === "failed_recoverable"
              ? "shadow_blocked"
              : "shadow_blocked"
      : mission.status === "completed"
        ? "completed_verified"
        : mission.status === "reconciliation_required"
          ? "unknown_requires_human"
          : mission.status === "failed_terminal" || mission.status === "failed_recoverable"
            ? "failed"
            : "blocked";

    return {
      schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
      missionId,
      state,
      // Read from the oracle's own durable output, not inferred from the plan
      // state. The two agree today; if they ever disagreed, the honest report is
      // the oracle's, and this makes that disagreement visible.
      verified: compensated
        ? primaryVerified && absenceVerified
        : shadow ? shadowVerified : verified,
      reason: TERMINAL_OUTCOME_REASONS[state],
      verificationReference: oracle?.outputHash === undefined || oracle.outputHash === null
        ? null
        : `verification:${oracle.outputHash}`,
    };
  }

  /**
   * Bounded operational measures for one exception mission.
   *
   * Every field is counted from a durable row. There is deliberately no
   * commercial figure: this fixture is an architecture proof, and an ROI number
   * derived from it would be invented rather than measured.
   */
  exceptionValueObservation(missionId: string): ExceptionValueObservation {
    const mission = this.journal.requireMission(missionId);
    const nodes = this.journal.listNodes(mission.planId);
    const events = this.journal.listEvents(missionId);
    const providerUsage = this.journal.listProviderUsage(missionId);
    const verifyNode = nodes.find((node) => node.nodeType === "outcome_verify");

    // The connector's own count, not ours. "Exactly one action occurred" is a
    // fact about the external system, so it is read from the oracle's
    // independent observation of it rather than from our attempt count.
    const verifyOutput = verifyNode?.output;
    const connectorWrites = verifyOutput !== null && verifyOutput !== undefined
      && typeof verifyOutput === "object" && !Array.isArray(verifyOutput)
      ? Number((verifyOutput as Record<string, JsonValue>).connectorWriteCount ?? 0)
      : 0;

    // Compensation is counted from its own node rather than folded into the
    // write count: "changed the world once and put it back" and "changed the
    // world twice" must not report as the same number.
    //
    // Identified by capability rather than by a new node type. A compensating
    // delete genuinely *is* a connector write, so `connector_apply` is the
    // honest type for it — and keeping it that way preserves the property the
    // shadow node type exists to protect: "this plan contains no write node"
    // stays answerable by reading node types alone.
    const compensateNode = nodes.find(
      (node) => node.capabilityId === EXCEPTION_COMPENSATE_CAPABILITY,
    );
    const compensateOutput = compensateNode?.output;
    const compensationWrites = compensateOutput !== null && compensateOutput !== undefined
      && typeof compensateOutput === "object" && !Array.isArray(compensateOutput)
      ? Number((compensateOutput as Record<string, JsonValue>).connectorCompensationCount ?? 0)
      : 0;

    // Reads issued to resolve an ambiguous outcome, reported by the worker that
    // issued them. Counted rather than inferred from retry attempts, because a
    // reconciliation that found the action already applied leaves no retry.
    const reconciliationReads = nodes.reduce((total, node) => {
      const output = node.output;
      if (output === null || output === undefined || typeof output !== "object" || Array.isArray(output)) {
        return total;
      }
      return total + Number((output as Record<string, JsonValue>).connectorReconciliationReads ?? 0);
    }, 0);

    const completedAt = events.find(
      (event) => event.scope === "plan" && event.newState === "completed",
    )?.timestamp ?? null;

    const mode = executionModeOf(mission.intent);
    const observeNode = nodes.find((node) => node.nodeType === "state_observe");
    const compileNode = nodes.find((node) => node.nodeType === "action_compile");
    const observeOutput = observeNode?.output;
    const observeRecord = observeOutput !== null && observeOutput !== undefined
      && typeof observeOutput === "object" && !Array.isArray(observeOutput)
      ? (observeOutput as Record<string, JsonValue>)
      : {};
    // A re-read that disagreed with intake. Counted from the observe node's own
    // report rather than inferred from a failure, so it is visible even when the
    // mission went on to succeed.
    const staleObservations = observeRecord.matchesIntakeObservation === false ? 1 : 0;
    const revisions = new Set<string>();
    if (mission.exceptionState) revisions.add(mission.exceptionState.observed.sourceRevision);
    if (typeof observeRecord.sourceRevision === "string") {
      revisions.add(observeRecord.sourceRevision);
    }

    return {
      schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
      missionId,
      executionMode: mode,
      // One read at intake plus one per completed observe attempt. Counted, not
      // assumed: a mission that never reached the observe node reports fewer.
      sourceReads: (mission.exceptionState ? 1 : 0) + (observeNode?.attempts ?? 0),
      sourceRevisionsObserved: revisions.size,
      staleObservations,
      shadowActionsCompiled: compileNode?.state === "completed" ? 1 : 0,
      verificationReads: verifyNode?.attempts ?? 0,
      // Measured from the bound connector's own declaration rather than assumed.
      //
      // Until P0-C this was the literal `0` and true by construction: shadow
      // missions cannot write, and the only live connector owned a local store.
      // Now that a connector can declare `realExternalWrites`, the honest number
      // is the write count *when the connector says its writes are real* — and
      // still exactly `0` for every simulated binding, which is what keeps every
      // predecessor proof's assertion true rather than merely still passing.
      realExternalWrites: mission.exceptionState?.connectorManifest.realExternalWrites
        ? connectorWrites
        : 0,
      compensationWrites: mission.exceptionState?.connectorManifest.realExternalWrites
        ? compensationWrites
        : 0,
      reconciliationReads,
      // Structural, not measured: this fabric's only retry path runs through
      // `investigate`, which reads durable truth before deciding. There is no
      // code path that retries an action without first asking what happened.
      blindRetries: 0,
      exceptionDetected: mission.exceptionState ? 1 : 0,
      stateChangingActions: connectorWrites,
      // Attempts beyond the first that still produced one action. Zero is the
      // guarantee; a positive number would mean the single-write property broke.
      duplicateActions: Math.max(0, connectorWrites - 1),
      humanApprovals: events.filter((event) => event.eventType === "candidate_approved").length,
      reconciliationCount: nodes.filter((node) => node.reconciliationOutcome !== null).length,
      verificationCount: verifyNode?.attempts ?? 0,
      timeToVerifiedResolutionMs: completedAt === null
        ? null
        : Date.parse(completedAt) - Date.parse(mission.requestedAt),
      // Zero, and measured rather than assumed: this plan routes nothing to a
      // model, so a non-zero figure here would mean something unexpected ran.
      providerCostMicros: providerUsage.reduce(
        (total, usage) => total + (usage.monetaryCostMicros ?? 0),
        0,
      ),
      providerCalls: providerUsage.length,
    };
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
    } else if (
      node.state === "failed_recoverable"
      && node.capabilityId !== null
      && requireAgenticCapability(node.capabilityId).sideEffectClass !== "none"
    ) {
      // A side-effecting node that *failed* is still ambiguous, and belongs in
      // the state that says so. The throw may have come from the transport
      // after the external system already acted, so "the worker failed" and
      // "nothing happened" are different facts — and only the state named for
      // ambiguity permits the resume that commits downstream truth.
      node = this.journal.transitionNode(mission.planId, nodeId, "reconciliation_required", {
        actor: mission.actorId,
        reason:
          "A node that can change something outside itself failed without establishing its outcome, "
          + "so that outcome is unknown until the downstream system is asked.",
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

  // -------------------------------------------------------------------------
  // Billing reconciliation
  // -------------------------------------------------------------------------

  /**
   * Re-reads this mission's recorded charges from the providers that issued them.
   *
   * Separate from `reconcileNode`, which resolves an *execution* ambiguity. This
   * resolves a *financial* one: the charge is known and durable, and what is
   * missing is the counterparty's own confirmation of it.
   *
   * It exists because the inline attempt runs milliseconds after the provider
   * answers, and a provider's billing record is written after the completion
   * returns. The first live billed run lost both verdicts to that race — two
   * real charges, two generation ids, two `HTTP 404`s three milliseconds later —
   * and had no way to ask again, because a mission replay is refused at
   * `AGENTIC_PROVIDER_ALREADY_INVOKED` before reconciliation is reachable.
   *
   * The generation ids were already durable. This is the reader for them, and it
   * is safe to call at any time, from any process, any number of times: the only
   * provider method it can reach is `reconcile`, so no invocation of it can
   * produce a second inference call or a second charge.
   */
  async reconcileBilling(missionId: string): Promise<AgenticBillingReconciliationSummary> {
    // Requires a real mission, so an unknown id is a typed 404 rather than a
    // vacuously successful reconciliation of nothing.
    const mission = this.journal.requireMission(missionId);
    const summary = await reconcileRecordedCharges(this.journal.listProviderUsage(missionId), {
      registry: this.providerInvocation.registry,
      adapters: this.providerInvocation.adapters,
      usageStore: this.providerInvocation.usageStore,
      ...(this.dependencies.billingReconciliationWait
        ? { wait: this.dependencies.billingReconciliationWait }
        : {}),
    });

    // The mission's durable value observation carries a billing verdict, and it
    // was computed when the mission finished — before this evidence existed. A
    // completed mission whose charges are now confirmed must not keep asserting
    // that they are unconfirmed: that is a stale financial statement, and the
    // number a human reads later is this one, not the reconciliation response.
    //
    // Only the two billing fields are refreshed, and only when they actually
    // change, and the refresh is journaled as its own event. Everything else the
    // observation asserts was measured at completion and stays exactly as
    // recorded — this is an added confirmation, not a re-opened mission.
    const observation = mission.valueObservation;
    if (observation && summary.chargesConsidered > 0) {
      const refreshed: AgenticValueObservation = {
        ...observation,
        billedProviderCallCount: summary.chargesConsidered,
        billingReconciliationVerdict: summary.verdict,
      };
      if (refreshed.billingReconciliationVerdict !== observation.billingReconciliationVerdict
        || refreshed.billedProviderCallCount !== observation.billedProviderCallCount) {
        this.journal.updateMission(missionId, {
          eventType: "mission_billing_reconciled",
          actor: mission.actorId,
          reason: `Provider-owned billing evidence for ${summary.chargesConfirmed} of `
            + `${summary.chargesConsidered} charge(s) resolved the verdict to ${summary.verdict}.`,
          timestamp: this.now(),
          valueObservation: refreshed,
          evidenceReferences: summary.outcomes
            .filter((outcome) => outcome.providerRequestId !== null)
            .map((outcome) => `provider-generation:${String(outcome.providerRequestId)}`),
        });
      }
    }
    return summary;
  }

  // -------------------------------------------------------------------------
  // Operational exception
  // -------------------------------------------------------------------------

  /**
   * Establishes ObservedState, DesiredState, and StateDelta, once, at intake.
   *
   * Ordering matters and is deliberate. DesiredState is derived purely from what
   * the human asked for, *before* the source is read, so it cannot be shaped by
   * what happens to be there. ObservedState is then read from the connector.
   * The delta is the difference, and it is a pure function of the two — which is
   * why re-deriving it later reproduces the same hash or proves the world moved.
   *
   * Refuses a mission whose delta is empty: an exception with nothing to change
   * is not an exception, and compiling a plan whose one write has no payload
   * would put a meaningless approval in front of a human.
   */
  private compileExceptionIntake(
    intent: AgenticIntentContract,
    observedAt: string,
  ): AgenticExceptionIntakeState {
    const exception = requireExceptionContract(intent);
    const connector = this.dependencies.connector;
    if (!connector) {
      throw new OperatorError(
        "No operational connector is configured, so an operational-exception mission cannot be admitted.",
        503,
        "AGENTIC_CONNECTOR_UNAVAILABLE",
      );
    }
    if (connector.connectorId !== exception.connectorId) {
      throw new OperatorError(
        `This deployment registers connector ${connector.connectorId}, not ${exception.connectorId}.`,
        409,
        "AGENTIC_CONNECTOR_MISMATCH",
      );
    }

    // Two independent gates on the one consequential direction, and neither is
    // a runtime check on the write itself.
    //
    // A live mission against a connector that declares it cannot write is
    // refused here, at intake, before a plan exists — because such a plan would
    // compile a write node whose capability the connector has no method for,
    // and the failure would surface after a human had already approved it.
    const manifest = connector.manifest();
    // Both live modes write, so both are gated. Matching only `"live"` here
    // would have let the newer mode — the one that performs a *real* external
    // write — past the very check the older, simulated one has to pass.
    const writesSomething = exception.executionMode === "live"
      || exception.executionMode === "live_compensated";
    if (writesSomething && !manifest.writeCapabilitiesEnabled) {
      throw new OperatorError(
        `Connector ${connector.connectorId} declares write capabilities disabled, so it can only be `
        + "bound in shadow mode. A configured credential does not imply write authority.",
        409,
        "AGENTIC_CONNECTOR_WRITE_DISABLED",
      );
    }
    // And the converse: `apply` genuinely absent from the object is the fact
    // that matters, so a connector claiming to be write-enabled while exposing
    // no write method is a contradiction rather than a usable binding.
    if (writesSomething && typeof connector.apply !== "function") {
      throw new OperatorError(
        `Connector ${connector.connectorId} exposes no write method, so no live mission may bind it.`,
        409,
        "AGENTIC_CONNECTOR_WRITE_UNAVAILABLE",
      );
    }
    // The readiness gate's central rule, enforced where a mission is actually
    // bound: a write is only as safe as its undo. A connector that can change a
    // real system but cannot remove what it changed must not be bound to a
    // mission that intends to change it.
    if (exception.executionMode === "live_compensated") {
      if (typeof connector.compensate !== "function"
        || manifest.compensationSupport === "none") {
        throw new OperatorError(
          `Connector ${connector.connectorId} cannot compensate, so it may not be bound to a `
          + "compensated mission. A write with no undo is not made safe by intending to undo it.",
          409,
          "AGENTIC_CONNECTOR_NOT_COMPENSABLE",
        );
      }
      // A real external write belongs only against a target CHANTER OS owns
      // outright. `real_read_only` and `simulated` are refused here, and so is
      // any future production environment: the mode names the sandbox exactly.
      if (manifest.environment !== "real_sandbox") {
        throw new OperatorError(
          `Connector ${connector.connectorId} declares environment ${manifest.environment}; a `
          + "compensated real-write mission may only bind a real_sandbox connector.",
          409,
          "AGENTIC_CONNECTOR_ENVIRONMENT_FORBIDDEN",
        );
      }
    }

    const desiredBase = {
      missionId: intent.missionId,
      targetId: exception.targetId,
      desiredFields: exception.desiredFields,
      acceptanceConstraints: exception.acceptanceConstraints,
    };
    const desired: DesiredState = {
      schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
      ...desiredBase,
      desiredStateHash: createDesiredStateHash(desiredBase),
    };

    const record = connector.read(exception.targetId);
    // A create's pre-state is that the object is not there, so for a compensated
    // mission absence is the *expected* observation rather than a missing
    // target. Every other mode still refuses: a mission that intends to change
    // an existing record and cannot find it has nothing to compute a delta from.
    const createsAbsentObject = exception.executionMode === "live_compensated";
    if (!record && !createsAbsentObject) {
      throw new OperatorError(
        `Connector ${connector.connectorId} holds no record ${exception.targetId}.`,
        409,
        "AGENTIC_EXCEPTION_TARGET_MISSING",
      );
    }
    if (record && createsAbsentObject) {
      // The approved pre-state was absence and the object is already there.
      // Refusing at intake means no plan is compiled and no human is asked to
      // approve a create that could only fail — or worse, succeed by overwriting.
      throw new OperatorError(
        `Object ${exception.targetId} already exists, so a create-if-absent mission cannot be `
        + "bound to it. The approved pre-state is absence.",
        409,
        "AGENTIC_EXCEPTION_TARGET_ALREADY_EXISTS",
      );
    }
    const observedBase = {
      missionId: intent.missionId,
      sourceSystemId: connector.connectorId,
      targetId: record?.targetId ?? exception.targetId,
      sourceRevision: record?.revision ?? ABSENT_SOURCE_REVISION,
      observedFields: record ? exceptionFieldsFrom(record.fields) : [],
    };
    const observed: ObservedState = {
      schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
      ...observedBase,
      observationTime: observedAt,
      observationHash: createObservationHash(observedBase),
    };

    const delta = computeStateDelta(observed, desired);
    if (delta.changes.length === 0) {
      throw new OperatorError(
        `Record ${exception.targetId} already satisfies the desired state; there is no exception to resolve.`,
        409,
        "AGENTIC_EXCEPTION_NO_DELTA",
      );
    }

    return { observed, desired, delta, connectorManifest: connector.manifest() };
  }

  /** The durable intake state, or a typed refusal if the mission carries none. */
  private exceptionIntake(mission: AgenticMissionRecord): AgenticExceptionIntakeState {
    if (!mission.exceptionState) {
      throw new OperatorError(
        `Mission ${mission.missionId} carries no durable operational-exception state.`,
        409,
        "AGENTIC_EXCEPTION_STATE_MISSING",
      );
    }
    return mission.exceptionState;
  }

  /**
   * The bounded input for one operational-exception node.
   *
   * Each node receives exactly the hashes it must bind to and nothing else. In
   * particular the apply node is handed the approved candidate hash rather than
   * the payload: it re-derives the payload from the durable ActionContract and
   * re-hashes it, so an approval can never be carried onto different bytes.
   */
  private exceptionInputFor(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
    outputOf: (nodeId: string) => Record<string, JsonValue>,
  ): JsonValue {
    const exception = requireExceptionContract(mission.intent);
    const intake = this.exceptionIntake(mission);

    switch (node.nodeId) {
      case "X1":
        return {
          connectorId: exception.connectorId,
          targetId: exception.targetId,
          // What intake saw. The node re-reads the connector and compares, so a
          // record that moved since submission is detected rather than assumed.
          expectedObservationHash: intake.observed.observationHash,
        };
      case "X2":
        return {
          connectorId: exception.connectorId,
          targetId: exception.targetId,
          observationHash: String(outputOf("X1").observationHash ?? ""),
          deltaHash: intake.delta.deltaHash,
        };
      case "X4":
        return {
          actionContractHash: String(outputOf("X2").actionContractHash ?? ""),
          candidateHash: String(mission.approvedCandidateHash ?? ""),
          approvalId: `${mission.missionId}:X3`,
        };
      case "X5":
        // The two oracles judge different things and therefore need different
        // inputs. The live one needs the desired state it must confirm; the
        // shadow one needs the revision it must find unmoved.
        return exception.executionMode === "shadow"
          ? {
            connectorId: exception.connectorId,
            targetId: exception.targetId,
            observedRevision: String(outputOf("X1").sourceRevision ?? ""),
            observationHash: String(outputOf("X1").observationHash ?? ""),
          }
          : {
            connectorId: exception.connectorId,
            targetId: exception.targetId,
            desiredStateHash: intake.desired.desiredStateHash,
            idempotencyKey: String(outputOf("X2").idempotencyKey ?? ""),
          };
      case "X6":
        // The undo is aimed by the approval and conditioned on X5's independent
        // read. Handing it the approved candidate hash rather than a payload
        // keeps it unable to compensate anything the human did not authorize.
        return {
          actionContractHash: String(outputOf("X2").actionContractHash ?? ""),
          candidateHash: String(mission.approvedCandidateHash ?? ""),
          approvalId: `${mission.missionId}:X3`,
          verifiedRevision: String(outputOf("X5").verifiedRevision ?? ""),
        };
      case "X7":
        return {
          connectorId: exception.connectorId,
          targetId: exception.targetId,
        };
      /* c8 ignore next 2 -- unreachable: X3 is the checkpoint and runs no worker. */
      default:
        return {};
    }
  }

  /**
   * The idempotency key this mission's action was compiled under, if any.
   *
   * Read from the durable X2 output rather than recomputed, because
   * reconciliation must ask about the key the write actually used. Recomputing
   * it would produce the right answer only while nothing had changed — which is
   * precisely the assumption reconciliation exists to avoid making.
   */
  private exceptionIdempotencyKey(mission: AgenticMissionRecord): string | null {
    if (mission.intent.missionKind !== "operational_exception") return null;
    const compiled = this.journal.getNode(mission.planId, "X2");
    const output = compiled?.output;
    if (output === null || output === undefined || typeof output !== "object" || Array.isArray(output)) {
      return null;
    }
    const key = (output as Record<string, JsonValue>).idempotencyKey;
    return typeof key === "string" && key.length > 0 ? key : null;
  }

  /** Reads real durable truth for one node. Never guesses, never executes. */
  private investigate(
    mission: AgenticMissionRecord,
    node: AgenticNodeRecord,
  ): AgenticReconciliationOutcome {
    if (node.reconciliationMode === "connector_action_lookup_before_retry") {
      // Ask the system that would have performed the action.
      //
      // This is the only authority that can answer. The worker record says
      // whether *we* committed an outcome; the connector says whether the
      // action actually landed — and the whole ambiguous window is exactly the
      // gap where those two disagree. A blind retry here is how one payment
      // becomes two.
      const idempotencyKey = this.exceptionIdempotencyKey(mission);
      if (idempotencyKey === null) {
        // No action contract was ever compiled, so no write could have been
        // attempted under one. Absence here is a genuine finding.
        return this.recordStore.read(node.idempotencyKey) ? "conflict" : "no_worker_result";
      }
      const applied = this.dependencies.connector?.readAction?.(idempotencyKey) ?? null;
      if (applied) {
        // The action is on the connector's books. The node may resume from that
        // fact, and must never re-apply it.
        return "worker_result_found";
      }
      // The connector has no record of it, so nothing was applied and a retry
      // is safe — unless we durably recorded an outcome the connector cannot
      // corroborate, which is a real contradiction and escalates.
      return this.recordStore.read(node.idempotencyKey) ? "conflict" : "no_worker_result";
    }
    if (node.reconciliationMode === "artifact_lookup_before_retry") {
      const written = this.journal.getArtifactWrite(
        mission.missionId,
        requireArtifactOutputContract(mission.intent).artifactName,
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
    // A third shape, and the one that matters most for a node that can change
    // something outside itself: a *failed* side-effecting node whose outcome was
    // never established. "The worker threw" is not the same fact as "nothing
    // happened" — the throw may have come from the transport after the external
    // system already acted, which is precisely the ambiguous window. Resuming it
    // without asking the downstream system is a blind retry of a possible write.
    //
    // Pure nodes are exempt: re-running one that changes nothing outside its own
    // record cannot duplicate anything, and demanding a reconcile for them would
    // turn ordinary retry into a human interrupt.
    const hasSideEffect = node.capabilityId !== null
      && requireAgenticCapability(node.capabilityId).sideEffectClass !== "none";
    if (
      node.state === "running"
      || (node.state === "reconciliation_required" && node.reconciliationOutcome === null)
      || (hasSideEffect && node.reconciliationOutcome === null
        && (node.state === "failed_recoverable" || node.state === "failed_terminal"))
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
    // The connector branch is checked first, because for a connector node the
    // authoritative record of what happened is the connector's, not ours. Our
    // worker record may hold only the failure that interrupted it.
    if (
      node.reconciliationMode === "connector_action_lookup_before_retry"
      && node.reconciliationOutcome === "worker_result_found"
    ) {
      const idempotencyKey = this.exceptionIdempotencyKey(mission);
      const action = idempotencyKey === null
        ? null
        : this.dependencies.connector?.readAction?.(idempotencyKey) ?? null;
      if (!action) {
        throw new OperatorError(
          `Node ${nodeId} reconciled to an applied connector action that can no longer be read.`,
          409,
          "AGENTIC_NODE_RECONCILIATION_CONFLICT",
        );
      }
      const recovered: Record<string, JsonValue> = {
        idempotencyKey: action.idempotencyKey,
        postStateHash: action.postStateHash,
        // The defining fact of this recovery: the action exists, and this
        // resume did not create it.
        performedWrite: false,
        writeCount: 1,
      };
      this.journal.transitionNode(mission.planId, nodeId, "completed", {
        actor: mission.actorId,
        reason:
          "Resume committed the connector's own record of the applied action; no second write occurred.",
        timestamp,
        leaseOwner: null,
        leaseExpiresAt: null,
        output: recovered,
        outputHash: action.postStateHash,
        completedAt: timestamp,
        typedError: null,
        evidenceReferences: [`connector-action:${action.idempotencyKey}`],
      });
      this.deriveAfterRecoveredCompletion(mission, nodeId, recovered, timestamp);
    } else if (node.state === "reconciliation_required" && node.reconciliationOutcome === "worker_result_found") {
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
