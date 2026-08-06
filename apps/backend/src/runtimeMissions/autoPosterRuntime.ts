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
  type AutoPosterProviderReconciliationSuccess,
  type AutoPosterScheduleReconciliationSuccess,
  type ExecuteMissionOptions,
  type RuntimeMissionApprovalAuthorityInput,
  type RuntimeMissionIdempotencyStore,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type TemporalClock,
} from "chanter-agent-runtime";
import {
  createOperatorPersistedApprovalAuthority,
  describePersistedApprovalAuthority,
  downstreamOperationTypeFor,
  mirrorPersistedApprovalAuthority,
  missionScopedStateDir,
  prepareApprovedRuntimeAuthority,
  retireUnresolvedRuntimeClaim,
  UNCONFIGURED_APPROVAL_AUTHORITY_PROJECTION,
  type OperatorClaimRetirementOutcome,
  type OperatorApprovalAuthorityConfiguration,
  type OperatorApprovalAuthorityProjection,
  type OperatorApprovalAuthorityOutcome,
  type OperatorApprovalDecision,
  type OperatorPersistedApprovalAuthority,
} from "./persistedApprovalAuthority.js";

export interface AutoPosterRuntimeConfiguration {
  baseUrl: string;
  serviceToken: string;
  userId: string;
  timeoutMs?: number;
  timeoutValid: boolean;
  /**
   * Persisted approval checkpoint authority binding. Without it, every
   * approval-required AutoPoster mission fails closed inside the Runtime with
   * `RUNTIME_APPROVAL_PERSISTED_AUTHORITY_REQUIRED`; Operator never downgrades
   * to a transient approval.
   */
  approvalAuthority?: OperatorApprovalAuthorityConfiguration;
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
  reconcileProviderOperation?(input: {
    postId: string;
    workspaceId?: string;
    accountId: string;
  }): Promise<AutoPosterProviderReconciliationSuccess | AutoPosterPortFailure>;
  /** True only when a persisted approval checkpoint binding is configured. */
  readonly approvalAuthorityConfigured: boolean;
  /**
   * Publishes the immutable checkpoint (through the Runtime itself) and the
   * durably recorded human decision, then returns the exact resume authority.
   */
  prepareApproval(
    request: RuntimeMissionRequest,
    decision: OperatorApprovalDecision,
  ): Promise<OperatorApprovalAuthorityOutcome>;
  /**
   * Read-only projection of the persisted approval authority bound to one
   * mission, for the unified CHANTER OS authority view. Grants nothing and
   * decides nothing; it only reports durable truth.
   */
  describeApprovalAuthority(missionId: string): OperatorApprovalAuthorityProjection;
  /**
   * Retires an unresolved durable claim after the caller's own reconciliation
   * proved the downstream produced nothing. Never invoked speculatively.
   */
  retireUnresolvedClaim(missionId: string): OperatorClaimRetirementOutcome;
  /**
   * Carries the exact same immutable authority records into the no-side-effect
   * recovered execution scope. No approval decision is re-made.
   */
  prepareRecoveredApproval(
    request: RuntimeMissionRequest,
  ): Promise<OperatorApprovalAuthorityOutcome>;
  execute(
    request: RuntimeMissionRequest,
    authority?: RuntimeMissionApprovalAuthorityInput,
  ): Promise<RuntimeMissionResult>;
  reconcileSchedule(
    request: RuntimeMissionRequest,
  ): Promise<AutoPosterScheduleReconciliationSuccess | AutoPosterPortFailure>;
  executeRecovered(
    request: RuntimeMissionRequest,
    reconciliation: AutoPosterScheduleReconciliationSuccess,
    authority?: RuntimeMissionApprovalAuthorityInput,
  ): Promise<RuntimeMissionResult>;
}

