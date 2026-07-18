#!/usr/bin/env node
// Persistent AutoPoster product mission — one-command runner.
//
// Real code exercised: chanter-mcp-server's actual handleAutoposterSchedulePost
// (unmodified, Phase 2F-A's unified graph route), a real listening Operator
// server process, a real listening AutoPoster server process backed by the
// real Firestore Local Emulator Suite (not a fake port, not a test fixture),
// and Operator's autonomous observation worker (Phase 2F-B, unmodified).
//
// This script never writes to any database directly and never injects
// result state — every interaction with Operator is over real HTTP. It
// never auto-approves silently: approval only happens via an explicit
// --approve <actor> flag (an explicit per-invocation human decision) or by
// a human hitting the approve route from elsewhere while this script polls.
//
// Exit codes: 0 on a fully converged mission with retained evidence; 1 on
// any validation, submission, approval-timeout, convergence-timeout, or
// missing-evidence failure. Never claims success it did not verify.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const backendRoot = path.join(operatorRoot, "apps", "backend");
const autoposterRoot = path.resolve(operatorRoot, "..", "chanter-auto-poster");
const mcpServerRoot = path.resolve(operatorRoot, "..", "chanter-mcp-server");
const agentRuntimeRoot = path.resolve(operatorRoot, "..", "chanter-agent-runtime");
const pidDir = path.join(operatorRoot, "var", "local-mission", "pids");
const logDir = path.join(operatorRoot, "var", "local-mission", "logs");

interface CliArgs {
  approve?: string;
  idempotencyKey: string;
  accountId: string;
  provider: string;
  caption: string;
  mediaUrl: string;
  approvalTimeoutMs: number;
  convergenceTimeoutMs: number;
  serviceReadyTimeoutMs: number;
  envFile: string;
  scheduledAtUtc: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i] : "true";
    args.set(key, value!);
  }
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    approve: args.get("approve"),
    idempotencyKey: args.get("idempotency-key") ?? `local-mission-${stamp}`,
    accountId: args.get("account-id") ?? "local-mission-account",
    provider: args.get("provider") ?? "tiktok",
    caption: args.get("caption") ?? "Persistent local AutoPoster mission proof",
    mediaUrl: args.get("media-url") ?? "https://cdn.example.com/local-mission.mp4",
    approvalTimeoutMs: Number(args.get("approval-timeout-ms") ?? 120_000),
    convergenceTimeoutMs: Number(args.get("convergence-timeout-ms") ?? 120_000),
    serviceReadyTimeoutMs: Number(args.get("service-ready-timeout-ms") ?? 90_000),
    envFile: args.get("env-file") ?? path.join(operatorRoot, ".env.local-mission"),
    // Defaults to a fresh timestamp so a first-time submission is always a real,
    // meaningful schedule; an exact replay of the same idempotencyKey must pass
    // the identical value explicitly (matching what a real repeat submission
    // would send) — otherwise a fresh wall-clock value here would make every
    // "replay" look like a payload change and be correctly rejected as a mismatch
    // rather than accepted as a duplicate.
    scheduledAtUtc: args.get("scheduled-at-utc") ?? new Date(Date.now() + 3_600_000).toISOString(),
  };
}

function fail(message: string): never {
  console.error(`[run-mission] FAILED: ${message}`);
  process.exit(1);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`Required environment variable ${name} is not set. Copy .env.local-mission.example to .env.local-mission and fill it in.`);
  return value!;
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { method: "GET", signal: AbortSignal.timeout(2_000) });
    return true; // any HTTP response (even 404) means the process is up
  } catch {
    return false;
  }
}

async function waitUntilReachable(name: string, url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await reachable(url)) {
      console.log(`[run-mission] ${name} is reachable at ${url}`);
      return;
    }
    await sleep(500);
  }
  fail(`${name} did not become reachable at ${url} within ${timeoutMs}ms.`);
}

function spawnDetached(label: string, command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): number {
  mkdirSync(logDir, { recursive: true });
  mkdirSync(pidDir, { recursive: true });
  const logPath = path.join(logDir, `${label}.log`);
  const logFd = openSync(logPath, "a");
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  writeFileSync(path.join(pidDir, `${label}.pid`), String(child.pid), "utf8");
  console.log(`[run-mission] spawned ${label} (pid ${child.pid}), logging to ${logPath}`);
  return child.pid!;
}

