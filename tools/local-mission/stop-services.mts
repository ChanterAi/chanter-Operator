#!/usr/bin/env node
// Cleanly stops one or more of the detached local-mission services started by
// run-mission.mts, using the PID files it records. Used explicitly for the
// restart proof's "stop Operator cleanly" step (and available for the other
// two services too) — restart itself is just running run-mission.mts again,
// which reconnects to whatever is still up and re-spawns whatever isn't.
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const pidDir = path.join(operatorRoot, "var", "local-mission", "pids");

const KNOWN_SERVICES = ["operator", "autoposter", "firestore-emulator"] as const;

function parseArgs(argv: string[]): string[] {
  const requested = argv.filter((token) => !token.startsWith("--"));
  return requested.length > 0 ? requested : [...KNOWN_SERVICES];
}

function stopOne(service: string): void {
  const pidFile = path.join(pidDir, `${service}.pid`);
  if (!existsSync(pidFile)) {
    console.log(`[stop-services] no pid file for "${service}" — nothing to stop.`);
    return;
  }
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    console.log(`[stop-services] pid file for "${service}" is invalid; removing it.`);
    rmSync(pidFile, { force: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    console.log(`[stop-services] sent SIGTERM to "${service}" (pid ${pid}).`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      console.log(`[stop-services] "${service}" (pid ${pid}) was not running.`);
    } else {
      console.error(`[stop-services] failed to signal "${service}" (pid ${pid}): ${(error as Error).message}`);
    }
  }
  rmSync(pidFile, { force: true });
}

function main(): void {
  const services = parseArgs(process.argv.slice(2));
  for (const service of services) {
    if (!(KNOWN_SERVICES as readonly string[]).includes(service)) {
      console.error(`[stop-services] unknown service "${service}"; expected one of ${KNOWN_SERVICES.join(", ")}.`);
      process.exitCode = 1;
      continue;
    }
    stopOne(service);
  }
}

main();
