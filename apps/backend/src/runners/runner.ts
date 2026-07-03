import type { ExecutionStep, TaskIntent } from "../types.js";

export interface RunnerResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  diff: string;
}

export interface Runner {
  run(task: TaskIntent, step: ExecutionStep): RunnerResult;
}

