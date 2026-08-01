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

/**
 * Phase 2F-B autonomous observation worker. Disabled by default (including
 * in every test run, since nothing sets this env var) — enabling it is an
 * explicit opt-in. Out-of-bounds overrides are ignored in favor of the safe
 * default, exactly like the observation policy overrides above; the worker
 * itself re-validates and refuses to start on any invalid combination.
 */
const observationWorkerEnabledRaw = (process.env.OPERATOR_OBSERVATION_WORKER_ENABLED ?? "").trim().toLowerCase();
const observationWorkerEnabled = observationWorkerEnabledRaw === "true" || observationWorkerEnabledRaw === "1";
const observationWorkerPollIntervalMs =
  parseBoundedInteger(process.env.OPERATOR_OBSERVATION_WORKER_POLL_INTERVAL_MS, 1_000, 3_600_000) ?? 30_000;
const observationWorkerBatchSize = parseBoundedInteger(process.env.OPERATOR_OBSERVATION_WORKER_BATCH_SIZE, 1, 16);

const loopGovernorTimeoutRaw = process.env.LOOP_GOVERNOR_TIMEOUT_MS?.trim() ?? "";
const loopGovernorTimeoutParsed = Number(loopGovernorTimeoutRaw);
const loopGovernorTimeoutValid =
  !loopGovernorTimeoutRaw ||
  (Number.isInteger(loopGovernorTimeoutParsed) &&
    loopGovernorTimeoutParsed >= 1_000 &&
    loopGovernorTimeoutParsed <= 120_000);

/**
 * Persisted approval checkpoint authority binding.
 *
 * Two mutually exclusive repository binding modes:
 *
 *  - **Managed (deployable).** `_SOURCE_REPOSITORY` names the live product
 *    repository and `_CHECKOUT_ROOT` a durable cache. Operator derives an
 *    isolated per-revision checkout containing only tracked content, so the
 *    ordinary `node_modules/`, `dist/`, `.env`, and log files in a working
 *    checkout never reach the Runtime's canonical clean-state decision.
 *
 *  - **Direct (explicit).** `_REPOSITORY_ROOT` binds one path that is already
 *    clean under that policy. It is retained for controlled fixtures; pointing
 *    it at a live product checkout keeps approvals permanently fail-closed,
 *    which is exactly the deployment blocker managed mode removes.
 *
 * Configuring both is a configuration error, not a precedence rule: two
 * answers to "which repository does this approval bind to" is the ambiguity
 * this contract must not have. Configuring neither, or an incomplete managed
 * pair, leaves approval-required execution fail-closed — Operator never falls
 * back to a transient approval.
 */
const approvalAuthorityStateDir = process.env.OPERATOR_APPROVAL_AUTHORITY_STATE_DIR?.trim() ?? "";
const approvalAuthorityRepositoryRoot =
  process.env.OPERATOR_APPROVAL_AUTHORITY_REPOSITORY_ROOT?.trim() ?? "";
const approvalAuthoritySourceRepository =
  process.env.OPERATOR_APPROVAL_AUTHORITY_SOURCE_REPOSITORY?.trim() ?? "";
const approvalAuthorityCheckoutRoot =
  process.env.OPERATOR_APPROVAL_AUTHORITY_CHECKOUT_ROOT?.trim() ?? "";

/**
 * Approval issuer authenticity. Operator signs; the Runtime verifies against an
 * explicitly configured trust file. All four values are required together —
 * a signing identity with nobody trusting it, or a trust file with nothing to
 * sign, leaves approval-required execution fail-closed.
 */
const approvalIssuerAuthorityId =
  process.env.OPERATOR_APPROVAL_AUTHORITY_ISSUER_ID?.trim() ?? "";
const approvalIssuerKeyId =
  process.env.OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_ID?.trim() ?? "";
const approvalIssuerKeyFile =
  process.env.OPERATOR_APPROVAL_AUTHORITY_SIGNING_KEY_FILE?.trim() ?? "";
const approvalTrustedIssuersFile =
  process.env.OPERATOR_APPROVAL_AUTHORITY_TRUSTED_ISSUERS_FILE?.trim() ?? "";