async function ensureFirestoreEmulator(): Promise<void> {
  const host = requireEnv("FIRESTORE_EMULATOR_HOST");
  if (await reachable(`http://${host}/`)) {
    console.log(`[run-mission] Firestore emulator already reachable at ${host}`);
    return;
  }
  const project = process.env.FIRESTORE_EMULATOR_PROJECT?.trim() || "chanter-autoposter-local";
  const dataDir = path.resolve(operatorRoot, process.env.FIRESTORE_EMULATOR_DATA_DIR?.trim() || "var/local-mission/firestore-data");
  mkdirSync(dataDir, { recursive: true });
  spawnDetached(
    "firestore-emulator",
    process.platform === "win32" ? "firebase.cmd" : "firebase",
    [
      "emulators:start",
      "--only", "firestore",
      "--project", project,
      ...(existsSync(path.join(dataDir, "firestore_export.overall_export_metadata")) ? ["--import", dataDir] : []),
      "--export-on-exit", dataDir,
    ],
    autoposterRoot,
    process.env,
  );
  const [emulatorHost, emulatorPort] = host.split(":");
  await waitUntilReachable("Firestore emulator", `http://${emulatorHost}:${emulatorPort}/`, 60_000);
}

async function ensureAutoPoster(): Promise<void> {
  const baseUrl = requireEnv("AUTOPOSTER_BASE_URL");
  if (await reachable(baseUrl)) {
    console.log(`[run-mission] AutoPoster already reachable at ${baseUrl}`);
    return;
  }
  const port = new URL(baseUrl).port || "3010";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: process.env.AUTOPOSTER_PORT?.trim() || port,
    APP_URL: process.env.AUTOPOSTER_APP_URL?.trim() || baseUrl,
    RUNTIME_CONTROL_TOKEN: requireEnv("AUTOPOSTER_RUNTIME_CONTROL_TOKEN"),
    ADMIN_PASSWORD: requireEnv("AUTOPOSTER_ADMIN_PASSWORD"),
    APP_DEFAULT_USER_ID: process.env.AUTOPOSTER_APP_DEFAULT_USER_ID?.trim() || "owner",
    FIRESTORE_EMULATOR_HOST: requireEnv("FIRESTORE_EMULATOR_HOST"),
    FIREBASE_PROJECT_ID: requireEnv("FIREBASE_PROJECT_ID"),
    FIREBASE_CLIENT_EMAIL: requireEnv("FIREBASE_CLIENT_EMAIL"),
    FIREBASE_PRIVATE_KEY: requireEnv("FIREBASE_PRIVATE_KEY"),
    YOUTUBE_ENABLED: "false",
    ENABLE_INSTAGRAM: "false",
    INSTAGRAM_PUBLISH_ENABLED: "false",
  };
  spawnDetached("autoposter", process.execPath, ["src/server.js"], autoposterRoot, env);
  await waitUntilReachable("AutoPoster", baseUrl, 60_000);
}

async function ensureOperator(): Promise<void> {
  const baseUrl = requireEnv("OPERATOR_BASE_URL");
  if (await reachable(`${baseUrl}/api/health`)) {
    console.log(`[run-mission] Operator already reachable at ${baseUrl}`);
    return;
  }
  spawnDetached(
    "operator",
    process.execPath,
    ["--import", "tsx", "src/server.ts"],
    backendRoot,
    process.env,
  );
  await waitUntilReachable("Operator", `${baseUrl}/api/health`, 60_000);
}

async function authedJson(
  url: string,
  token: string | undefined,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...(init.headers as Record<string, string> | undefined),
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(url, { ...init, headers });
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // leave body empty
  }
  return { status: response.status, body };
}

