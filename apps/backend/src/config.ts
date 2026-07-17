import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDirectory, "../../..");
const projectEnvironmentPath = path.join(projectRoot, ".env");

// The documented local workflow keeps one uncommitted .env at the repository
// root. Node does not load it implicitly, so load it before reading config while
// preserving any values explicitly exported by the invoking shell.
if (existsSync(projectEnvironmentPath)) {
  process.loadEnvFile(projectEnvironmentPath);
}

const autoPosterRuntimeTimeoutRaw = process.env.AUTOPOSTER_RUNTIME_TIMEOUT_MS?.trim() ?? "";
const autoPosterRuntimeTimeoutParsed = Number(autoPosterRuntimeTimeoutRaw);
const autoPosterRuntimeTimeoutValid =
  !autoPosterRuntimeTimeoutRaw ||
  (Number.isInteger(autoPosterRuntimeTimeoutParsed) &&
    autoPosterRuntimeTimeoutParsed >= 100 &&
    autoPosterRuntimeTimeoutParsed <= 120_000);

/**
 * Phase 2E-C observation policy overrides. Every override must parse to an
 * integer inside the reviewed closed bounds or it is ignored (the reviewed
 * P0 defaults apply); the observation service re-validates the effective
 * policy and refuses to start on any out-of-bounds combination.
 */
function parseBoundedInteger(raw: string | undefined, minimum: number, maximum: number): number | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : undefined;
}

function parseObservationDelays(raw: string | undefined): number[] | undefined {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return undefined;
  const delays = trimmed.split(",").map((value) => Number(value.trim()));
  const valid =
    delays.length >= 1 &&
    delays.length <= 8 &&
    delays.every((delay) => Number.isInteger(delay) && delay >= 1 && delay <= 600);
  return valid ? delays : undefined;
}

const observationDelays = parseObservationDelays(process.env.OPERATOR_OBSERVATION_RETRY_DELAYS_SECONDS);
const observationMaxAttempts = parseBoundedInteger(process.env.OPERATOR_OBSERVATION_MAX_ATTEMPTS, 1, 12);
const observationLeaseSeconds = parseBoundedInteger(process.env.OPERATOR_OBSERVATION_LEASE_SECONDS, 5, 600);
const observationBatchSize = parseBoundedInteger(process.env.OPERATOR_OBSERVATION_BATCH_SIZE, 1, 16);

const loopGovernorTimeoutRaw = process.env.LOOP_GOVERNOR_TIMEOUT_MS?.trim() ?? "";
const loopGovernorTimeoutParsed = Number(loopGovernorTimeoutRaw);
const loopGovernorTimeoutValid =
  !loopGovernorTimeoutRaw ||
  (Number.isInteger(loopGovernorTimeoutParsed) &&
    loopGovernorTimeoutParsed >= 1_000 &&
    loopGovernorTimeoutParsed <= 120_000);

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.OPERATOR_PORT ?? 3001),
  databasePath:
    process.env.OPERATOR_DATABASE_PATH ?? path.join(projectRoot, "data", "operator.sqlite"),
  auditPath: process.env.OPERATOR_AUDIT_PATH ?? path.join(projectRoot, "data", "audit.jsonl"),
  workspaceRoot:
    process.env.OPERATOR_WORKSPACE_ROOT ?? path.join(projectRoot, "workspace"),
  /** P1.0: Workspace where the real read-only runner executes commands (e.g. the git repo root). */
  runnerWorkspaceRoot:
    process.env.OPERATOR_RUNNER_WORKSPACE ?? undefined,
  autoPosterRuntime: {
    baseUrl: process.env.AUTOPOSTER_BASE_URL?.trim() ?? "",
    serviceToken: process.env.AUTOPOSTER_RUNTIME_TOKEN?.trim() ?? "",
    userId: process.env.OPERATOR_RUNTIME_USER_ID?.trim() ?? "",
    timeoutMs:
      autoPosterRuntimeTimeoutRaw && autoPosterRuntimeTimeoutValid
        ? autoPosterRuntimeTimeoutParsed
        : undefined,
    timeoutValid: autoPosterRuntimeTimeoutValid,
  },
  loopGovernorRuntime: {
    pythonExecutable: process.env.LOOP_GOVERNOR_PYTHON?.trim() ?? "",
    governorRoot: process.env.LOOP_GOVERNOR_ROOT?.trim() ?? "",
    dataDir: process.env.LOOP_GOVERNOR_MISSION_DATA_DIR?.trim() ?? "",
    timeoutMs:
      loopGovernorTimeoutRaw && loopGovernorTimeoutValid
        ? loopGovernorTimeoutParsed
        : undefined,
    timeoutValid: loopGovernorTimeoutValid,
  },
  autoPosterObservation: {
    ...(observationDelays !== undefined ? { retryDelaysSeconds: observationDelays } : {}),
    ...(observationMaxAttempts !== undefined ? { maxAttempts: observationMaxAttempts } : {}),
    ...(observationLeaseSeconds !== undefined ? { leaseSeconds: observationLeaseSeconds } : {}),
    ...(observationBatchSize !== undefined ? { batchSize: observationBatchSize } : {}),
  },
  missionSubmit: {
    token: process.env.OPERATOR_MISSION_SUBMIT_TOKEN?.trim() ?? "",
  },
  missionControl: {
    token: process.env.OPERATOR_CONTROL_TOKEN?.trim() ?? "",
  },
  safeCommitExecutor: {
    token: process.env.OPERATOR_SAFECOMMIT_EXECUTOR_TOKEN?.trim() ?? "",
  },
  ledgerIngest: {
    token: process.env.OPERATOR_LEDGER_INGEST_TOKEN?.trim() ?? "",
  },
};
