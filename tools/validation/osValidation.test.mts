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
        "test:platform-canonical:e2e",
        "test:phase2c:mission",
        "test:approval-migration:e2e",
        "os:assembly",
      ],
    );
  });
});
