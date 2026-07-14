import {
  createAutoPosterHttpPort,
  createAutoPosterMissionAdapter,
  createInMemoryIdempotencyStore,
  createMissionAdapterRegistry,
  executeMission,
  type AutoPosterConnectedAccountListSuccess,
  type AutoPosterConnectedAccountValidationSuccess,
  type AutoPosterOperationsPort,
  type AutoPosterPortFailure,
  type RuntimeMissionIdempotencyStore,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
} from "chanter-agent-runtime";

export interface AutoPosterRuntimeConfiguration {
  baseUrl: string;
  serviceToken: string;
  userId: string;
  timeoutMs?: number;
  timeoutValid: boolean;
}

export interface AutoPosterRuntimeMissionExecutor {
  readonly configured: boolean;
  readonly tenantUserId: string;
  listConnectedAccounts(
    workspaceId: string,
  ): Promise<AutoPosterConnectedAccountListSuccess | AutoPosterPortFailure>;
  validateConnectedAccount(input: {
    workspaceId: string;
    accountId: string;
    provider: "tiktok" | "youtube";
  }): Promise<AutoPosterConnectedAccountValidationSuccess | AutoPosterPortFailure>;
  execute(request: RuntimeMissionRequest): Promise<RuntimeMissionResult>;
}

interface AutoPosterRuntimeDependencies {
  port?: AutoPosterOperationsPort;
  idempotencyStore?: RuntimeMissionIdempotencyStore;
}

function isSafeBaseUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      !parsed.username &&
      !parsed.password &&
      !parsed.search &&
      !parsed.hash
    );
  } catch {
    return false;
  }
}

function unavailableResult(): AutoPosterPortFailure {
  return {
    ok: false as const,
    code: "unavailable" as const,
    message: "AutoPoster runtime mission capability is not configured.",
  };
}

function createUnavailablePort(): AutoPosterOperationsPort {
  const unavailable = async () => unavailableResult();

  return {
    listQueue: unavailable,
    getPostStatus: unavailable,
    validateMedia: unavailable,
    schedulePost: unavailable,
  };
}

export function createAutoPosterRuntimeMissionExecutor(
  configuration: AutoPosterRuntimeConfiguration,
  dependencies: AutoPosterRuntimeDependencies = {},
): AutoPosterRuntimeMissionExecutor {
  const baseUrl = configuration.baseUrl.trim();
  const serviceToken = configuration.serviceToken.trim();
  const userId = configuration.userId.trim();
  const timeoutValid =
    configuration.timeoutValid &&
    (configuration.timeoutMs === undefined ||
      (Number.isInteger(configuration.timeoutMs) &&
        configuration.timeoutMs >= 100 &&
        configuration.timeoutMs <= 120_000));
  const configured = Boolean(
    baseUrl &&
      serviceToken &&
      userId &&
      timeoutValid &&
      isSafeBaseUrl(baseUrl),
  );

  const port = configured
    ? dependencies.port ??
      createAutoPosterHttpPort({
          baseUrl,
          serviceToken,
          ...(configuration.timeoutMs !== undefined
            ? { timeoutMs: configuration.timeoutMs }
            : {}),
        })
    : createUnavailablePort();
  const registry = createMissionAdapterRegistry([createAutoPosterMissionAdapter(port)]);
  const idempotencyStore =
    dependencies.idempotencyStore ?? createInMemoryIdempotencyStore();

  return {
    configured,
    tenantUserId: userId || "operator-runtime-unconfigured",
    listConnectedAccounts: (workspaceId) =>
      port.listConnectedAccounts
        ? port.listConnectedAccounts({ userId, workspaceId })
        : Promise.resolve(unavailableResult()),
    validateConnectedAccount: ({ workspaceId, accountId, provider }) =>
      port.validateConnectedAccount
        ? port.validateConnectedAccount({ userId, workspaceId, accountId, provider })
        : Promise.resolve(unavailableResult()),
    execute: (request) => executeMission(request, { registry, idempotencyStore }),
  };
}
