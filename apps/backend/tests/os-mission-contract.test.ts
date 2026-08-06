/**
 * CHANTER OS unified mission control plane — canonical contract tests.
 *
 * These cover the pure contract only: identity derivation, the state mapping,
 * and the lane registry's consistency with the reviewed action registry. The
 * live cross-lane behaviour (real Operator process, real Loop Governor child
 * process, real AutoPoster boundary, restart, replay, typed conflict) is
 * proven end to end by `npm run os:unified`, so nothing here re-simulates it.
 *
 * The value of this file is drift detection: it fails the moment a lane state
 * stops mapping, an identity stops round-tripping, or the OS lane registry
 * names an action the reviewed registry does not execute.
 */
import { describe, expect, it } from "vitest";

import {
  listRegisteredMissionActions,
  resolveRegisteredMissionAction,
} from "../src/missions/missionActionRegistry.js";
import {
  OS_MISSION_LANES,
  OS_MISSION_LANE_SPECS,
  OS_MISSION_STATES,
  isTerminalOsMissionState,
  osDownstreamOperationType,
  osLaneForIntakeSchema,
  osMissionIdFor,
  osMissionLaneSpec,
  osReplayOutcome,
  osStateFromExecutionState,
  osStateFromGraphState,
  parseOsMissionId,
  registeredActionForLane,
  type OsLaneExecutionState,
  type OsMissionState,
} from "../src/os/osMissionContract.js";

/** Every durable execution state both mission spines can hold. */
const EXECUTION_STATES: readonly OsLaneExecutionState[] = [
  "approval_required",
  "approved",
  "execution_started",
  "downstream_request_prepared",
  "downstream_result_observed",
  "result_persisted",
  "completed",
  "failed_recoverable",
  "failed_terminal",
  "reconciliation_required",
  "recovery_in_progress",
];

describe("CHANTER OS canonical identity", () => {
  it("derives a deterministic, lane-qualified identity", () => {
    const first = osMissionIdFor("generic_governed_task", "mission-a");
    const second = osMissionIdFor("generic_governed_task", "mission-a");

    expect(first).toBe(second);
    expect(first).toBe("os:generic_governed_task:mission-a");
  });

  it("round-trips every registered lane", () => {
    for (const lane of OS_MISSION_LANES) {
      expect(parseOsMissionId(osMissionIdFor(lane, "native-id"))).toEqual({
        lane,
        laneNativeId: "native-id",
      });
    }
  });

  it("preserves a lane-native id that itself contains separators", () => {
    // Graph child mission ids are `graph:<graphId>:node:<nodeId>`, so the id
    // segment must be rejoined verbatim rather than split on every colon.
    const laneNativeId = "graph:some-graph:node:autoposter_schedule";

    expect(parseOsMissionId(osMissionIdFor("autoposter_direct_mission", laneNativeId)))
      .toEqual({ lane: "autoposter_direct_mission", laneNativeId });
  });

  it("keeps the same lane-native id distinct across lanes", () => {
    const generic = osMissionIdFor("generic_governed_task", "same-id");
    const platform = osMissionIdFor("platform_autoposter_command", "same-id");

    expect(generic).not.toBe(platform);
    expect(parseOsMissionId(generic)?.lane).toBe("generic_governed_task");
    expect(parseOsMissionId(platform)?.lane).toBe("platform_autoposter_command");
  });

  it("refuses anything that is not a canonical identity", () => {
    for (const value of [
      undefined,
      null,
      42,
      "",
      "mission-a",
      "os:mission-a",
      "os:generic_governed_task:",
      "os:no_such_lane:mission-a",
      "prefix:generic_governed_task:mission-a",
    ]) {
      expect(parseOsMissionId(value)).toBeNull();
    }
  });
});

describe("CHANTER OS canonical state taxonomy", () => {
  it("maps every durable execution state into the canonical taxonomy", () => {
    for (const state of EXECUTION_STATES) {
      const mapped = osStateFromExecutionState(state, "NONE");
      expect(OS_MISSION_STATES).toContain(mapped);
    }
  });

  it("never claims completion without a completed durable boundary", () => {
    const completing = EXECUTION_STATES.filter(
      (state) => osStateFromExecutionState(state, "NONE") === "completed",
    );

    expect(completing).toEqual(["completed"]);
  });

  it("reports a persisted-but-unjournaled result as observed, not completed", () => {
    expect(osStateFromExecutionState("result_persisted", "NONE"))
      .toBe("downstream_result_observed");
  });

  it("reports an in-flight bounded recovery as a recoverable failure", () => {
    expect(osStateFromExecutionState("recovery_in_progress", "NONE"))
      .toBe("failed_recoverable");
  });

  it("distinguishes a human stop from a system failure", () => {
    expect(osStateFromExecutionState("failed_terminal", "STOPPED_FOR_ESCALATION"))
      .toBe("stopped");
    expect(osStateFromExecutionState("failed_terminal", "RECOVERY_EVIDENCE_INVALID"))
      .toBe("failed_terminal");
  });

  it("maps every graph orchestration state into the canonical taxonomy", () => {
    const graphStates = [
      "approval_required", "approved", "running", "completed",
      "failed_recoverable", "failed_terminal", "cancelled",
    ] as const;

    for (const state of graphStates) {
      expect(OS_MISSION_STATES).toContain(osStateFromGraphState(state));
    }
    expect(osStateFromGraphState("cancelled")).toBe("stopped");
    expect(osStateFromGraphState("running")).toBe("execution_started");
  });

  it("treats exactly the three terminal states as terminal", () => {
    const terminal = OS_MISSION_STATES.filter((state: OsMissionState) =>
      isTerminalOsMissionState(state));

    expect(terminal).toEqual(["completed", "failed_terminal", "stopped"]);
  });
});

