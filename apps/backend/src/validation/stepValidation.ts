import type { RunnerResult } from "../runners/runner.js";

export interface ValidationResult {
  passed: boolean;
  summary: string;
}

export function validateRunnerResult(result: RunnerResult): ValidationResult {
  if (result.exitCode !== 0) {
    return { passed: false, summary: `Mock execution failed with exit code ${result.exitCode}.` };
  }
  if (result.stderr.trim()) {
    return { passed: false, summary: "Mock execution returned error output." };
  }
  return {
    passed: true,
    summary: "Mock execution completed safely; no real operation was performed.",
  };
}

