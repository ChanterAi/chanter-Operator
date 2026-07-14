import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(sourceDirectory, "../../..");

const autoPosterRuntimeTimeoutRaw = process.env.AUTOPOSTER_RUNTIME_TIMEOUT_MS?.trim() ?? "";
const autoPosterRuntimeTimeoutParsed = Number(autoPosterRuntimeTimeoutRaw);
const autoPosterRuntimeTimeoutValid =
  !autoPosterRuntimeTimeoutRaw ||
  (Number.isInteger(autoPosterRuntimeTimeoutParsed) &&
    autoPosterRuntimeTimeoutParsed >= 100 &&
    autoPosterRuntimeTimeoutParsed <= 120_000);

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
};