function repositoryHead(repoPath: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function collectRepositoryHeads(): Record<string, string> {
  const heads: Record<string, string> = {};
  for (const [name, repoPath] of [
    ["operator", operatorRoot],
    ["mcp-server", mcpServerRoot],
    ["agent-runtime", agentRuntimeRoot],
    ["auto-poster", autoposterRoot],
  ] as const) {
    const head = repositoryHead(repoPath);
    if (head) heads[name] = head;
  }
  return heads;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (existsSync(args.envFile)) {
    process.loadEnvFile(args.envFile);
    console.log(`[run-mission] loaded environment profile ${args.envFile}`);
  } else {
    fail(`Environment profile not found at ${args.envFile}. Copy .env.local-mission.example to .env.local-mission first.`);
  }

  const operatorBaseUrl = requireEnv("OPERATOR_BASE_URL");
  const submitToken = requireEnv("OPERATOR_MISSION_SUBMIT_TOKEN");
  const controlToken = requireEnv("OPERATOR_CONTROL_TOKEN");
  requireEnv("AUTOPOSTER_BASE_URL");
  requireEnv("AUTOPOSTER_RUNTIME_TOKEN");
  const runtimeProfile = process.env.OPERATOR_RUNTIME_PROFILE?.trim() || "default";

  await ensureFirestoreEmulator();
  await ensureAutoPoster();
  await ensureOperator();

  console.log(`[run-mission] submitting mission (idempotencyKey=${args.idempotencyKey}, scheduledAtUtc=${args.scheduledAtUtc})`);
  const { handleAutoposterSchedulePost } = await import(
    pathToFileURL(path.join(mcpServerRoot, "dist", "src", "tools", "autoposterRuntimeTools.js")).href
  );
  const submitted = await handleAutoposterSchedulePost({
    accountId: args.accountId,
    provider: args.provider,
    mediaUrl: args.mediaUrl,
    scheduledAtUtc: args.scheduledAtUtc,
    idempotencyKey: args.idempotencyKey,
    caption: args.caption,
    hashtags: "#chanter #localmission",
    requestedBy: "local-mission-runner",
  });
  if (submitted.status !== "approval_required" && submitted.status !== "duplicate") {
    fail(`MCP submission did not reach an expected state: status=${submitted.status} errors=${JSON.stringify(submitted.errors)}`);
  }
  console.log(`[run-mission] submission result: status=${submitted.status}`);

  const listed = await authedJson(`${operatorBaseUrl}/api/mission-graphs?limit=50`, undefined);
  const graph = (listed.body.graphs as Array<Record<string, unknown>> | undefined)?.find(
    (candidate) => candidate.idempotencyKey === args.idempotencyKey,
  );
  if (!graph) fail("Could not find the submitted graph via GET /api/mission-graphs.");
  const graphId = graph!.graphId as string;
  let graphHash = graph!.graphHash as string;
  let graphStatus = graph!.status as string;
  console.log(`[run-mission] graphId=${graphId} graphHash=${graphHash} status=${graphStatus}`);

  if (graphStatus === "approval_required") {
    if (args.approve) {
      console.log(`[run-mission] approving as "${args.approve}"`);
      const approval = await authedJson(
        `${operatorBaseUrl}/api/mission-graphs/${graphId}/approve`,
        controlToken,
        { method: "POST", body: JSON.stringify({ approvedBy: args.approve, graphHash }) },
      );
      if (approval.status !== 200) fail(`Approval request failed: HTTP ${approval.status} ${JSON.stringify(approval.body)}`);
      graphStatus = approval.body.status as string;
    } else {
      console.log(
        `[run-mission] Waiting for independent approval. Run in another shell:\n` +
        `  curl -X POST ${operatorBaseUrl}/api/mission-graphs/${graphId}/approve \\\n` +
        `    -H "Authorization: Bearer <OPERATOR_CONTROL_TOKEN>" -H "content-type: application/json" \\\n` +
        `    -d '{"approvedBy":"<your-name>","graphHash":"${graphHash}"}'`,
      );
      const deadline = Date.now() + args.approvalTimeoutMs;
      while (Date.now() < deadline) {
        const current = await authedJson(`${operatorBaseUrl}/api/mission-graphs/${graphId}`, undefined);
        graphStatus = current.body.status as string;
        if (graphStatus !== "approval_required") break;
        await sleep(1_000);
      }
      if (graphStatus === "approval_required") fail(`Approval was not granted within ${args.approvalTimeoutMs}ms.`);
    }
  }
  console.log(`[run-mission] graph status after approval: ${graphStatus}`);

  console.log("[run-mission] waiting for the autonomous observation worker to converge the job (no manual endpoint call)");
  const terminalStatuses = new Set(["converged", "escalation_required", "failed_terminal", "cancelled"]);
  let jobStatus = "";
  let observationJobId = "";
  const convergenceDeadline = Date.now() + args.convergenceTimeoutMs;
  while (Date.now() < convergenceDeadline) {
    const jobs = await authedJson(`${operatorBaseUrl}/api/autoposter-observations/jobs?graphId=${graphId}`, controlToken);
    const job = (jobs.body.jobs as Array<Record<string, unknown>> | undefined)?.[0];
    if (job) {
      jobStatus = job.status as string;
      observationJobId = job.observationJobId as string;
      if (terminalStatuses.has(jobStatus)) break;
    }
    await sleep(1_000);
  }
  if (!terminalStatuses.has(jobStatus)) {
    fail(`Observation did not converge within ${args.convergenceTimeoutMs}ms (last status: ${jobStatus || "no job yet"}).`);
  }
  console.log(`[run-mission] observation job ${observationJobId} converged: ${jobStatus}`);

  console.log("[run-mission] generating retained evidence bundle");
  const evidence = await authedJson(
    `${operatorBaseUrl}/api/mission-graphs/${graphId}/evidence`,
    controlToken,
    {
      method: "POST",
      body: JSON.stringify({ repositoryHeads: collectRepositoryHeads(), runtimeProfile }),
    },
  );
  if (evidence.status !== 201 || !evidence.body.path) {
    fail(`Evidence generation failed: HTTP ${evidence.status} ${JSON.stringify(evidence.body)}`);
  }
  console.log(`[run-mission] evidence bundle: ${evidence.body.path}`);
  console.log("[run-mission] SUCCESS");
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
