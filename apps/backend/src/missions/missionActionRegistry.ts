/**
 * Phase 2C closed-world mission action registry.
 *
 * The Operator gateway accepts a `chanter.mission.v1` envelope only when its
 * exact (product, action) pair is registered here. Registration is a reviewed
 * code change, never data: unknown targets fail deterministically with
 * `409 OPERATOR_MISSION_TARGET_MISMATCH`.
 *
 * Lanes:
 *   autoposter_legacy — routed to the accepted, unmodified Phase 2A
 *                       AutoPosterMissionService (byte-identical behavior).
 *   generic           — routed to the Phase 2C GenericMissionService and its
 *                       durable operator_missions spine.
 */
import type { RuntimeProduct } from "chanter-agent-runtime";
import { LOOP_GOVERNOR_ACTIONS } from "chanter-agent-runtime";

export type MissionActionLane = "autoposter_legacy" | "generic";

export interface RegisteredMissionAction {
  product: RuntimeProduct;
  action: string;
  lane: MissionActionLane;
  /** Stable downstream identity persisted with generic execution records. */
  downstreamOperationType: string;
}

const REGISTERED_MISSION_ACTIONS: readonly RegisteredMissionAction[] = Object.freeze([
  Object.freeze({
    product: "auto_poster" as const,
    action: "autoposter.post.schedule",
    lane: "autoposter_legacy" as const,
    downstreamOperationType: "autoposter.queue.create_unapproved_draft",
  }),
  Object.freeze({
    product: "loop_governor" as const,
    action: LOOP_GOVERNOR_ACTIONS.manualLoopCreate,
    lane: "generic" as const,
    downstreamOperationType: "loop_governor.task.create_manual_loop",
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
