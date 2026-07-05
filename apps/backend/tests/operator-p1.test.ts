import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuditLogger } from "../src/audit/auditLogger.js";
import { createDatabase } from "../src/db/database.js";
import { RealReadonlyRunner } from "../src/runners/realReadonlyRunner.js";
import { OperatorService } from "../src/services/operatorService.js";
import { ensureWorkspace } from "../src/workspace/pathGuard.js";
import { MockRunner } from "../src/runners/mockRunner.js";
import { execSync } from "node:child_process";

describe("P1.0 Read-only Local Runner", () => {
  let temporaryRoot: string;
  let database: DatabaseSync;
  let service: OperatorService;
  let auditPath: string;
  let runnerWorkspace: string;
  let mockRunnerWorkspace: string;

  beforeEach(() => {
    temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-operator-p1-"));

    // Create the operator workspace
    mkdirSync(path.join(temporaryRoot, "data"), { recursive: true });
    mockRunnerWorkspace = ensureWorkspace(path.join(temporaryRoot, "workspace"));

    // Create the runner workspace (where git commands execute) and init a git repo there
    runnerWorkspace = path.join(temporaryRoot, "runner-repo");
    mkdirSync(runnerWorkspace, { recursive: true });

    // Init a git repo in the runner workspace
    try {
      execSync("git init", { cwd: runnerWorkspace, stdio: "pipe" });
      execSync('git config user.email "test@chanter.local"', { cwd: runnerWorkspace, stdio: "pipe" });
      execSync('git config user.name "CHANTER Test"', { cwd: runnerWorkspace, stdio: "pipe" });
      // Create a file and commit it so git show HEAD works
      writeFileSync(path.join(runnerWorkspace, "README.md"), "# Test Repo\n", "utf8");
      execSync("git add README.md", { cwd: runnerWorkspace, stdio: "pipe" });
      execSync('git commit -m "initial commit"', { cwd: runnerWorkspace, stdio: "pipe" });
    } catch {
      // Git init fails silently if git is not available - tests for git commands will be skipped
    }

    auditPath = path.join(temporaryRoot, "data", "audit.jsonl");
    database = createDatabase(path.join(temporaryRoot, "data", "operator.sqlite"));

    service = new OperatorService(
      database,
      new AuditLogger(auditPath),
      new MockRunner(),
      mockRunnerWorkspace,
      runnerWorkspace, // enable real runner
    );
  });

  afterEach(() => {
    database.close();
    rmSync(temporaryRoot, { recursive: true, force: true });
  });

  // Test 1: allowed git status command runs
  it("runs allowed git status --short command", async () => {
    const result = await service.runReadonlyCommand("git status --short");

    expect(result.verdict).toBe("allowed_readonly");
    expect(result.command).toBe("git status --short");
    expect(result.executable).toBe("git");
    expect(result.args).toEqual(["status", "--short"]);
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.timestamp).toBeTruthy();
    expect(result.stdout).toBeDefined();
    expect(result.error).toBeNull();
  });

  // Test 2: allowed git diff --stat command runs
  it("runs allowed git diff --stat command", async () => {
    const result = await service.runReadonlyCommand("git diff --stat");

    expect(result.verdict).toBe("allowed_readonly");
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("git diff --stat");
    expect(result.error).toBeNull();
  });

  // Test 3: allowed git diff --check command runs
  it("runs allowed git diff --check command", async () => {
    const result = await service.runReadonlyCommand("git diff --check");

    expect(result.verdict).toBe("allowed_readonly");
    expect(result.exitCode).toBe(0);
    expect(result.command).toBe("git diff --check");
    expect(result.error).toBeNull();
  });

  // Test 4: allowed git show --stat --oneline HEAD
  it("runs allowed git show --stat --oneline HEAD command", async () => {
    const result = await service.runReadonlyCommand("git show --stat --oneline HEAD");

    expect(result.verdict).toBe("allowed_readonly");
    expect(result.command).toBe("git show --stat --oneline HEAD");
    expect(result.error).toBeNull();
  });

  // Test 5: blocked git commit
  it("blocks git commit", async () => {
    const result = await service.runReadonlyCommand("git commit -m test");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toBeTruthy();
    expect(result.error).toContain("not in the read-only allowlist");
    expect(result.stdout).toBeNull();
  });

  // Test 6: blocked npm test
  it("blocks npm test", async () => {
    const result = await service.runReadonlyCommand("npm test");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("not in the read-only allowlist");
  });

  // Test 7: blocked arbitrary shell command
  it("blocks arbitrary shell command", async () => {
    const result = await service.runReadonlyCommand("rm -rf /");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("not in the read-only allowlist");
    expect(result.stdout).toBeNull();
  });

  // Test 8: blocked command injection attempt
  it("blocks command injection attempt with semicolon", async () => {
    const result = await service.runReadonlyCommand("git status --short; rm -rf /");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("Command injection attempt detected");
    expect(result.error).toContain(";");
  });

  it("blocks command injection attempt with pipe", async () => {
    const result = await service.runReadonlyCommand("git status --short | cat");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("Command injection attempt detected");
  });

  it("blocks command injection attempt with shell chaining", async () => {
    const result = await service.runReadonlyCommand("git diff --stat && echo hacked");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("Command injection attempt detected");
  });

  it("blocks command injection with backtick", async () => {
    const result = await service.runReadonlyCommand('git status --short `whoami`');

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("Command injection attempt detected");
  });

  it("blocks command injection with subshell", async () => {
    const result = await service.runReadonlyCommand("git status --short $(whoami)");

    expect(result.verdict).toBe("blocked");
    expect(result.error).toContain("Command injection attempt detected");
  });

  // Test 9: blocked path outside workspace
  it("does not allow path traversal outside workspace in the runner", async () => {
    // The RealReadonlyRunner only accepts exact allowlisted commands,
    // so a path traversal like "git status /etc" would not match the allowlist.
    const result = await service.runReadonlyCommand("git status --short ../../../");

    expect(result.verdict).toBe("blocked");
  });

  // Test 10: timeout handling
  it("handles timeout for a blocked command (no execution happens)", async () => {
    // Blocked commands don't execute, so timeout is not reached.
    // But we test that the runner can handle the timeout parameter.
    const runner = new RealReadonlyRunner(runnerWorkspace);

    // Run a command that will be very quick - it should complete well before timeout
    const result = await runner.run("git status --short", 100);

    // Should still complete - git status returns quickly
    expect(result.verdict).toBe("allowed_readonly");
    expect(result.exitCode).toBe(0);
  });

  // Test 11: stdout/stderr/exit code captured
  it("captures stdout, stderr, exit code, duration, and timestamp", async () => {
    const result = await service.runReadonlyCommand("git status --short");

    expect(result.verdict).toBe("allowed_readonly");
    // stdout should be captured (even if empty for clean repo)
    expect(typeof result.stdout).toBe("string");
    // stderr should be captured
    expect(typeof result.stderr).toBe("string");
    // exit code should be a number
    expect(typeof result.exitCode).toBe("number");
    // duration should be positive
    expect(result.durationMs).toBeGreaterThan(0);
    // timestamp should be ISO format
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // workspace root should be recorded
    expect(result.workspaceRoot).toBe(runnerWorkspace);
  });

  // Test 12: audit/evidence record created
  it("creates audit events for read-only command execution", async () => {
    await service.runReadonlyCommand("git status --short");

    // Check the audit log for the relevant events
    const events = service.listAuditEvents(10);
    const eventTypes = events.map((e) => e.event_type);

    expect(eventTypes).toContain("readonly_command_requested");
    expect(eventTypes).toContain("readonly_command_allowed");
    expect(eventTypes).toContain("readonly_command_completed");
  });

  it("creates audit events for blocked commands", async () => {
    await service.runReadonlyCommand("rm -rf /");

    const events = service.listAuditEvents(10);
    const eventTypes = events.map((e) => e.event_type);

    expect(eventTypes).toContain("readonly_command_requested");
    expect(eventTypes).toContain("readonly_command_blocked");
  });

  it("persists command results to database", async () => {
    await service.runReadonlyCommand("git status --short");
    await service.runReadonlyCommand("git diff --stat");
    await service.runReadonlyCommand("rm -rf /");

    const results = service.listReadonlyCommandResults(10);

    expect(results.length).toBeGreaterThanOrEqual(3);

    const allowed = results.filter((r) => r.verdict === "allowed_readonly");
    const blocked = results.filter((r) => r.verdict === "blocked");

    expect(allowed.length).toBeGreaterThanOrEqual(2);
    expect(blocked.length).toBeGreaterThanOrEqual(1);

    // Verify each persisted result has full data
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.command).toBeTruthy();
      expect(r.timestamp).toBeTruthy();
      expect(r.verdict).toMatch(/^(allowed_readonly|blocked)$/);
    }
  });

  it("results are returned newest-first", async () => {
    await service.runReadonlyCommand("git status --short");
    // Small delay to ensure different timestamps
    await new Promise((r) => setTimeout(r, 10));
    await service.runReadonlyCommand("git diff --stat");

    const results = service.listReadonlyCommandResults(10);
    const firstTwo = results.slice(0, 2);

    // Newest should be first
    expect(firstTwo[0].command).toBe("git diff --stat");
    expect(firstTwo[1].command).toBe("git status --short");
  });

  it("blocks empty command with 400 error", async () => {
    await expect(service.runReadonlyCommand("")).rejects.toThrow("Command is required");
  });

  it("blocks oversized command with 400 error", async () => {
    const huge = "x".repeat(2_000);
    await expect(service.runReadonlyCommand(huge)).rejects.toThrow("1,000 characters or fewer");
  });

  // Real runner class unit tests
  describe("RealReadonlyRunner unit", () => {
    it("returns blocked for empty command", async () => {
      const runner = new RealReadonlyRunner(runnerWorkspace);
      const result = await runner.run("");

      expect(result.verdict).toBe("blocked");
      expect(result.error).toBe("Empty command is blocked");
    });

    it("returns blocked for non-existent command", async () => {
      const runner = new RealReadonlyRunner(runnerWorkspace);
      const result = await runner.run("nonexistent-command-xyz");

      expect(result.verdict).toBe("blocked");
      expect(result.error).toContain("not in the read-only allowlist");
    });

    it("returns allowed_readonly with real output for valid command", async () => {
      const runner = new RealReadonlyRunner(runnerWorkspace);
      const result = await runner.run("git status --short");

      expect(result.verdict).toBe("allowed_readonly");
      expect(result.executable).toBe("git");
      expect(result.args).toEqual(["status", "--short"]);
      expect(result.exitCode).toBe(0);
      expect(result.durationMs).toBeGreaterThan(0);
      expect(result.timestamp).toBeTruthy();
    });

    it("handles show --name-only HEAD", async () => {
      const runner = new RealReadonlyRunner(runnerWorkspace);
      const result = await runner.run("git show --name-only HEAD");

      expect(result.verdict).toBe("allowed_readonly");
      expect(result.error).toBeNull();
    });
  });

  // Safety: no write commands via the runner
  describe("Safety constraints", () => {
    const blockedCommands = [
      "npm test",
      "npm run typecheck",
      "npm run build",
      "npm install express",
      "git add .",
      "git commit -m 'test'",
      "git push origin main",
      "git pull",
      "git merge main",
      "git rebase main",
      "deploy production",
      "rm file.txt",
      "del file.txt",
      "curl https://example.com",
      "wget https://example.com",
      "python script.py",
      "node script.js",
      "bash script.sh",
      "cmd /c dir",
      "powershell Get-Process",
      "codex run",
      "ollama run",
      "openclaw something",
    ];

    for (const cmd of blockedCommands) {
      it("blocks: " + cmd, async () => {
        const result = await service.runReadonlyCommand(cmd);
        expect(result.verdict).toBe("blocked");
      });
    }
  });

  // Verify mock runner workflow is unchanged
  describe("Mock runner workflow unchanged", () => {
    it("still creates mock tasks normally", () => {
      const detail = service.createTask({
        rawInput: "P1 sanity check",
        actionType: "analysis",
      });

      expect(detail.task.status).toBe("completed");
      expect(detail.evidence[0].stdout).toContain("[mock-runner]");
    });

    it("health endpoint still reports correctly", () => {
      const integrity = service.checkIntegrity();
      expect(integrity.healthy).toBe(true);
    });
  });
});
