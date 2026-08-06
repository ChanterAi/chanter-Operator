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
  Object.freeze({ name: "Phase 2C generic mission proof", script: "test:phase2c:mission" }),
  Object.freeze({ name: "Signed approval migration E2E", script: "test:approval-migration:e2e" }),
  Object.freeze({ name: "OS end-to-end operational assembly", script: "os:assembly" }),
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