const approvalIssuerConfigured = Boolean(
  approvalIssuerAuthorityId
  && approvalIssuerKeyId
  && approvalIssuerKeyFile
  && approvalTrustedIssuersFile
  && path.isAbsolute(approvalIssuerKeyFile)
  && path.isAbsolute(approvalTrustedIssuersFile),
);

const managedBindingRequested = Boolean(
  approvalAuthoritySourceRepository || approvalAuthorityCheckoutRoot,
);
const managedBindingValid = Boolean(
  approvalAuthoritySourceRepository
  && approvalAuthorityCheckoutRoot
  && path.isAbsolute(approvalAuthoritySourceRepository)
  && path.isAbsolute(approvalAuthorityCheckoutRoot),
);
const directBindingValid = Boolean(
  approvalAuthorityRepositoryRoot && path.isAbsolute(approvalAuthorityRepositoryRoot),
);
const approvalAuthorityConfigured =
  Boolean(approvalAuthorityStateDir)
  && path.isAbsolute(approvalAuthorityStateDir)
  // Exactly one binding mode, fully specified.
  && (managedBindingValid ? !directBindingValid : directBindingValid && !managedBindingRequested);

export const config = {
  host: "127.0.0.1",
  port: Number(process.env.OPERATOR_PORT ?? 3001),
  databasePath:
    process.env.OPERATOR_DATABASE_PATH ?? path.join(projectRoot, "data", "operator.sqlite"),
  auditPath: process.env.OPERATOR_AUDIT_PATH ?? path.join(projectRoot, "data", "audit.jsonl"),
  workspaceRoot:
    process.env.OPERATOR_WORKSPACE_ROOT ?? path.join(projectRoot, "workspace"),
  /** Retained mission-evidence bundle root (one subdirectory per graph ID). */
  evidenceDir:
    process.env.OPERATOR_EVIDENCE_DIR ?? path.join(projectRoot, "var", "evidence"),
  /** Named operational profile label, carried into every evidence bundle. */
  runtimeProfileName: process.env.OPERATOR_RUNTIME_PROFILE?.trim() || "default",
  /** P1.0: Workspace where the real read-only runner executes commands (e.g. the git repo root). */
  runnerWorkspaceRoot:
    process.env.OPERATOR_RUNNER_WORKSPACE ?? undefined,
  /** Shared by both mission executors; `undefined` keeps approvals fail-closed. */
  approvalAuthority: approvalAuthorityConfigured
    ? {
      stateDir: approvalAuthorityStateDir,
      ...(managedBindingValid
        ? {
          managedCheckout: {
            sourceRepositoryRoot: approvalAuthoritySourceRepository,
            checkoutRoot: approvalAuthorityCheckoutRoot,
          },
        }
        : { repositoryRoot: approvalAuthorityRepositoryRoot }),
      ...(approvalIssuerConfigured
        ? {
          issuer: {
            authorityId: approvalIssuerAuthorityId,
            keyId: approvalIssuerKeyId,
            privateKeyFile: approvalIssuerKeyFile,
          },
          trustedIssuersFile: approvalTrustedIssuersFile,
        }
        : {}),
      ownerId: "chanter-operator",
      ...(process.env.OPERATOR_APPROVAL_AUTHORITY_POLICY_ID?.trim()
        ? { policyId: process.env.OPERATOR_APPROVAL_AUTHORITY_POLICY_ID.trim() }
        : {}),
    }
    : undefined,
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
  forge: {
    // SDK Forge capability registry (read-only projection into the Operator
    // Capability Workspace). Reuses the SDK token env.
    baseUrl: process.env.CHANTER_FORGE_BASE_URL?.trim() ?? "",
    token: process.env.CHANTER_SDK_TOKEN?.trim() ?? "",
  },
  demoReadiness: {
    // Platform Readiness demo presentation server (chanter-sdk-forge/demo).
    // Read-only projection + thin control proxy into the Operator Mission
    // Workspace. Defaults to the standard local demo port; the mission is
    // read-only and holds no secrets, so no token is required.
    baseUrl: process.env.CHANTER_DEMO_BASE_URL?.trim() || "http://127.0.0.1:4900",
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
  autoPosterObservationWorker: {
    enabled: observationWorkerEnabled,
    pollIntervalMs: observationWorkerPollIntervalMs,
    ...(observationWorkerBatchSize !== undefined ? { batchSize: observationWorkerBatchSize } : {}),
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
