/**
 * Phase 2C closed-world mission action registry.
 *
 * The Operator gateway accepts a `chanter.mission.v1` envelope only when its
 * exact (product, action) pair is registered here. Registration is a reviewed
 * code change, never data: unknown targets fail deterministically with
 * `409 OPERATOR_MISSION_TARGET_MISMATCH`.
 *
 * Lanes:
 *   autoposter_legacy — routed to the accepted Phase 2A AutoPoster mission
 *                       spine and its one-draft schedule contract.
 *   generic           — routed to the Phase 2C GenericMissionService and its
 *                       durable operator_missions spine.
 */
import {
  AUTOPOSTER_ACTIONS,
  LOOP_GOVERNOR_ACTIONS,
  validateManualLoopInput,
  type JsonValue,
  type RuntimeMissionRequest,
  type RuntimeProduct,
} from "chanter-agent-runtime";
import {
  autoPosterSchedulePayloadJson,
  validateAutoPosterScheduleInput,
} from "../runtimeMissions/autoPosterScheduleInput.js";

export type MissionActionLane = "autoposter_legacy" | "generic";

export interface MissionGraphActionValidationContext {
  requestedAt: string;
  workspaceId: string | null;
  accountId: string | null;
}

export type MissionGraphActionValidationResult =
  | { ok: true; input: Record<string, JsonValue> }
  | { ok: false; code: string; message: string; status?: number };

export interface RegisteredMissionAction {
  product: RuntimeProduct;
  action: string;
  lane: MissionActionLane;
  /** Stable downstream operation identity for the action's existing mission spine. */
  downstreamOperationType: string;
  /** Reviewed graph eligibility is explicit and closed-world per action. */
  graphEligible: boolean;
  validateGraphInput: (
    request: RuntimeMissionRequest,
    context: MissionGraphActionValidationContext,
  ) => MissionGraphActionValidationResult;
}

const REGISTERED_MISSION_ACTIONS: readonly RegisteredMissionAction[] = Object.freeze([
  Object.freeze({
    product: "auto_poster" as const,
    action: "autoposter.post.schedule",
    lane: "autoposter_legacy" as const,
    downstreamOperationType: "autoposter.queue.create_unapproved_draft",
    graphEligible: true,
    validateGraphInput(
      request: RuntimeMissionRequest,
      context: MissionGraphActionValidationContext,
    ): MissionGraphActionValidationResult {
      if (!context.workspaceId) {
        return {
          ok: false,
          code: "OPERATOR_MISSION_SCOPE_INVALID",
          message: "AutoPoster graph nodes require one exact graph tenant workspaceId.",
        };
      }
      const validated = validateAutoPosterScheduleInput(request.input, {
        mustBeAfter: context.requestedAt,
      });
      if (!validated.ok) {
        return {
          ok: false,
          code: validated.error.code,
          message: validated.error.message,
          status: validated.error.status,
        };
      }
      if (context.accountId && context.accountId !== validated.value.accountId) {
        return {
          ok: false,
          code: "OPERATOR_MISSION_SCOPE_MISMATCH",
          message: "The AutoPoster node account does not match the graph tenant account binding.",
          status: 409,
        };
      }
      if (request.tenant.accountId !== validated.value.accountId) {
        return {
          ok: false,
          code: "OPERATOR_MISSION_SCOPE_MISMATCH",
          message: "The AutoPoster node account does not match its deterministic child tenant scope.",
          status: 409,
        };
      }
      return {
        ok: true,
        input: autoPosterSchedulePayloadJson(validated.value),
      };
    },
  }),
  Object.freeze({
    product: "loop_governor" as const,
    action: LOOP_GOVERNOR_ACTIONS.manualLoopCreate,
    lane: "generic" as const,
    downstreamOperationType: "loop_governor.task.create_manual_loop",
    graphEligible: true,
    validateGraphInput(
      request: RuntimeMissionRequest,
    ): MissionGraphActionValidationResult {
      const inputErrors = validateManualLoopInput(request).errors;
      if (inputErrors.length > 0) {
        const first = inputErrors[0]!;
        return { ok: false, code: first.code, message: first.message };
      }
      return { ok: true, input: request.input };
    },
  }),
]);

export function resolveRegisteredMissionAction(
  product: unknown,
  action: unknown,
): RegisteredMissionAction | null {
  if (typeof product !== "string" || typeof action !== "string") return null;
  return (
    REGISTERED_MISSION_ACTIONS.find(
      (entry) => entry.product === product && entry.action === action,
    ) ?? null
  );
}

export function listRegisteredMissionActions(): readonly RegisteredMissionAction[] {
  return REGISTERED_MISSION_ACTIONS;
}
