/**
 * CHANTER OS unified mission control plane.
 *
 * One canonical surface over the two already-proven execution lanes — the
 * generic governed task (Operator -> Agent Runtime -> Loop Governor) and the
 * Platform AutoPoster command (Operator -> mission graph -> Agent Runtime ->
 * AutoPoster) — plus the direct AutoPoster mission lane, so the unified read
 * model is complete over missions that entered through legacy lane-specific
 * routes rather than through this one.
 *
 * What this service is:
 *
 *   - a **router**: intake and control actions are dispatched from the single
 *     canonical OS lane registry, so no route handler carries lane `if/else`;
 *   - a **projection**: every field it returns is derived from durable truth a
 *     reviewed lane authority already owns.
 *
 * What this service is deliberately not:
 *
 *   - a second mission database. It owns no table, writes no row, and holds no
 *     state between calls;
 *   - a second approval authority. It never records, mints, or infers an
 *     approval. Approve/reconcile/resume/stop are strict delegations to the
 *     lane authority that already owns that decision, carrying the caller's
 *     exact control body through unchanged, so every binding check — approver
 *     identity, exact graph hash, payload hash, permitted-action guard — is
 *     enforced by the same code that enforced it before this layer existed.
 *
 * Because the projection reads only committed state, a restart changes nothing
 * about what it returns, and two reads of an unchanged mission are identical.
 */
import type {
  AutoPosterMissionExecutionView,
  AutoPosterMissionService,
  AutoPosterRecoveryAction,
  AutoPosterRuntimeMission,
} from "../runtimeMissions/autoPosterMissionService.js";
import type { AutoPosterRuntimeMissionExecutor } from "../runtimeMissions/autoPosterRuntime.js";
import type {
  GenericMissionRecoveryAction,
  GenericMissionService,
  GenericRuntimeMission,
} from "../missions/genericMissionService.js";
import type { LoopGovernorMissionExecutor } from "../missions/loopGovernorRuntime.js";
import type {
  MissionGraphService,
  MissionGraphView,
} from "../missions/missionGraphService.js";
import type {
  PlatformAutoPosterCommandService,
  PlatformAutoPosterCommandView,
} from "../platform/platformAutoPosterCommandService.js";
import type { OperatorApprovalAuthorityProjection } from "../runtimeMissions/persistedApprovalAuthority.js";
import { OperatorError } from "../services/operatorService.js";
import {
  OS_MISSION_LANE_SPECS,
  OS_MISSION_STATES,
  OS_MISSION_VIEW_SCHEMA_VERSION,
  osLaneForIntakeSchema,
  osMissionIdFor,
  osMissionLaneSpec,
  osReplayOutcome,
  osStateFromExecutionState,
  osStateFromGraphState,
  parseOsMissionId,
  registeredActionForLane,
  type OsApprovalStateFilter,
  type OsDownstreamIdentity,
  type OsEvidenceStatus,
  type OsLaneExecutionState,
  type OsMissionAction,
  type OsMissionAuthority,
  type OsMissionLane,
  type OsMissionLaneSpec,
  type OsMissionListQuery,
  type OsMissionState,
  type OsMissionTypedError,
  type OsMissionView,
} from "./osMissionContract.js";

/**
 * Per-lane read cap before merging. Matches the bound every existing
 * lane-specific list route already enforces, so the unified list can never
 * read more of a lane than that lane's own canonical route would.
 */
const MAX_LANE_READ = 100;

/**
 * States that outrank a command's own recorded `failed_recoverable`. Anything
 * outside this set describes progress, not outcome, and must not overwrite a
 * durably recorded recoverable failure. See `platformStatus`.
 */
const MORE_SEVERE_THAN_RECOVERABLE: ReadonlySet<OsMissionState> = new Set<OsMissionState>([
  "reconciliation_required",
  "failed_terminal",
  "stopped",
]);

const LANE_ACTION_TO_OS_ACTION: Readonly<
  Record<GenericMissionRecoveryAction & AutoPosterRecoveryAction, OsMissionAction>
> = Object.freeze({
  "Reconcile": "reconcile",
  "Resume safely": "resume",
  "Stop / escalate": "stop",
});

interface OsMissionControlServiceDependencies {
  readonly genericMissions: GenericMissionService;
  readonly autoPosterMissions: AutoPosterMissionService;
  readonly platformCommands: PlatformAutoPosterCommandService;
  readonly missionGraphs: MissionGraphService;
  readonly loopGovernorExecutor: LoopGovernorMissionExecutor;
  readonly autoPosterExecutor: AutoPosterRuntimeMissionExecutor;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The most recent durable evidence reference this mission's journal recorded.
 * Read from the journal rather than reconstructed, so an absent reference means
 * the journal genuinely carries none.
 */
function latestEvidenceReference(
  journal: readonly { readonly evidenceReferences: string[] }[],
): string | null {
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const reference = journal[index]?.evidenceReferences[0];
    if (reference) return reference;
  }
  return null;
}