interface AutoPosterRuntimeDependencies {
  port?: AutoPosterOperationsPort;
  idempotencyStore?: RuntimeMissionIdempotencyStore;
  /** Injected only for the Runtime's approval-expiry decision. */
  clock?: TemporalClock;
  /**
   * Taken straight from the Runtime so the injectable boundary set stays in
   * lockstep with it, including the approval-authority boundaries.
   */
  failureInjector?: NonNullable<ExecuteMissionOptions["failureInjector"]>;
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

/**
 * No binding, no authority. The refusal is returned rather than thrown so the
 * calling service records a truthful failure and the Runtime is never asked to
 * execute an approval-required mission without persisted authority.
 */
function unconfiguredApproval(): OperatorApprovalAuthorityOutcome {
  return {
    ok: false,
    code: "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
    message:
      "Persisted approval checkpoint authority is not configured, so no approval can authorize execution.",
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
    reconcileProviderOperation: unavailable,
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
  const approvalAuthority = configuration.approvalAuthority
    ? createOperatorPersistedApprovalAuthority(configuration.approvalAuthority)
    : null;
  /**
   * Persisted approval authority owns the durable store when it is configured:
   * the Runtime refuses an approval-required mission unless the same store
   * carries the checkpoint, the observation, and the exclusive claim.
   */
  const idempotencyStore = approvalAuthority?.idempotencyStore
    ?? dependencies.idempotencyStore
    ?? createInMemoryIdempotencyStore();
  const clockOption = dependencies.clock ? { clock: dependencies.clock } : {};

  /**
   * The recovered execution re-materializes an already-observed downstream
   * result through a port that performs no side effect. It keeps its own
   * durable claim scope so a crashed first attempt's claim cannot block it —
   * exactly the isolation the pre-migration in-memory store gave it — while
   * every approval decision still runs through the full persisted authority
   * chain and the Runtime's authoritative pre-adapter guard.
   */
  const recoveredAuthorities = new Map<string, OperatorPersistedApprovalAuthority>();
  const recoveredAuthorityFor = (missionId: string): OperatorPersistedApprovalAuthority | null => {
    if (!configuration.approvalAuthority) return null;
    const existing = recoveredAuthorities.get(missionId);
    if (existing) return existing;
    const created = createOperatorPersistedApprovalAuthority({
      ...configuration.approvalAuthority,
      stateDir: missionScopedStateDir(
        configuration.approvalAuthority.stateDir,
        "recovered-missions",
        missionId,
      ),
    });
    recoveredAuthorities.set(missionId, created);
    return created;
  };

  const recoveredRegistryFor = (
    reconciliation: AutoPosterScheduleReconciliationSuccess,
  ): ReturnType<typeof createMissionAdapterRegistry> => {
    const recoveredPost = reconciliation.post;
    if (
      reconciliation.outcome !== "unique"
      || !reconciliation.safeToReuse
      || !recoveredPost
    ) {
      throw new Error("Recovered execution requires one authoritative queue result.");
    }
    const recoveredPort: AutoPosterOperationsPort = {
      ...port,
      schedulePost: async () => ({ ok: true, duplicate: true, post: recoveredPost }),
    };
    return createMissionAdapterRegistry([createAutoPosterMissionAdapter(recoveredPort)]);
  };

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
    reconcileProviderOperation: ({ postId, workspaceId, accountId }) =>
      port.reconcileProviderOperation
        ? port.reconcileProviderOperation({
            userId,
            ...(workspaceId ? { workspaceId } : {}),
            postId,
            accountId,
          })
        : Promise.resolve(unavailableResult()),
    approvalAuthorityConfigured: approvalAuthority !== null,
    prepareApproval: (request, decision) => {
      if (!approvalAuthority) return Promise.resolve(unconfiguredApproval());
      return prepareApprovedRuntimeAuthority(
        approvalAuthority,
        request,
        downstreamOperationTypeFor(registry, request),
        decision,
        (checkpointAuthority) => executeMission(request, {
          registry,
          idempotencyStore: approvalAuthority.idempotencyStore,
          runLedger: approvalAuthority.runLedger,
          ...(approvalAuthority.trustStore ? { approvalTrustStore: approvalAuthority.trustStore } : {}),
          approvalAuthority: checkpointAuthority,
          ...clockOption,
        }),
      );
    },
    describeApprovalAuthority: (missionId) => (
      approvalAuthority
        ? describePersistedApprovalAuthority(approvalAuthority, missionId)
        : UNCONFIGURED_APPROVAL_AUTHORITY_PROJECTION
    ),
    retireUnresolvedClaim: (missionId) => (
      approvalAuthority ? retireUnresolvedRuntimeClaim(approvalAuthority, missionId) : "unsupported"
    ),
    prepareRecoveredApproval: (request) => {
      const recovered = recoveredAuthorityFor(request.missionId);
      if (!approvalAuthority || !recovered) return Promise.resolve(unconfiguredApproval());
      return Promise.resolve(mirrorPersistedApprovalAuthority(
        approvalAuthority,
        recovered,
        request,
        downstreamOperationTypeFor(registry, request),
      ));
    },
    execute: (request, authority) => executeMission(request, {
      registry,
      idempotencyStore,
      ...(approvalAuthority ? { runLedger: approvalAuthority.runLedger } : {}),
      ...(approvalAuthority?.trustStore ? { approvalTrustStore: approvalAuthority.trustStore } : {}),
      ...(authority ? { approvalAuthority: authority } : {}),
      ...clockOption,
      failureInjector: dependencies.failureInjector,
    }),
    reconcileSchedule: (request) =>
      port.reconcileSchedule
        ? port.reconcileSchedule(reconciliationParams(request))
        : Promise.resolve(unavailableResult()),
    executeRecovered: (request, reconciliation, authority) => {
      const recoveredRegistry = recoveredRegistryFor(reconciliation);
      const recovered = recoveredAuthorityFor(request.missionId);
      return executeMission(request, {
        registry: recoveredRegistry,
        idempotencyStore: recovered?.idempotencyStore ?? createInMemoryIdempotencyStore(),
        ...(recovered ? { runLedger: recovered.runLedger } : {}),
        ...(recovered?.trustStore ? { approvalTrustStore: recovered.trustStore } : {}),
        ...(authority ? { approvalAuthority: authority } : {}),
        ...clockOption,
        failureInjector: dependencies.failureInjector,
      });
    },
  };
}
