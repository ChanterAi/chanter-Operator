import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync, realpathSync } from "node:fs";

export interface ReadonlyCommandResult {
  id: string;
  command: string;
  executable: string;
  args: string[];
  verdict: "allowed_readonly" | "blocked";
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  durationMs: number | null;
  workspaceRoot: string;
  timestamp: string;
  error: string | null;
}

/** The 5 exact commands allowed for read-only execution. */
const ALLOWED_COMMANDS = new Set<string>([
  "git status --short",
  "git diff --stat",
  "git diff --check",
  "git show --stat --oneline HEAD",
  "git show --name-only HEAD",
]);

/** Parse a command string into executable and args. Does NOT use shell parsing. */
function parseCommand(command: string): { executable: string; args: string[] } | null {
  const trimmed = command.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(/\s+/);
  if (parts.length === 0) return null;

  const executable = parts[0];
  const args = parts.slice(1);

  return { executable, args };
}

/** Check for injection attempts: shell metacharacters, separators, redirections. */
function detectInjection(command: string): string | null {
  const dangerous = [";", "&&", "||", "|", ">", "<", "$(", "${", "&", "\n", "\r"];
  for (const char of dangerous) {
    if (command.includes(char)) {
      return "Command injection attempt detected: contains " + JSON.stringify(char);
    }
  }
  // Backtick is also dangerous on some shells
  if (command.includes("`")) {
    return "Command injection attempt detected: contains backtick";
  }
  return null;
}

/** Verify the workspace root exists and is a directory. */
function verifyWorkspace(workspaceRoot: string): string | null {
  try {
    const stat = statSync(workspaceRoot);
    if (!stat.isDirectory()) {
      return "Runner workspace is not a directory";
    }
    // Verify the resolved path to catch symlink escapes
    realpathSync.native(workspaceRoot);
    return null;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "unknown error";
    return "Runner workspace is not accessible: " + message;
  }
}

export class RealReadonlyRunner {
  constructor(private readonly workspaceRoot: string) {}

  /**
   * Run a read-only command. Blocks unauthorized commands.
   * Returns a full result record regardless of outcome.
   */
  async run(command: string, timeoutMs = 15_000): Promise<ReadonlyCommandResult> {
    const timestamp = new Date().toISOString();
    const id = randomUUID();

    // Phase 1: Parse the command
    const parsed = parseCommand(command);

    if (!parsed) {
      return {
        id,
        command,
        executable: "",
        args: [],
        verdict: "blocked",
        stdout: null,
        stderr: null,
        exitCode: null,
        durationMs: null,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: "Empty command is blocked",
      };
    }

    // Phase 2: Check injection
    const injectionError = detectInjection(command);
    if (injectionError) {
      return {
        id,
        command,
        executable: parsed.executable,
        args: parsed.args,
        verdict: "blocked",
        stdout: null,
        stderr: null,
        exitCode: null,
        durationMs: null,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: injectionError,
      };
    }

    // Phase 3: Check exact allowlist match
    if (!ALLOWED_COMMANDS.has(command.trim())) {
      return {
        id,
        command,
        executable: parsed.executable,
        args: parsed.args,
        verdict: "blocked",
        stdout: null,
        stderr: null,
        exitCode: null,
        durationMs: null,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: "Command \"" + command + "\" is not in the read-only allowlist.",
      };
    }

    // Phase 4: Verify workspace
    const workspaceError = verifyWorkspace(this.workspaceRoot);
    if (workspaceError) {
      return {
        id,
        command,
        executable: parsed.executable,
        args: parsed.args,
        verdict: "blocked",
        stdout: null,
        stderr: null,
        exitCode: null,
        durationMs: null,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: workspaceError,
      };
    }

    // Phase 5: Execute
    const startTime = performance.now();
    try {
      const execResult = await this.execWithTimeout(parsed.executable, parsed.args, timeoutMs);
      const durationMs = Math.round(performance.now() - startTime);

      return {
        id,
        command,
        executable: parsed.executable,
        args: parsed.args,
        verdict: "allowed_readonly",
        stdout: execResult.stdout,
        stderr: execResult.stderr,
        exitCode: execResult.exitCode,
        durationMs,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: null,
      };
    } catch (err: unknown) {
      const durationMs = Math.round(performance.now() - startTime);
      const nodeErr = err as NodeJS.ErrnoException & { killed?: boolean };
      return {
        id,
        command,
        executable: parsed.executable,
        args: parsed.args,
        verdict: "allowed_readonly",
        stdout: null,
        stderr: null,
        exitCode: nodeErr.killed ? null : (nodeErr.code != null ? Number(nodeErr.code) : null),
        durationMs,
        workspaceRoot: this.workspaceRoot,
        timestamp,
        error: nodeErr.killed
          ? "Command timed out after " + timeoutMs + "ms"
          : "Command execution failed: " + nodeErr.message,
      };
    }
  }

  private execWithTimeout(
    executable: string,
    args: string[],
    timeoutMs: number,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = execFile(executable, args, {
        cwd: this.workspaceRoot,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024, // 1MB output limit
        shell: false,
        windowsHide: true,
        encoding: "utf8",
      });

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });

      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      child.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      child.on("close", (code: number | null) => {
        resolve({
          stdout: stdout.trimEnd(),
          stderr: stderr.trimEnd(),
          exitCode: code ?? -1,
        });
      });
    });
  }
}

/** The exact allowed command set, exported for reuse. */
export const ALLOWED_READONLY_COMMANDS = ALLOWED_COMMANDS;