function osActionsFrom(
  laneActions: readonly (GenericMissionRecoveryAction | AutoPosterRecoveryAction)[],
): OsMissionAction[] {
  return laneActions.map((action) => LANE_ACTION_TO_OS_ACTION[action]);
}

function typedErrorOf(value: { code: string; message: string } | null): OsMissionTypedError | null {
  return value ? { code: value.code, message: value.message } : null;
}

/**
 * True while the child mission spine still owns this execution — that is, until
 * it reaches one of its own terminal states. Past that point the child is
 * finished and only the command and its graph have anything left to advance.
 */
function childOwnsExecution(execution: AutoPosterMissionExecutionView | null): boolean {
  return execution !== null
    && execution.state !== "completed"
    && execution.state !== "failed_terminal";
}

/**
 * True when the owning child authority will not let execution advance until an
 * authoritative downstream lookup has established truth: it offers Reconcile
 * and withholds Resume safely.
 *
 * This reads the authority's own decision rather than making one here. It is
 * how "the request left, no response came back, and nobody knows whether the
 * side effect happened" is told apart from an ordinary recoverable failure — a
 * distinction the operator must see, because in the first case the only safe
 * next act is to investigate.
 */
function childRequiresReconciliation(execution: AutoPosterMissionExecutionView | null): boolean {
  if (!childOwnsExecution(execution) || execution === null) return false;
  return execution.nextPermittedActions.includes("Reconcile")
    && !execution.nextPermittedActions.includes("Resume safely");
}

export class OsMissionControlService {
  constructor(private readonly dependencies: OsMissionControlServiceDependencies) {}

  /** The canonical lane/capability registry, for operator-facing discovery. */
  describeLanes(): ReadonlyArray<Record<string, unknown>> {
    return OS_MISSION_LANE_SPECS.map((spec) => ({
      lane: spec.lane,
      intakeSchemaVersion: spec.intakeSchemaVersion,
      submittable: spec.intakeSchemaVersion !== null,
      product: spec.product,
      action: spec.action,
      approvalRequirement: spec.approvalRequirement,
      executionScope: spec.executionScope,
      downstreamOperationType: registeredActionForLane(spec).downstreamOperationType,
      realExternalExecutionAllowed: spec.realExternalExecutionAllowed,
      reconciliationMode: spec.reconciliationMode,
      sourceOfTruth: spec.sourceOfTruth,
    }));
  }

  // -------------------------------------------------------------------------
  // Intake
  // -------------------------------------------------------------------------

  /**
   * Routes one canonical submission to the lane that owns its intake schema.
   *
   * The body is forwarded byte for byte to the existing canonical service, so
   * every validation, identity binding, payload-hash check, and typed conflict
   * stays exactly where it already lived. This method adds routing and
   * projection — never a second validation path, and never a relaxed one.
   */
  async submit(rawBody: unknown): Promise<OsMissionView> {
    const body = jsonObject(rawBody);
    if (!body) {
      throw new OperatorError("Request body must be an object.", 400, "OS_MISSION_BODY_INVALID");
    }
    const spec = osLaneForIntakeSchema(body.schemaVersion);
    if (!spec) {
      throw new OperatorError(
        "schemaVersion does not name a registered CHANTER OS mission intake.",
        400,
        "OS_MISSION_INTAKE_UNREGISTERED",
      );
    }

    if (spec.lane === "generic_governed_task") {
      // A `chanter.mission.v1` envelope reaches the generic lane only when its
      // exact (product, action) pair belongs to it. An AutoPoster envelope is
      // refused here rather than forwarded, because AutoPoster work has a
      // different canonical intake and silently accepting it would create a
      // third way to reach the same downstream authority.
      const target = jsonObject(body.target);
      if (
        target?.product !== spec.product
        || target?.action !== spec.action
      ) {
        throw new OperatorError(
          "This mission target is not served by the CHANTER OS generic mission intake.",
          409,
          "OS_MISSION_LANE_INTAKE_MISMATCH",
        );
      }
      const mission = await this.dependencies.genericMissions.createMissionFromEnvelope(
        body as never,
      );
      return this.projectGenericMission(mission, mission.replayed);
    }

    const command = await this.dependencies.platformCommands.submit(body);
    return this.projectPlatformCommand(command, command.replayed);
  }

  // -------------------------------------------------------------------------
  // Read model
  // -------------------------------------------------------------------------

