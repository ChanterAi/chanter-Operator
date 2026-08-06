/**
 * Orchestration contract for the canonical CHANTER OS validation gate.
 *
 * These tests exist to prove failure propagation without corrupting any source
 * file or running the real multi-minute suites: the stage runner is a
 * controlled stub, so "a failing stage stops the run and the aggregate exit
 * code is that stage's real exit code" is measured rather than assumed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  OS_VALIDATION_STAGES,
  formatOsValidationSummary,
  runOsValidation,
  type OsValidationStage,
} from "./osValidation.mjs";

const stages: readonly OsValidationStage[] = Object.freeze([
  Object.freeze({ name: "first", script: "first-script" }),
  Object.freeze({ name: "second", script: "second-script" }),
  Object.freeze({ name: "third", script: "third-script" }),
]);

/** Records execution order so "did not run" is observed, not inferred. */
function stubRunner(exitCodes: Readonly<Record<string, number>>, started: string[]) {
  return async (stage: OsValidationStage): Promise<number> => {
    started.push(stage.script);
    return exitCodes[stage.script] ?? 0;
  };
}

const silent = () => {};

describe("CHANTER OS validation orchestration", () => {
  it("runs every stage in declared order and exits 0 when all pass", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      stages,
      run: stubRunner({}, started),
      log: silent,
    });

    assert.equal(outcome.ok, true);
    assert.equal(outcome.exitCode, 0);
    assert.deepEqual(started, ["first-script", "second-script", "third-script"]);
    assert.deepEqual(outcome.completed, ["first", "second", "third"]);
    assert.equal(outcome.failedStage, null);
    assert.deepEqual(outcome.skipped, []);
  });

  it("stops at the first failing stage and never starts later stages", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      stages,
      run: stubRunner({ "second-script": 7 }, started),
      log: silent,
    });

    assert.equal(outcome.ok, false);
    // The failing stage's real exit code is preserved, not collapsed to 1.
    assert.equal(outcome.exitCode, 7);
    assert.deepEqual(started, ["first-script", "second-script"], "the third stage must never start");
    assert.deepEqual(outcome.completed, ["first"]);
    assert.equal(outcome.failedStage?.name, "second");
    assert.deepEqual(outcome.skipped, ["third"]);
  });

  it("fails closed when a stage cannot be started at all", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      stages,
      run: async (stage) => {
        started.push(stage.script);
        if (stage.script === "first-script") throw new Error("spawn failed");
        return 0;
      },
      log: silent,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.deepEqual(started, ["first-script"]);
    assert.equal(outcome.failedStage?.name, "first");
    assert.deepEqual(outcome.skipped, ["second", "third"]);
  });

  it("reports a nonzero first stage without claiming any stage completed", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      stages,
      run: stubRunner({ "first-script": 2 }, started),
      log: silent,
    });

    assert.equal(outcome.exitCode, 2);
    assert.deepEqual(outcome.completed, []);
    assert.deepEqual(outcome.skipped, ["second", "third"]);
  });

  it("summarizes a failure as FAIL with the failing and skipped stages named", async () => {
    const outcome = await runOsValidation({
      stages,
      run: stubRunner({ "second-script": 3 }, []),
      log: silent,
    });
    const summary = formatOsValidationSummary(outcome);

    assert.match(summary, /Verdict: FAIL \(exit 3\)/);
    assert.match(summary, /PASS {2}first/);
    assert.match(summary, /FAIL {2}second \(exit 3\)/);
    assert.match(summary, /SKIP {2}third \(not run\)/);
  });

  it("declares the canonical stage order the gate is required to run", () => {
    assert.deepEqual(
      OS_VALIDATION_STAGES.map((stage) => stage.script),
      [
        "typecheck",
        "typecheck:tools",
        "build",
        "test:os-recovery",
        "test:platform-canonical:e2e",
        "test:phase2c:mission",
        "test:approval-migration:e2e",
        "os:assembly",
        "os:unified",
      ],
    );
  });

  it("orders the in-process recovery proof ahead of every cross-repository proof", () => {
    const scripts = OS_VALIDATION_STAGES.map((stage) => stage.script);
    const recovery = scripts.indexOf("test:os-recovery");

    // Cheapest and most diagnostic first is the gate's ordering contract, and
    // the recovery proof is the only proof that needs no server, subprocess,
    // or network at all.
    for (const slower of [
      "test:platform-canonical:e2e",
      "test:phase2c:mission",
      "test:approval-migration:e2e",
      "os:assembly",
      "os:unified",
    ]) {
      assert.ok(recovery < scripts.indexOf(slower), `recovery must precede ${slower}`);
    }
    assert.ok(recovery > scripts.indexOf("build"), "static checks and the build still come first");
  });
});

/*
 * Fail-fast propagation measured against the *real* stage list.
 *
 * The tests above prove the orchestration contract on a synthetic list; these
 * prove it on the exact sequence the gate ships, so removing or reordering a
 * canonical stage cannot quietly keep the contract green.
 *
 * `os:unified` is the terminal stage, so "a failure skips everything after it"
 * is proven here in the two ways that are actually observable: an earlier
 * failure must skip `os:unified`, and a failure *in* `os:unified` must
 * propagate its exact child exit code without claiming any stage after it ran.
 */
describe("CHANTER OS validation gate — unified proof fail-fast", () => {
  it("skips the unified proof when an earlier canonical stage fails", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      run: stubRunner({ "os:assembly": 11 }, started),
      log: silent,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 11, "the failing stage's real exit code is preserved");
    assert.equal(started.includes("os:unified"), false, "the unified proof must never start");
    assert.deepEqual(outcome.skipped, ["OS unified mission control plane"]);
  });

  it("skips every proof after a failing in-process recovery proof", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      run: stubRunner({ "test:os-recovery": 5 }, started),
      log: silent,
    });

    assert.equal(outcome.exitCode, 5);
    assert.deepEqual(
      started,
      ["typecheck", "typecheck:tools", "build", "test:os-recovery"],
      "no cross-repository proof may start after the cheap recovery proof fails",
    );
    assert.equal(outcome.skipped.length, 5);
  });

  it("preserves the unified proof's exact exit code and completes nothing after it", async () => {
    const started: string[] = [];
    const outcome = await runOsValidation({
      run: stubRunner({ "os:unified": 23 }, started),
      log: silent,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 23, "the unified proof's real exit code is not collapsed to 1");
    assert.equal(outcome.failedStage?.script, "os:unified");
    assert.deepEqual(
      started,
      OS_VALIDATION_STAGES.map((stage) => stage.script),
      "every earlier stage ran exactly once, in order",
    );
    assert.equal(
      outcome.completed.includes("OS unified mission control plane"),
      false,
      "a failing stage is never reported as completed",
    );
    assert.deepEqual(outcome.skipped, [], "nothing follows the terminal stage");
  });

  it("fails closed when the unified proof cannot be started at all", async () => {
    const outcome = await runOsValidation({
      run: async (stage) => {
        if (stage.script === "os:unified") throw new Error("spawn failed");
        return 0;
      },
      log: silent,
    });

    assert.equal(outcome.ok, false);
    assert.equal(outcome.exitCode, 1);
    assert.equal(outcome.failedStage?.script, "os:unified");
  });
});