describe("CHANTER OS replay outcome", () => {
  it("passes through the Runtime's own idempotency decision", () => {
    expect(osReplayOutcome("first_execution")).toBe("first_execution");
    expect(osReplayOutcome("duplicate")).toBe("duplicate");
    expect(osReplayOutcome("mismatch")).toBe("mismatch");
    expect(osReplayOutcome("not_applicable")).toBe("not_applicable");
  });

  it("reports an absent decision as not observed rather than inventing one", () => {
    expect(osReplayOutcome(undefined)).toBe("not_observed");
    expect(osReplayOutcome(null)).toBe("not_observed");
    expect(osReplayOutcome("something_else")).toBe("not_observed");
  });
});

describe("CHANTER OS lane registry", () => {
  it("registers exactly the reviewed lanes", () => {
    expect(OS_MISSION_LANE_SPECS.map((spec) => spec.lane)).toEqual([
      "generic_governed_task",
      "platform_autoposter_command",
      "autoposter_direct_mission",
      "governed_agentic_mission",
    ]);
  });

  it("binds every product-action lane to a reviewed action in the closed-world registry", () => {
    const registered = listRegisteredMissionActions();
    const dispatchLanes = OS_MISSION_LANE_SPECS
      .filter((spec) => spec.executionModel === "downstream_product_action");

    expect(dispatchLanes.length).toBeGreaterThan(0);
    for (const spec of dispatchLanes) {
      const action = registeredActionForLane(spec);
      expect(registered).toContain(action);
      expect(action.product).toBe(spec.product);
      expect(action.action).toBe(spec.action);
      // The downstream operation type is read from the action registry, never
      // duplicated into the OS registry, so the two cannot drift apart.
      expect(action.downstreamOperationType.length).toBeGreaterThan(0);
    }
  });

  it("requires a plan-governed lane to declare its own downstream identity", () => {
    // A plan-governed lane has no single reviewed action to read one from,
    // because its execution spans many capabilities. The equivalent obligation
    // is that it states the identity itself rather than leaving it inferred.
    const planGoverned = OS_MISSION_LANE_SPECS
      .filter((spec) => spec.executionModel === "governed_agentic_plan");

    expect(planGoverned.map((spec) => spec.lane)).toEqual(["governed_agentic_mission"]);
    for (const spec of planGoverned) {
      expect(spec.declaredDownstreamOperationType?.length ?? 0).toBeGreaterThan(0);
      expect(osDownstreamOperationType(spec)).toBe(spec.declaredDownstreamOperationType);
      expect(resolveRegisteredMissionAction(spec.product, spec.action)).toBeNull();
    }
  });

  it("routes each canonical intake schema to exactly one submittable lane", () => {
    expect(osLaneForIntakeSchema("chanter.mission.v1")?.lane)
      .toBe("generic_governed_task");
    expect(osLaneForIntakeSchema("chanter.platform.autoposter.create-work.v1")?.lane)
      .toBe("platform_autoposter_command");
    expect(osLaneForIntakeSchema("chanter.mission.graph.v1")).toBeNull();
    expect(osLaneForIntakeSchema(undefined)).toBeNull();
  });

  it("keeps the observed-only lane out of intake routing", () => {
    const direct = osMissionLaneSpec("autoposter_direct_mission");

    expect(direct.intakeSchemaVersion).toBeNull();
    expect(
      OS_MISSION_LANE_SPECS
        .filter((spec) => spec.intakeSchemaVersion !== null)
        .map((spec) => spec.lane),
    ).toEqual([
      "generic_governed_task",
      "platform_autoposter_command",
      "governed_agentic_mission",
    ]);
  });

  it("routes the agentic work schema to the plan-governed lane", () => {
    expect(osLaneForIntakeSchema("chanter.agentic-work.v1")?.lane)
      .toBe("governed_agentic_mission");
  });

  it("marks only AutoPoster lanes as permitted to reach a real external system", () => {
    const external = OS_MISSION_LANE_SPECS
      .filter((spec) => spec.realExternalExecutionAllowed)
      .map((spec) => spec.lane);

    expect(external).toEqual(["platform_autoposter_command", "autoposter_direct_mission"]);
  });

  it("binds the Platform lane's approval to the exact graph hash", () => {
    expect(osMissionLaneSpec("platform_autoposter_command").approvalRequirement)
      .toBe("operator_control_approval_bound_to_graph_hash");
    expect(osMissionLaneSpec("generic_governed_task").approvalRequirement)
      .toBe("operator_control_approval");
  });

  it("names a distinct durable source of truth per lane", () => {
    const sources = OS_MISSION_LANE_SPECS.map((spec) => spec.sourceOfTruth);

    expect(new Set(sources).size).toBe(sources.length);
  });
});
