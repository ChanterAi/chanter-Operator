import type { ChanterMissionEnvelopeV1 } from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import {
  autoPosterScheduleInputFromEnvelope,
} from "../runtimeMissions/autoPosterScheduleInput.js";
import type {
  AutoPosterMissionEvidenceSummary,
  AutoPosterMissionService,
  AutoPosterRuntimeMission,
} from "../runtimeMissions/autoPosterMissionService.js";
import type {
  GenericMissionService,
  GenericRuntimeMission,
} from "./genericMissionService.js";
import { resolveRegisteredMissionAction } from "./missionActionRegistry.js";

export interface MissionGraphChildReference {
  product: string;
  action: string;
  childMissionId: string;
  childTraceId: string;
  childIdempotencyKey: string;
}

export type MissionGraphChildOutcome =
  | "completed"
  | "failed_terminal"
  | "unresolved";

export interface MissionGraphChildMission {
  lane: "generic" | "autoposter_legacy";
  missionId: string;
  traceId: string;
  product: string;
  action: string;
  idempotencyKey: string;
  status: string;
  executionState: string | null;
  nextPermittedActions: string[];
  downstreamIds: unknown | null;
  retryCount: number | null;
  typedError: { code: string; message: string } | null;
  outcome: MissionGraphChildOutcome;
  resultSummary: Record<string, unknown> | null;
  evidenceReferences: string[];
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function projectGenericMission(mission: GenericRuntimeMission): MissionGraphChildMission {
  const executionState = mission.execution?.state ?? null;
  const downstreamIds = mission.execution?.downstreamIds ?? null;
  const completed = executionState === "completed"
    && (mission.status === "succeeded" || mission.status === "duplicate");
  const failedTerminal = executionState === "failed_terminal";
  return {
    lane: "generic",
    missionId: mission.missionId,
    traceId: mission.traceId,
    product: mission.product,
    action: mission.action,
    idempotencyKey: mission.idempotencyKey,
    status: mission.status,
    executionState,
    nextPermittedActions: mission.execution?.nextPermittedActions ?? [],
    downstreamIds,
    retryCount: mission.execution?.retryCount ?? null,
    typedError: mission.execution?.typedError ?? null,
    outcome: completed ? "completed" : failedTerminal ? "failed_terminal" : "unresolved",
    resultSummary: completed
      ? {
          childMissionId: mission.missionId,
          childTraceId: mission.traceId,
          childStatus: mission.status,
          executionState,
          downstreamIds,
        }
      : null,
    evidenceReferences: [
      `child-mission:${mission.missionId}`,
      ...(downstreamIds?.loopId ? [`loop-governor-loop:${downstreamIds.loopId}`] : []),
      ...(downstreamIds?.taskId ? [`loop-governor-task:${downstreamIds.taskId}`] : []),
    ],
  };
}

function autoPosterSuccessProjection(
  mission: AutoPosterRuntimeMission,
  evidence: AutoPosterMissionEvidenceSummary,
): { safe: true; downstreamIds: Record<string, unknown>; result: Record<string, unknown> }
  | { safe: false } {
  const output = jsonObject(mission.runtimeResult?.output);
  const post = jsonObject(output?.post);
  if (
    !output
    || !post
    || !hasExactKeys(output, ["duplicate", "post", "publishing"])
    || !hasExactKeys(post, ["id", "accountId", "provider", "status", "scheduledAt", "approved"])
    || typeof output.duplicate !== "boolean"
    || output.publishing !== "blocked_until_human_approval"
    || post.id !== evidence.queueDraftId
    || post.id !== evidence.authoritativeQueueId
    || post.accountId !== mission.accountId
    || post.provider !== mission.provider
    || post.status !== "scheduled"
    || post.scheduledAt !== mission.scheduledAt
    || post.approved !== false
    || evidence.persistedDraftStatus !== "scheduled"
    || evidence.releaseApprovalState !== "required"
    || evidence.publishingState !== "blocked_until_human_approval"
    || evidence.evidenceStatus !== "authoritative"
    || typeof evidence.queueDraftId !== "string"
    || !evidence.queueDraftId
    || evidence.queueDraftId !== evidence.queueDraftId.trim()
  ) {
    return { safe: false };
  }
  const downstreamIds = {
    queueDraftId: evidence.queueDraftId,
    provider: mission.provider,
    accountId: mission.accountId,
    scheduledAt: mission.scheduledAt,
    status: "scheduled",
    approved: false,
    publishing: "blocked_until_human_approval",
  };
  return {
    safe: true,
    downstreamIds,
    result: {
      childMissionId: mission.missionId,
      childTraceId: mission.traceId,
      childStatus: mission.status,
      executionState: mission.execution?.state ?? null,
      ...downstreamIds,
    },
  };
}

function projectAutoPosterMission(mission: AutoPosterRuntimeMission): MissionGraphChildMission {
  const executionState = mission.execution?.state ?? null;
  const candidateSuccess = executionState === "completed"
    && (mission.status === "succeeded" || mission.status === "duplicate");
  const projected = candidateSuccess
    ? autoPosterSuccessProjection(mission, mission.evidenceSummary)
    : { safe: false as const };
  const unsafeSuccess = candidateSuccess && !projected.safe;
  const failedTerminal = executionState === "failed_terminal" || unsafeSuccess;
  const typedError = unsafeSuccess
    ? {
        code: "GRAPH_AUTOPOSTER_RESULT_UNSAFE",
        message: "AutoPoster child success did not prove one exact unapproved scheduled queue draft.",
      }
    : mission.execution?.typedError ?? mission.evidenceSummary.typedError ?? null;
  const downstreamIds = projected.safe ? projected.downstreamIds : null;
  return {
    lane: "autoposter_legacy",
    missionId: mission.missionId,
    traceId: mission.traceId,
    product: mission.product,
    action: mission.action,
    idempotencyKey: mission.idempotencyKey,
    status: mission.status,
    executionState,
    nextPermittedActions: mission.execution?.nextPermittedActions ?? [],
    downstreamIds,
    retryCount: mission.execution?.retryCount ?? null,
    typedError,
    outcome: projected.safe
      ? "completed"
      : failedTerminal
        ? "failed_terminal"
        : "unresolved",
    resultSummary: projected.safe ? projected.result : null,
    evidenceReferences: [
      `child-mission:${mission.missionId}`,
      ...(projected.safe ? [`autoposter-queue:${projected.downstreamIds.queueDraftId}`] : []),
    ],
  };
}

export class MissionGraphChildDispatcher {
  constructor(
    private readonly genericMissions: GenericMissionService,
    private readonly autoPosterMissions?: AutoPosterMissionService,
  ) {}