  get(osMissionIdValue: unknown): OsMissionView {
    const parsed = this.requireParsedId(osMissionIdValue);
    switch (parsed.lane) {
      case "generic_governed_task":
        return this.projectGenericMission(
          this.dependencies.genericMissions.getMission(parsed.laneNativeId),
        );
      case "platform_autoposter_command":
        return this.projectPlatformCommand(
          this.dependencies.platformCommands.get(parsed.laneNativeId),
        );
      case "autoposter_direct_mission":
        return this.projectDirectAutoPosterMission(
          this.requireDirectAutoPosterMission(parsed.laneNativeId),
        );
    }
  }

  /**
   * One deterministic list across every lane.
   *
   * Ordering is total — newest first, then by OS identity — so two calls
   * against unchanged state return the same sequence, and a restart does not
   * reshuffle it.
   */
  list(query: OsMissionListQuery = {}): OsMissionView[] {
    const laneFilter = this.parseLaneFilter(query.lane);
    const statusFilter = this.parseStatusFilter(query.status);
    const approvalFilter = this.parseApprovalStateFilter(query.approvalState);
    const product = this.optionalString(query.product, "product");
    const action = this.optionalString(query.action, "action");
    const workspaceId = this.optionalString(query.workspaceId, "workspaceId");
    const from = this.optionalInstant(query.from, "from");
    const to = this.optionalInstant(query.to, "to");
    const limit = this.parseLimit(query.limit);

    const views: OsMissionView[] = [];
    if (!laneFilter || laneFilter === "generic_governed_task") {
      for (const mission of this.dependencies.genericMissions.listMissions(MAX_LANE_READ)) {
        views.push(this.projectGenericMission(mission));
      }
    }
    if (!laneFilter || laneFilter === "platform_autoposter_command") {
      for (const command of this.dependencies.platformCommands.list(MAX_LANE_READ)) {
        views.push(this.projectPlatformCommand(command));
      }
    }
    if (!laneFilter || laneFilter === "autoposter_direct_mission") {
      const owned = this.dependencies.platformCommands.ownedChildMissionIds();
      for (const mission of this.dependencies.autoPosterMissions.listMissions(MAX_LANE_READ)) {
        if (owned.has(mission.missionId)) continue;
        views.push(this.projectDirectAutoPosterMission(mission));
      }
    }

    return views
      .filter((view) => (
        (!statusFilter || view.status === statusFilter)
        && (!product || view.identity.product === product)
        && (!action || view.identity.action === action)
        && (!workspaceId || view.identity.workspaceId === workspaceId)
        && (!approvalFilter || this.approvalStateOf(view) === approvalFilter)
        && (!from || view.createdAt >= from)
        && (!to || view.createdAt <= to)
      ))
      .sort((left, right) => (
        right.createdAt.localeCompare(left.createdAt)
        || right.identity.osMissionId.localeCompare(left.identity.osMissionId)
      ))
      .slice(0, limit);
  }

  // -------------------------------------------------------------------------
  // Control actions
  // -------------------------------------------------------------------------

  /**
   * Authorizes one bounded execution through the lane's own approval authority.
   *
   * The control body is passed through unchanged — `approvedBy` for a mission
   * spine, the exact `graphHash` for a Platform command — so the binding each
   * lane already enforces is enforced here identically.
   */
  async approve(osMissionIdValue: unknown, rawBody: unknown): Promise<OsMissionView> {
    const parsed = this.requireParsedId(osMissionIdValue);
    const body = jsonObject(rawBody) ?? {};
    switch (parsed.lane) {
      case "generic_governed_task":
        return this.projectGenericMission(
          await this.dependencies.genericMissions.approveAndExecute(
            parsed.laneNativeId,
            body.approvedBy,
          ),
        );
      case "platform_autoposter_command": {
        const command = await this.dependencies.platformCommands.execute(
          parsed.laneNativeId,
          body,
        );
        return this.projectPlatformCommand(command, command.replayed);
      }
      case "autoposter_direct_mission":
        return this.projectDirectAutoPosterMission(
          await this.dependencies.autoPosterMissions.approveAndExecute(
            parsed.laneNativeId,
            body.approvedBy,
          ),
        );
    }
  }

