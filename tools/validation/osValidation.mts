/**
 * CHANTER OS canonical validation gate.
 *
 * One ordered sequence of existing repository commands. Every stage is an npm
 * script that already exists and is already the repository's truth for that
 * check — this module composes them, it never reimplements them.
 *
 * The ordering is deliberate: static checks run before anything is built, and
 * the build runs before any proof, so a cheap failure is never masked by an
 * expensive one. Execution stops at the first failing stage and the aggregate
 * exit code is that stage's real exit code.
 *
 * `runOsValidation` takes its stage runner as a parameter so the short-circuit
 * and exit-code contract can be verified with a controlled stub, without
 * running the real multi-minute suites.
 */

export interface OsValidationStage {
  /** Human-readable stage boundary printed around execution. */
  readonly name: string;
  /** An existing npm script in this repository. */
  readonly script: string;
}

/**
 * Ordered stages. Cheapest and most diagnostic first:
 *   static correctness -> build -> narrow proof -> broad cross-repository proof.
 */
export const OS_VALIDATION_STAGES: readonly OsValidationStage[] = Object.freeze([
  Object.freeze({ name: "Repository typecheck (backend + frontend)", script: "typecheck" }),
  Object.freeze({ name: "Tools static typecheck", script: "typecheck:tools" }),
  Object.freeze({ name: "Production build", script: "build" }),
  // Cheapest proof in the gate: fully in-process, no server, no subprocess, no
  // network. It interrupts real executions at real durable boundaries, so a
  // broken recovery contract is reported in seconds rather than after the
  // multi-minute cross-repository proofs below.
  Object.freeze({
    name: "OS unified recovery and reconciliation proof",
    script: "test:os-recovery",
  }),
  // Same in-process shape as the stage above and still far cheaper than any
  // cross-repository proof, but it spans three durable authorities (command,
  // graph, child mission), so it runs second of the two.
  Object.freeze({
    name: "OS unified Platform-lane recovery proof",
    script: "test:os-platform-recovery",
  }),
  // Last of the three in-process recovery proofs and still cheaper than any
  // cross-repository stage. It runs after the deterministic ones because it is
  // the hardest case — the downstream outcome was never observed — so a plain
  // broken recovery contract is reported by the two stages above first.
  Object.freeze({
    name: "OS ambiguous-downstream reconciliation proof",
    script: "test:os-ambiguous-reconciliation",
  }),
  Object.freeze({
    name: "Canonical Platform command authority proof",
    script: "test:platform-canonical:e2e",
  }),
  Object.freeze({ name: "Phase 2C generic mission proof", script: "test:phase2c:mission" }),
  Object.freeze({ name: "Signed approval migration E2E", script: "test:approval-migration:e2e" }),
  Object.freeze({ name: "OS end-to-end operational assembly", script: "os:assembly" }),
  // Last by cost and by diagnostic value: it drives both execution lanes, a
  // real Loop Governor child process, and a real AutoPoster boundary through
  // the unified control plane, so the narrower single-lane assembly proof
  // above is the more useful first signal when something breaks.
  Object.freeze({ name: "OS unified mission control plane", script: "os:unified" }),
  // Terminal and most expensive: it drives a real Operator process through a
  // full compile -> parallel execution -> verification -> two human approvals ->
  // one artifact write -> node recovery -> restart replay path, plus a second
  // Operator process for the contradiction case. Every cheaper stage above is a
  // more useful first signal, so this one runs only once they are all green.
  Object.freeze({
    name: "OS governed agentic execution fabric",
    script: "os:agentic-fabric",
  }),
  // Terminal, and the most expensive stage in the gate by a wide margin: it is
  // the only one that performs real model inference. Two live provider calls per
  // mission across two missions, plus six additional Operator processes for the
  // provider-failure scenarios.
  //
  // It runs last for the usual reason — every cheaper stage is a more useful
  // first signal — and it is *in* the gate despite needing a live local model
  // because a canonical gate that skipped the only real inference in the system
  // would certify the fabric's governance without ever exercising it.
  // Placed *before* the model-worker stage on cost. It performs no inference at
  // all — every node in an operational-exception plan is a deterministic tool —
  // so it runs in seconds and gives a far earlier signal than the stage that
  // spends minutes on real model calls.
  Object.freeze({
    name: "OS operational exception mission",
    script: "os:operational-exception",
  }),
  // Terminal, and the most expensive stage in the gate by a wide margin: it is
  // the only one that performs real model inference. Two live provider calls per
  // mission across two missions, plus six additional Operator processes for the
  // provider-failure scenarios.
  //
  // It runs last for the usual reason — every cheaper stage is a more useful
  // first signal — and it is *in* the gate despite needing a live local model
  // because a canonical gate that skipped the only real inference in the system
  // would certify the fabric's governance without ever exercising it.
  Object.freeze({
    name: "OS collective synthetic intelligence model workers",
    script: "os:csi-model-workers",
  }),
]);