  private requireAutoPosterMissions(): AutoPosterMissionService {
    if (!this.autoPosterMissions) {
      throw new OperatorError(
        "The reviewed AutoPoster graph child authority is not configured.",
        503,
        "GRAPH_CHILD_AUTHORITY_UNAVAILABLE",
      );
    }
    return this.autoPosterMissions;
  }

  private lane(product: string, action: string): "generic" | "autoposter_legacy" {
    const registered = resolveRegisteredMissionAction(product, action);
    if (!registered?.graphEligible) {
      throw new OperatorError(
        "The graph child target has no reviewed durable child authority.",
        409,
        "GRAPH_CHILD_AUTHORITY_UNREGISTERED",
      );
    }
    return registered.lane;
  }

  private assertReference(
    reference: MissionGraphChildReference,
    mission: MissionGraphChildMission,
  ): MissionGraphChildMission {
    if (
      mission.missionId !== reference.childMissionId
      || mission.traceId !== reference.childTraceId
      || mission.product !== reference.product
      || mission.action !== reference.action
      || mission.idempotencyKey !== reference.childIdempotencyKey
    ) {
      throw new OperatorError(
        "The child mission identity does not match its deterministic graph binding.",
        409,
        "GRAPH_CHILD_IDENTITY_MISMATCH",
      );
    }
    return mission;
  }

