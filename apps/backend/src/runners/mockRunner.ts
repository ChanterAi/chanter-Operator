import type { ExecutionStep, TaskIntent } from "../types.js";
import type { Runner, RunnerResult } from "./runner.js";

const messages: Record<ExecutionStep["action_type"], string> = {
  analysis: "Analysis preview completed. No external model was called.",
  read_file: "Read preview completed. No file system content was accessed.",
  file_write: "File write simulated. The workspace was not modified.",
  file_edit: "File edit simulated. The workspace was not modified.",
  shell_command: "Shell command simulated. No command was executed.",
  unknown: "Unknown action simulated and contained. No operation was executed.",
};

export class MockRunner implements Runner {
  run(task: TaskIntent, step: ExecutionStep): RunnerResult {
    const relativePath = String(step.action_payload.workspace_relative_path ?? "workspace/mock-output.txt");
    const hasDiff = step.action_type === "file_write" || step.action_type === "file_edit";

    return {
      stdout: `[mock-runner] ${messages[step.action_type]} Task: ${task.parsed_description}`,
      stderr: "",
      exitCode: 0,
      diff: hasDiff
        ? `--- a/${relativePath}\n+++ b/${relativePath}\n@@ preview @@\n+Mock preview only; no file was written.`
        : "",
    };
  }
}

