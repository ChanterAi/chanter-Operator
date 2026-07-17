import {
  AUTOPOSTER_ACTIONS,
  createAutoPosterHttpPort,
  createAutoPosterMissionAdapter,
  createInMemoryIdempotencyStore,
  createRuntimeMissionPayloadHash,
  createMissionAdapterRegistry,
  executeMission,
  type AutoPosterConnectedAccountListSuccess,
  type AutoPosterConnectedAccountValidationSuccess,
  type AutoPosterOperationsPort,
  type AutoPosterPortFailure,
  type AutoPosterPostStatusSuccess,
  type AutoPosterScheduleReconciliationSuccess,
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
    workspaceId?: string;
    accountId: string;
    provider: "tiktok" | "youtube";
  }): Promise<AutoPosterConnectedAccountValidationSuccess | AutoPosterPortFailure>;
  /**
   * Phase 2E-B bounded read of one exact AutoPoster queue job through the
   * strict Runtime status contract. One request, one port timeout, no retry,
   * no provider call, no AutoPoster write; identity bytes pass through
   * unchanged and every failure propagates typed.
   */
  getPostStatus(input: {
    postId: string;
    workspaceId?: string;
    accountId?: string;
  }): Promise<AutoPosterPostStatusSuccess | AutoPosterPortFailure>;
  execute(request: RuntimeMissionRequest): Promise<RuntimeMissionResult>;
  reconcileSchedule(
    request: RuntimeMissionRequest,
  ): Promise<AutoPosterScheduleReconciliationSuccess | AutoPosterPortFailure>;
  executeRecovered(
    request: RuntimeMissionRequest,
    reconciliation: AutoPosterScheduleReconciliationSuccess,
  ): Promise<RuntimeMissionResult>;
}

interface AutoPosterRuntimeDependencies {
  port?: AutoPosterOperationsPort;
  idempotencyStore?: RuntimeMissionIdempotencyStore;
  failureInjector?: (
    boundary:
      | "after_runtime_receives_queue_id_before_result_persistence"
      | "after_runtime_result_persistence",
    request: RuntimeMissionRequest,
    result?: RuntimeMissionResult,
  ) => void;
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
    reconcileSchedule: unavailable,
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

  const reconciliationParams = (request: RuntimeMissionRequest) => ({
    userId,
    workspaceId: request.tenant.workspaceId ?? "",
    accountId: request.tenant.accountId ?? "",
    provider: request.input.provider as "tiktok" | "youtube",
    scheduledAt: String(request.input.scheduledAt ?? ""),
    idempotencyKey: request.idempotencyKey ?? "",
    missionId: request.missionId,
    action: AUTOPOSTER_ACTIONS.postSchedule,
    missionPayloadHash: createRuntimeMissionPayloadHash(request),
    traceId: request.traceId?.trim() || request.missionId,
  });

  return {
    configured,
    tenantUserId: userId || "operator-runtime-unconfigured",
    listConnectedAccounts: (workspaceId) =>
      port.listConnectedAccounts
        ? port.listConnectedAccounts({ userId, workspaceId })
        : Promise.resolve(unavailableResult()),
    validateConnectedAccount: ({ workspaceId, accountId, provider }) =>
      port.validateConnectedAccount
        ? port.validateConnectedAccount({
            userId,
            ...(workspaceId ? { workspaceId } : {}),
            accountId,
            provider,
          })
        : Promise.resolve(unavailableResult()),
    getPostStatus: ({ postId, workspaceId, accountId }) =>
      port.getPostStatus({
        userId,
        ...(workspaceId ? { workspaceId } : {}),
        postId,
        ...(accountId ? { accountId } : {}),
      }),
    execute: (request) => executeMission(request, {
      registry,
      idempotencyStore,
      failureInjector: dependencies.failureInjector,
    }),
    reconcileSchedule: (request) =>
      port.reconcileSchedule
        ? port.reconcileSchedule(reconciliationParams(request))
        : Promise.resolve(unavailableResult()),
    executeRecovered: (request, reconciliation) => {
      const recoveredPost = reconciliation.post;
      if (
        reconciliation.outcome !== "unique" ||
        !reconciliation.safeToReuse ||
        !recoveredPost
      ) {
        throw new Error("Recovered execution requires one authoritative queue result.");
      }
      const recoveredPort: AutoPosterOperationsPort = {
        ...port,
        schedulePost: async () => ({
          ok: true,
          duplicate: true,
          post: recoveredPost,
        }),
      };
      const recoveredRegistry = createMissionAdapterRegistry([
        createAutoPosterMissionAdapter(recoveredPort),
      ]);
      return executeMission(request, {
        registry: recoveredRegistry,
        idempotencyStore: createInMemoryIdempotencyStore(),
        failureInjector: dependencies.failureInjector,
      });
    },
  };
}