  /** Reads exact downstream truth before any retry is permitted. */
  async reconcile(osMissionIdValue: unknown): Promise<OsMissionView> {
    const parsed = this.requireParsedId(osMissionIdValue);
    switch (parsed.lane) {
      case "generic_governed_task":
        return this.projectGenericMission(
          await this.dependencies.genericMissions.reconcileMission(parsed.laneNativeId),
        );
      case "platform_autoposter_command": {
        // Reconciliation is a child-mission decision, so it is delegated to the
        // AutoPoster mission authority that owns the downstream binding. The
        // graph is not advanced here: a reconciled child is resumed through the
        // Platform command's own execute path.
        const command = this.dependencies.platformCommands.get(parsed.laneNativeId);
        await this.dependencies.autoPosterMissions.reconcileMission(
          this.requireChildMissionId(command),
        );
        return this.projectPlatformCommand(
          this.dependencies.platformCommands.get(parsed.laneNativeId),
        );
      }
      case "autoposter_direct_mission":
        return this.projectDirectAutoPosterMission(
          await this.dependencies.autoPosterMissions.reconcileMission(parsed.laneNativeId),
        );
    }
  }

  /** Continues an interrupted execution without any speculative duplicate. */
  async resume(osMissionIdValue: unknown, rawBody: unknown): Promise<OsMissionView> {
    const parsed = this.requireParsedId(osMissionIdValue);
    switch (parsed.lane) {
      case "generic_governed_task":
        return this.projectGenericMission(
          await this.dependencies.genericMissions.resumeSafely(parsed.laneNativeId),
        );
      case "platform_autoposter_command": {
        // The Platform command's execute path *is* its canonical resume: it
        // re-binds the exact graph hash, resumes the graph when it is already
        // approved, and returns the same durable linkage on replay.
        const command = await this.dependencies.platformCommands.execute(
          parsed.laneNativeId,
          jsonObject(rawBody) ?? {},
        );
        return this.projectPlatformCommand(command, command.replayed);
      }
      case "autoposter_direct_mission":
        return this.projectDirectAutoPosterMission(
          await this.dependencies.autoPosterMissions.resumeSafely(parsed.laneNativeId),
        );
    }
  }

  /** Stops automatic recovery and escalates to a human. */
  stop(osMissionIdValue: unknown, rawBody: unknown): OsMissionView {
    const parsed = this.requireParsedId(osMissionIdValue);
    const body = jsonObject(rawBody) ?? {};
    switch (parsed.lane) {
      case "generic_governed_task":
        return this.projectGenericMission(
          this.dependencies.genericMissions.stopAndEscalate(parsed.laneNativeId),
        );
      case "platform_autoposter_command": {
        const command = this.dependencies.platformCommands.get(parsed.laneNativeId);
        if (!command.graphId) {
          throw new OperatorError(
            "The canonical command has no durable graph binding to stop.",
            409,
            "PLATFORM_COMMAND_GRAPH_NOT_READY",
          );
        }
        this.dependencies.missionGraphs.cancelGraph(command.graphId, body);
        return this.projectPlatformCommand(
          this.dependencies.platformCommands.get(parsed.laneNativeId),
        );
      }
      case "autoposter_direct_mission":
        return this.projectDirectAutoPosterMission(
          this.dependencies.autoPosterMissions.stopAndEscalate(parsed.laneNativeId),
        );
    }
  }

  // -------------------------------------------------------------------------
  // Projection: generic governed task
  // -------------------------------------------------------------------------

  private projectGenericMission(
    mission: GenericRuntimeMission,
    replayed = false,
  ): OsMissionView {
    const spec = osMissionLaneSpec("generic_governed_task");
    const execution = mission.execution;
    const authority = this.dependencies.loopGovernorExecutor.describeApprovalAuthority(
      mission.missionId,
    );
    const status: OsMissionState = execution
      ? osStateFromExecutionState(
        execution.state as OsLaneExecutionState,
        execution.recoveryClassification,
      )
      : "submitted";
    const downstream: OsDownstreamIdentity | null = execution?.downstreamIds
      ? {
        kind: "loop_governor_manual_loop",
        taskId: execution.downstreamIds.taskId,
        loopId: execution.downstreamIds.loopId,
        created: execution.downstreamIds.created,
      }
      : null;

    return this.assemble({
      spec,
      replayed,
      laneNativeId: mission.missionId,
      missionRevision: mission.executionJournal.length,
      payloadHash: execution?.missionPayloadHash ?? null,
      traceId: mission.traceId,
      product: mission.product,
      action: mission.action,
      workspaceId: mission.workspaceId,
      actorId: mission.actorId,
      runtimeExecutionId: execution?.executionAttemptId ?? null,
      downstream,
      status,
      laneState: execution?.state ?? mission.status,
      authorityProjection: authority,
      approvedBy: mission.approvedBy,
      evidenceStatus: execution?.evidenceStatus ?? "pending",
      evidenceReference: latestEvidenceReference(mission.executionJournal),
      valueObservation: mission.runtimeResult?.valueObservation ?? null,
      replayOutcome: osReplayOutcome(mission.runtimeResult?.idempotency?.outcome),
      recoveryClassification: execution?.recoveryClassification ?? null,
      lastConfirmedBoundary: execution
        ? osStateFromExecutionState(
          execution.lastConfirmedBoundary as OsLaneExecutionState,
          execution.recoveryClassification,
        )
        : null,
      nextPermittedActions: this.missionSpineActions(status, execution?.nextPermittedActions ?? []),
      typedError: typedErrorOf(execution?.typedError ?? null),
      laneReference: {
        laneNativeId: mission.missionId,
        missionId: mission.missionId,
        commandId: null,
        graphId: null,
        graphHash: null,
      },
      requestedAt: mission.requestedAt,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });
  }