/** Resolves to the stage's real process exit code. */
export type OsValidationStageRunner = (stage: OsValidationStage) => Promise<number>;

export interface OsValidationOutcome {
  readonly ok: boolean;
  /** The failing stage's exit code, or 0 when every stage passed. */
  readonly exitCode: number;
  /** Stage names that ran and exited 0, in order. */
  readonly completed: readonly string[];
  /** The first failing stage, or null. */
  readonly failedStage: OsValidationStage | null;
  /** Stages never started because an earlier stage failed, in order. */
  readonly skipped: readonly string[];
}

export interface OsValidationOptions {
  readonly run: OsValidationStageRunner;
  readonly stages?: readonly OsValidationStage[];
  readonly log?: (line: string) => void;
}

/**
 * Runs each stage in order, stopping at the first failure.
 *
 * A stage that throws is treated as a failure with exit code 1 rather than
 * propagating, so a spawn error is reported as a named failing stage instead
 * of an unhandled rejection.
 */
export async function runOsValidation(options: OsValidationOptions): Promise<OsValidationOutcome> {
  const stages = options.stages ?? OS_VALIDATION_STAGES;
  const log = options.log ?? ((line: string) => console.log(line));
  const completed: string[] = [];

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    if (!stage) continue;
    const label = `[${index + 1}/${stages.length}] ${stage.name}`;
    log("");
    log(`=== ${label} — npm run ${stage.script}`);

    let exitCode: number;
    try {
      exitCode = await options.run(stage);
    } catch (error) {
      log(`--- FAIL ${label}: ${error instanceof Error ? error.message : String(error)}`);
      return {
        ok: false,
        exitCode: 1,
        completed,
        failedStage: stage,
        skipped: stages.slice(index + 1).map((remaining) => remaining.name),
      };
    }

    if (exitCode !== 0) {
      log(`--- FAIL ${label} (exit ${exitCode})`);
      return {
        ok: false,
        exitCode,
        completed,
        failedStage: stage,
        skipped: stages.slice(index + 1).map((remaining) => remaining.name),
      };
    }
    log(`--- PASS ${label}`);
    completed.push(stage.name);
  }

  return { ok: true, exitCode: 0, completed, failedStage: null, skipped: [] };
}

/** Deterministic end-of-run summary for both success and failure. */
export function formatOsValidationSummary(outcome: OsValidationOutcome): string {
  const lines = ["", "=== CHANTER OS validation summary"];
  for (const name of outcome.completed) lines.push(`  PASS  ${name}`);
  if (outcome.failedStage) lines.push(`  FAIL  ${outcome.failedStage.name} (exit ${outcome.exitCode})`);
  for (const name of outcome.skipped) lines.push(`  SKIP  ${name} (not run)`);
  lines.push("");
  lines.push(outcome.ok ? "Verdict: PASS" : `Verdict: FAIL (exit ${outcome.exitCode})`);
  return lines.join("\n");
}
