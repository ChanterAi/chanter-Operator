/**
 * Entry point for the canonical CHANTER OS validation gate.
 *
 *   npm run validate:os
 *
 * Local process execution only. It runs existing repository commands against
 * disposable state; it never pushes, merges, deploys, publishes, or executes a
 * real coding agent.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OS_VALIDATION_STAGES,
  formatOsValidationSummary,
  runOsValidation,
  type OsValidationStage,
} from "./osValidation.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * npm is invoked through its own JS entry with the current Node binary, so no
 * shell is involved on any platform. Spawning `npm.cmd` with `shell: false`
 * fails with EINVAL on Windows, and `shell: true` would put a command line
 * through cmd.exe — this avoids both.
 */
const npmEntry = process.env.npm_execpath;

function runStage(stage: OsValidationStage): Promise<number> {
  return new Promise((resolve, reject) => {
    const useNpmEntry = typeof npmEntry === "string" && npmEntry.length > 0;
    const child = useNpmEntry
      ? spawn(process.execPath, [npmEntry, "run", stage.script], {
        cwd: repositoryRoot,
        stdio: "inherit",
        shell: false,
        windowsHide: true,
      })
      // Fallback for direct `node tools/validation/run-os-validation.mts`
      // invocation, where npm exports no entry path. The canonical command is
      // `npm run validate:os`, which always takes the branch above.
      : spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", stage.script], {
        cwd: repositoryRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
        windowsHide: true,
      });

    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code !== null) {
        resolve(code);
        return;
      }
      // Killed by a signal: never report success.
      reject(new Error(`Stage terminated by signal ${signal ?? "unknown"}.`));
    });
  });
}

console.log("CHANTER OS canonical validation gate");
console.log(`  repository: ${repositoryRoot}`);
console.log(`  stages: ${OS_VALIDATION_STAGES.length}`);

const outcome = await runOsValidation({ run: runStage });
console.log(formatOsValidationSummary(outcome));

process.exit(outcome.exitCode);