  // -------------------------------------------------------------------------
  // Projection: Platform AutoPoster command
  // -------------------------------------------------------------------------

  private projectPlatformCommand(
    command: PlatformAutoPosterCommandView,
    replayed = false,
  ): OsMissionView {
    const spec = osMissionLaneSpec("platform_autoposter_command");
    const graph = command.graphId ? this.readGraph(command.graphId) : null;
    const child = command.missionId
      && this.dependencies.autoPosterMissions.hasMission(command.missionId)
      ? this.dependencies.autoPosterMissions.getMission(command.missionId)
      : null;
    const childExecution = child?.execution ?? null;
    const authority = command.missionId
      ? this.dependencies.autoPosterExecutor.describeApprovalAuthority(command.missionId)
      : this.dependencies.autoPosterExecutor.describeApprovalAuthority("");

    const status = this.platformStatus(command, graph, childExecution);
    const downstream: OsDownstreamIdentity | null = command.jobIds.length > 0
      ? {
        kind: "autoposter_unapproved_draft",
        jobIds: command.jobIds,
        campaignId: command.campaignId,
        approvalId: command.approvalId,
        evidenceBundleId: command.evidenceBundleId,
        publicationApprovalState: command.publicationApprovalState,
      }
      : null;

    // A Platform command's evidence is authoritative only once the retained
    // manifest exists: a completed draft whose evidence bundle could not be
    // refreshed is reported as pending, never as authoritative.
    const evidenceStatus: OsEvidenceStatus = status === "completed"
      ? (command.evidenceAvailable ? "authoritative" : "pending")
      : status === "failed_terminal" || status === "stopped"
        ? "failed"
        : status === "failed_recoverable" || status === "reconciliation_required"
          ? "reconciliation_required"
          : "pending";

    return this.assemble({
      spec,
      replayed,
      laneNativeId: command.commandId,
      missionRevision: (graph?.events.length ?? 0) + (child?.executionJournal.length ?? 0),
      payloadHash: command.commandHash,
      traceId: command.traceId,
      product: graph?.nodes[0]?.product ?? spec.product,
      action: graph?.nodes[0]?.action ?? spec.action,
      workspaceId: command.tenantId,
      actorId: command.actorId,
      runtimeExecutionId: command.runtimeExecutionId,
      downstream,
      status,
      laneState: command.lifecycleState,
      authorityProjection: authority,
      approvedBy: command.draftExecutionApprovalState === "approved" ? command.actorId : null,
      evidenceStatus,
      evidenceReference: command.evidenceReference,
      valueObservation: child?.runtimeResult?.valueObservation ?? null,
      replayOutcome: osReplayOutcome(child?.runtimeResult?.idempotency?.outcome),
      recoveryClassification: childExecution?.recoveryClassification ?? null,
      lastConfirmedBoundary: childExecution
        ? osStateFromExecutionState(
          childExecution.lastConfirmedBoundary as OsLaneExecutionState,
          childExecution.recoveryClassification,
        )
        : null,
      nextPermittedActions: this.platformActions(status, childExecution),
      typedError: typedErrorOf(command.error ?? childExecution?.typedError ?? null),
      laneReference: {
        laneNativeId: command.commandId,
        missionId: command.missionId,
        commandId: command.commandId,
        graphId: command.graphId,
        graphHash: command.graphHash,
      },
      requestedAt: command.requestedAt,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
    });
  }