  async createMissionFromEnvelope(envelope: ChanterMissionEnvelopeV1): Promise<void> {
    const lane = this.lane(envelope.target.product, envelope.target.action);
    if (lane === "generic") {
      if (!envelope.idempotencyKey) {
        throw new OperatorError(
          "Graph children require a deterministic idempotency key.",
          409,
          "OPERATOR_IDEMPOTENCY_MISMATCH",
        );
      }
      const mission = await this.genericMissions.createMissionFromEnvelope(envelope);
      this.assertReference({
        product: envelope.target.product,
        action: envelope.target.action,
        childMissionId: envelope.missionId,
        childTraceId: envelope.traceId,
        childIdempotencyKey: envelope.idempotencyKey,
      }, projectGenericMission(mission));
      return;
    }
    const expected = autoPosterScheduleInputFromEnvelope(envelope, {
      requireWorkspace: true,
      mustBeAfter: envelope.requestedAt,
    });
    if (!expected.ok || !expected.value.idempotencyKey) {
      const error = expected.ok
        ? {
            code: "OPERATOR_IDEMPOTENCY_MISMATCH",
            message: "AutoPoster graph children require a deterministic idempotency key.",
            status: 409,
          }
        : expected.error;
      throw new OperatorError(error.message, error.status, error.code);
    }
    const mission = await this.requireAutoPosterMissions().createScheduleMissionFromEnvelope(
      envelope,
      { requireWorkspace: true, mustBeAfter: envelope.requestedAt },
    );
    if (
      mission.missionId !== expected.value.missionId
      || mission.traceId !== expected.value.traceId
      || mission.idempotencyKey !== expected.value.idempotencyKey
      || mission.workspaceId !== expected.value.workspaceId
      || mission.accountId !== expected.value.accountId
      || mission.provider !== expected.value.provider
      || mission.scheduledAt !== expected.value.scheduledAt
    ) {
      throw new OperatorError(
        "The AutoPoster child mission does not match its deterministic graph envelope.",
        409,
        "GRAPH_CHILD_IDENTITY_MISMATCH",
      );
    }
  }

  hasMission(reference: MissionGraphChildReference): boolean {
    const lane = this.lane(reference.product, reference.action);
    return lane === "generic"
      ? this.genericMissions.hasMission(reference.childMissionId)
      : this.requireAutoPosterMissions().hasMission(reference.childMissionId);
  }

  getMission(reference: MissionGraphChildReference): MissionGraphChildMission {
    const lane = this.lane(reference.product, reference.action);
    const mission = lane === "generic"
      ? projectGenericMission(this.genericMissions.getMission(reference.childMissionId))
      : projectAutoPosterMission(this.requireAutoPosterMissions().getMission(reference.childMissionId));
    return this.assertReference(reference, mission);
  }

  async approveAndExecute(
    reference: MissionGraphChildReference,
    approvedBy: string,
  ): Promise<MissionGraphChildMission> {
    const lane = this.lane(reference.product, reference.action);
    const mission = lane === "generic"
      ? projectGenericMission(
          await this.genericMissions.approveAndExecute(reference.childMissionId, approvedBy),
        )
      : projectAutoPosterMission(
          await this.requireAutoPosterMissions().approveAndExecute(reference.childMissionId, approvedBy),
        );
    return this.assertReference(reference, mission);
  }

  async reconcileMission(
    reference: MissionGraphChildReference,
  ): Promise<MissionGraphChildMission> {
    const lane = this.lane(reference.product, reference.action);
    const mission = lane === "generic"
      ? projectGenericMission(
          await this.genericMissions.reconcileMission(reference.childMissionId),
        )
      : projectAutoPosterMission(
          await this.requireAutoPosterMissions().reconcileMission(reference.childMissionId),
        );
    return this.assertReference(reference, mission);
  }

  async resumeSafely(
    reference: MissionGraphChildReference,
  ): Promise<MissionGraphChildMission> {
    const lane = this.lane(reference.product, reference.action);
    const mission = lane === "generic"
      ? projectGenericMission(
          await this.genericMissions.resumeSafely(reference.childMissionId),
        )
      : projectAutoPosterMission(
          await this.requireAutoPosterMissions().resumeSafely(reference.childMissionId),
        );
    return this.assertReference(reference, mission);
  }
}