  /**
   * Derives the OS state of a Platform command from the deepest authoritative
   * evidence that exists, in the order the truth actually accumulates.
   *
   * A cancelled graph is checked first because it is terminal orchestration
   * truth regardless of what the command row still says about its own
   * lifecycle; every other case falls through to the child mission's durable
   * execution journal, then to the graph, then to the command lifecycle alone.
   *
   * One asymmetry has to be handled explicitly. A Platform command spans three
   * durable authorities, and an interrupted execution can leave the command
   * recording `failed_recoverable` while the graph or child still reports how
   * far execution *got* — `approved` when no node ever started, or even
   * `completed` when the child finished but the command's own linkage and
   * evidence never did. Reporting those directly would answer "how far did
   * execution reach" when the operator asked "what state is this mission in",
   * and would silently drop the durably recorded fact that an attempt failed
   * and recovery is required. So deeper evidence may only ever *deepen* the
   * answer: it can report something more severe than the recorded failure, but
   * never something that reads as unattempted or finished.
   */
  private platformStatus(
    command: PlatformAutoPosterCommandView,
    graph: MissionGraphView | null,
    childExecution: AutoPosterMissionExecutionView | null,
  ): OsMissionState {
    if (graph?.status === "cancelled") return "stopped";
    switch (command.lifecycleState) {
      case "accepted":
        return "submitted";
      case "approval_required":
        return "approval_required";
      case "completed":
        return "completed";
      case "failed":
        return "failed_terminal";
      case "executing":
      case "failed_recoverable": {
        const derived = childExecution
          ? osStateFromExecutionState(
            childExecution.state as OsLaneExecutionState,
            childExecution.recoveryClassification,
          )
          : graph
            ? osStateFromGraphState(graph.status)
            : "approved";
        const resolved = command.lifecycleState === "failed_recoverable"
          && !MORE_SEVERE_THAN_RECOVERABLE.has(derived)
          ? "failed_recoverable"
          : derived;
        // An attempt whose downstream outcome was never observed is not an
        // ordinary recoverable failure, and reporting it as one invites exactly
        // the speculative retry that duplicates real-world work. The owning
        // child authority already withholds every execution-advancing action
        // here; the OS names that condition rather than flattening it.
        return resolved === "failed_recoverable" && childRequiresReconciliation(childExecution)
          ? "reconciliation_required"
          : resolved;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Projection: direct AutoPoster mission
  // -------------------------------------------------------------------------

  private projectDirectAutoPosterMission(
    mission: AutoPosterRuntimeMission,
    replayed = false,
  ): OsMissionView {
    const spec = osMissionLaneSpec("autoposter_direct_mission");
    const execution = mission.execution;
    const authority = this.dependencies.autoPosterExecutor.describeApprovalAuthority(
      mission.missionId,
    );
    const status: OsMissionState = execution
      ? osStateFromExecutionState(
        execution.state as OsLaneExecutionState,
        execution.recoveryClassification,
      )
      : "submitted";
    const queueId = execution?.authoritativeQueueId ?? null;

    return this.assemble({
      spec,
      replayed,
      laneNativeId: mission.missionId,
      missionRevision: mission.executionJournal.length,
      payloadHash: execution?.missionPayloadHash ?? null,
      traceId: mission.traceId,
      product: mission.product,
      action: mission.action,
      workspaceId: mission.workspaceId,
      actorId: mission.actorId,
      runtimeExecutionId: execution?.executionAttemptId ?? null,
      downstream: queueId
        ? {
          kind: "autoposter_unapproved_draft",
          jobIds: [queueId],
          campaignId: null,
          approvalId: null,
          evidenceBundleId: null,
          publicationApprovalState: "human_required",
        }
        : null,
      status,
      laneState: execution?.state ?? mission.status,
      authorityProjection: authority,
      approvedBy: mission.approvedBy,
      evidenceStatus: execution?.evidenceStatus ?? "pending",
      evidenceReference: latestEvidenceReference(mission.executionJournal),
      valueObservation: mission.runtimeResult?.valueObservation ?? null,
      replayOutcome: osReplayOutcome(mission.runtimeResult?.idempotency?.outcome),
      recoveryClassification: execution?.recoveryClassification ?? null,
      lastConfirmedBoundary: execution
        ? osStateFromExecutionState(
          execution.lastConfirmedBoundary as OsLaneExecutionState,
          execution.recoveryClassification,
        )
        : null,
      nextPermittedActions: this.missionSpineActions(status, execution?.nextPermittedActions ?? []),
      typedError: typedErrorOf(execution?.typedError ?? null),
      laneReference: {
        laneNativeId: mission.missionId,
        missionId: mission.missionId,
        commandId: null,
        graphId: mission.graphId,
        graphHash: null,
      },
      requestedAt: mission.createdAt,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
    });
  }

  // -------------------------------------------------------------------------
  // Shared assembly
  // -------------------------------------------------------------------------

  private assemble(input: {
    spec: OsMissionLaneSpec;
    replayed: boolean;
    laneNativeId: string;
    missionRevision: number;
    payloadHash: string | null;
    traceId: string | null;
    product: string;
    action: string;
    workspaceId: string | null;
    actorId: string;
    runtimeExecutionId: string | null;
    downstream: OsDownstreamIdentity | null;
    status: OsMissionState;
    laneState: string;
    authorityProjection: OperatorApprovalAuthorityProjection;
    approvedBy: string | null;
    evidenceStatus: OsEvidenceStatus;
    evidenceReference: string | null;
    valueObservation: unknown | null;
    replayOutcome: ReturnType<typeof osReplayOutcome>;
    recoveryClassification: string | null;
    lastConfirmedBoundary: OsMissionState | null;
    nextPermittedActions: readonly OsMissionAction[];
    typedError: OsMissionTypedError | null;
    laneReference: OsMissionView["laneReference"];
    requestedAt: string;
    createdAt: string;
    updatedAt: string;
  }): OsMissionView {
    const authority = this.projectAuthority(input.authorityProjection, input.approvedBy);
    return {
      schemaVersion: OS_MISSION_VIEW_SCHEMA_VERSION,
      replayed: input.replayed,
      identity: {
        osMissionId: osMissionIdFor(input.spec.lane, input.laneNativeId),
        missionRevision: input.missionRevision,
        payloadHash: input.payloadHash,
        traceId: input.traceId,
        product: input.product,
        action: input.action,
        lane: input.spec.lane,
        workspaceId: input.workspaceId,
        actorId: input.actorId,
        authorityRevision: authority.authorityRevision,
        runtimeExecutionId: input.runtimeExecutionId,
        downstreamIdentity: input.downstream,
      },
      lane: input.spec.lane,
      laneCapability: {
        approvalRequirement: input.spec.approvalRequirement,
        executionScope: input.spec.executionScope,
        downstreamOperationType: registeredActionForLane(input.spec).downstreamOperationType,
        realExternalExecutionAllowed: input.spec.realExternalExecutionAllowed,
        reconciliationMode: input.spec.reconciliationMode,
        sourceOfTruth: input.spec.sourceOfTruth,
      },
      status: input.status,
      laneState: input.laneState,
      authority,
      outcome: {
        status: input.status,
        evidenceStatus: input.evidenceStatus,
        evidenceReference: input.evidenceReference,
        valueObservation: input.valueObservation,
        downstreamIdentity: input.downstream,
        replayOutcome: input.replayOutcome,
        recoveryClassification: input.recoveryClassification,
        lastConfirmedBoundary: input.lastConfirmedBoundary,
        nextPermittedActions: input.nextPermittedActions,
        typedError: input.typedError,
      },
      laneReference: input.laneReference,
      requestedAt: input.requestedAt,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    };
  }

  /**
   * The unified authority view.
   *
   * `approved` is asserted only when a persisted, non-rejected approval
   * observation actually exists — never from a status string or a boolean flag,
   * because those can be true while the durable authority behind them is not.
   */
  private projectAuthority(
    projection: OperatorApprovalAuthorityProjection,
    approvedBy: string | null,
  ): OsMissionAuthority {
    const observation = projection.observation;
    return {
      required: true,
      configured: projection.configured,
      trusted: projection.issuerConfigured && projection.trustStoreConfigured,
      approved: observation?.status === "approved",
      approvedBy: observation?.approverId ?? approvedBy,
      approvalId: projection.checkpoint?.approvalRequestId ?? null,
      authorityRevision: projection.checkpoint?.expectedHead ?? null,
      repositoryBinding: projection.checkpoint?.repositoryId ?? null,
      expiresAt: observation?.approvalExpiresAt ?? null,
      refusalCode: projection.refusalCode,
    };
  }

  // -------------------------------------------------------------------------
  // Permitted actions
  //
  // Advisory only. These name the actions that can still *advance* a mission,
  // so an operator knows what to do next. They are deliberately not enforced
  // here: whether an action is accepted is a decision each lane authority
  // already owns and already refuses with a typed 409, and re-deciding it at
  // this layer would be a second authority that can only diverge from the
  // first. A terminal mission therefore lists no advancing action while an
  // idempotent replay of its final action still returns durable truth
  // unchanged.
  // -------------------------------------------------------------------------

  private missionSpineActions(
    status: OsMissionState,
    laneActions: readonly (GenericMissionRecoveryAction | AutoPosterRecoveryAction)[],
  ): OsMissionAction[] {
    return status === "approval_required"
      ? ["approve"]
      : osActionsFrom(laneActions);
  }

  private platformActions(
    status: OsMissionState,
    childExecution: AutoPosterMissionExecutionView | null,
  ): OsMissionAction[] {
    if (status === "approval_required") return ["approve"];
    if (status === "completed" || status === "failed_terminal" || status === "stopped") return [];
    if (status === "submitted") return [];
    // While the child mission spine owns the execution, its permitted actions
    // are the answer and are projected as-is. Advertising `resume` on top of
    // them would announce an execution-advancing action the owning authority
    // withholds — and it withholds it precisely when downstream truth is still
    // unknown. Stop stays available throughout: escalating to a human is never
    // gated on knowing what happened downstream.
    if (childOwnsExecution(childExecution) && childExecution !== null) {
      return [...new Set<OsMissionAction>([
        ...osActionsFrom(childExecution.nextPermittedActions),
        "stop",
      ])];
    }
    // No child holds the execution: either none was dispatched yet or it has
    // already finished, and only the command and its graph remain to advance.
    return ["resume", "stop"];
  }

  // -------------------------------------------------------------------------
  // Input parsing
  // -------------------------------------------------------------------------

  /**
   * Resolves an OS identity to exactly one lane, or refuses.
   *
   * An unparseable or unregistered identity is refused outright rather than
   * probed lane by lane — that probing is precisely how an unknown id silently
   * falls through into another lane's store.
   */
  private requireParsedId(value: unknown) {
    const parsed = parseOsMissionId(value);
    if (!parsed) {
      throw new OperatorError(
        "osMissionId must be a canonical CHANTER OS mission identity.",
        400,
        "OS_MISSION_IDENTITY_INVALID",
      );
    }
    return parsed;
  }

  private readGraph(graphId: string): MissionGraphView | null {
    return this.dependencies.missionGraphs.hasGraph(graphId)
      ? this.dependencies.missionGraphs.getGraph(graphId)
      : null;
  }

  private requireChildMissionId(command: PlatformAutoPosterCommandView): string {
    if (!command.missionId) {
      throw new OperatorError(
        "The canonical command has no durable child mission to reconcile.",
        409,
        "PLATFORM_COMMAND_GRAPH_NOT_READY",
      );
    }
    return command.missionId;
  }

  /**
   * An AutoPoster mission owned by a Platform command is addressable only
   * through that command's OS identity, so the direct lane refuses it rather
   * than exposing one downstream draft under two OS identities.
   */
  private requireDirectAutoPosterMission(missionId: string): AutoPosterRuntimeMission {
    if (this.dependencies.platformCommands.ownedChildMissionIds().has(missionId)) {
      throw new OperatorError(
        "This AutoPoster mission is owned by a canonical Platform command and is addressed through it.",
        409,
        "OS_MISSION_LANE_OWNERSHIP_MISMATCH",
      );
    }
    return this.dependencies.autoPosterMissions.getMission(missionId);
  }

  private approvalStateOf(view: OsMissionView): OsApprovalStateFilter {
    return view.authority.approved ? "approved" : "required";
  }

  private parseLaneFilter(value: unknown): OsMissionLane | null {
    if (value === undefined || value === null || value === "") return null;
    const lane = OS_MISSION_LANE_SPECS.find((spec) => spec.lane === value)?.lane;
    if (!lane) {
      throw new OperatorError("lane is not a registered CHANTER OS lane.", 400, "OS_MISSION_FILTER_INVALID");
    }
    return lane;
  }

  private parseStatusFilter(value: unknown): OsMissionState | null {
    if (value === undefined || value === null || value === "") return null;
    if (!OS_MISSION_STATES.includes(value as OsMissionState)) {
      throw new OperatorError("status is not a canonical CHANTER OS state.", 400, "OS_MISSION_FILTER_INVALID");
    }
    return value as OsMissionState;
  }

  private parseApprovalStateFilter(value: unknown): OsApprovalStateFilter | null {
    if (value === undefined || value === null || value === "") return null;
    if (value !== "required" && value !== "approved") {
      throw new OperatorError(
        "approvalState must be required or approved.",
        400,
        "OS_MISSION_FILTER_INVALID",
      );
    }
    return value;
  }

  private optionalString(value: unknown, field: string): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value !== "string" || value !== value.trim() || value.length > 256) {
      throw new OperatorError(`${field} must be an exact bounded string.`, 400, "OS_MISSION_FILTER_INVALID");
    }
    return value;
  }

  private optionalInstant(value: unknown, field: string): string | null {
    const parsed = this.optionalString(value, field);
    if (parsed === null) return null;
    if (Number.isNaN(Date.parse(parsed))) {
      throw new OperatorError(`${field} must be a valid ISO-8601 instant.`, 400, "OS_MISSION_FILTER_INVALID");
    }
    return parsed;
  }

  private parseLimit(value: unknown): number {
    if (value === undefined || value === null || value === "") return 50;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
      throw new OperatorError("limit must be a number.", 400, "OS_MISSION_FILTER_INVALID");
    }
    return Math.max(1, Math.min(Math.trunc(parsed), MAX_LANE_READ));
  }
}
