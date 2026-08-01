/**
 * Phase 2C Loop Governor runtime executor for the generic mission spine.
 *
 * Mirrors the accepted AutoPoster pattern (autoPosterRuntime.ts): Operator
 * wires the canonical chanter-agent-runtime adapter + process port from
 * configuration, and the GenericMissionService only ever talks to this
 * bounded executor interface. When unconfigured, every call fails closed as
 * `unavailable` — submission stays durable, execution stays recoverable.
 */
import { isAbsolute } from "node:path";
import {
  createInMemoryIdempotencyStore,
  createLoopGovernorMissionAdapter,
  createLoopGovernorProcessPort,
  createMissionAdapterRegistry,
  createRuntimeMissionPayloadHash,
  executeMission,
  type LoopGovernorManualLoopLookupSuccess,
  type LoopGovernorMissionPort,
  type LoopGovernorPortFailure,
  type RuntimeMissionApprovalAuthorityInput,
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
  type TemporalClock,
} from "chanter-agent-runtime";
import {
  createOperatorPersistedApprovalAuthority,
  downstreamOperationTypeFor,
  prepareApprovedRuntimeAuthority,
  retireUnresolvedRuntimeClaim,
  type OperatorApprovalAuthorityConfiguration,
  type OperatorClaimRetirementOutcome,
  type OperatorApprovalAuthorityOutcome,
  type OperatorApprovalDecision,
} from "../runtimeMissions/persistedApprovalAuthority.js";

export interface LoopGovernorRuntimeConfiguration {
  pythonExecutable: string;
  governorRoot: string;
  dataDir: string;
  timeoutMs?: number;
  timeoutValid: boolean;
  /**
   * Persisted approval checkpoint authority binding. Without it every
   * approval-required manual-loop mission fails closed inside the Runtime with
   * `RUNTIME_APPROVAL_PERSISTED_AUTHORITY_REQUIRED`.
   */
  approvalAuthority?: OperatorApprovalAuthorityConfiguration;
}

export interface LoopGovernorMissionExecutor {
  readonly configured: boolean;
  readonly approvalAuthorityConfigured: boolean;
  prepareApproval(
    request: RuntimeMissionRequest,
    decision: OperatorApprovalDecision,
  ): Promise<OperatorApprovalAuthorityOutcome>;
  /**
   * Retires an unresolved durable claim after the caller's own reconciliation
   * proved the downstream produced nothing. Never invoked speculatively.
   */
  retireUnresolvedClaim(missionId: string): OperatorClaimRetirementOutcome;
  execute(
    request: RuntimeMissionRequest,
    authority?: RuntimeMissionApprovalAuthorityInput,
  ): Promise<RuntimeMissionResult>;
  lookup(
    request: RuntimeMissionRequest,
  ): Promise<LoopGovernorManualLoopLookupSuccess | LoopGovernorPortFailure>;
}

interface LoopGovernorRuntimeDependencies {
  port?: LoopGovernorMissionPort;
  /** Injected only for the Runtime's approval-expiry decision. */
  clock?: TemporalClock;
}

function unavailableFailure(): LoopGovernorPortFailure {
  return {
    ok: false,
    code: "unavailable",
    message: "Loop Governor runtime mission capability is not configured.",
  };
}

function createUnavailablePort(): LoopGovernorMissionPort {
  return {
    createManualLoop: async () => unavailableFailure(),
    lookupManualLoop: async () => unavailableFailure(),
  };
}

export function createLoopGovernorMissionExecutor(
  configuration: LoopGovernorRuntimeConfiguration,
  dependencies: LoopGovernorRuntimeDependencies = {},
): LoopGovernorMissionExecutor {
  const pythonExecutable = configuration.pythonExecutable.trim();
  const governorRoot = configuration.governorRoot.trim();
  const dataDir = configuration.dataDir.trim();
  const configured = Boolean(
    dependencies.port
    || (
      pythonExecutable
      && governorRoot
      && isAbsolute(pythonExecutable)
      && isAbsolute(governorRoot)
      && (!dataDir || isAbsolute(dataDir))
      && configuration.timeoutValid
    ),
  );

  const port = configured
    ? dependencies.port
      ?? createLoopGovernorProcessPort({
        pythonExecutable,
        governorRoot,
        ...(dataDir ? { dataDir } : {}),
        ...(configuration.timeoutMs !== undefined
          ? { timeoutMs: configuration.timeoutMs }
          : {}),
      })
    : createUnavailablePort();

  const registry = createMissionAdapterRegistry([
    createLoopGovernorMissionAdapter(port),
  ]);
  const approvalAuthority = configuration.approvalAuthority
    ? createOperatorPersistedApprovalAuthority(configuration.approvalAuthority)
    : null;
  // The Runtime refuses an approval-required mission unless the same durable
  // store carries the checkpoint, the observation, and the exclusive claim.
  const idempotencyStore = approvalAuthority?.idempotencyStore ?? createInMemoryIdempotencyStore();
  const clockOption = dependencies.clock ? { clock: dependencies.clock } : {};

  return {
    configured,
    approvalAuthorityConfigured: approvalAuthority !== null,
    prepareApproval: (request, decision) => {
      if (!approvalAuthority) {
        return Promise.resolve({
          ok: false as const,
          code: "OPERATOR_APPROVAL_AUTHORITY_NOT_CONFIGURED",
          message:
            "Persisted approval checkpoint authority is not configured, so no approval can authorize execution.",
        });
      }
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
    retireUnresolvedClaim: (missionId) => (
      approvalAuthority ? retireUnresolvedRuntimeClaim(approvalAuthority, missionId) : "unsupported"
    ),
    execute: (request, authority) => executeMission(request, {
      registry,
      idempotencyStore,
      ...(approvalAuthority ? { runLedger: approvalAuthority.runLedger } : {}),
      ...(approvalAuthority?.trustStore ? { approvalTrustStore: approvalAuthority.trustStore } : {}),
      ...(authority ? { approvalAuthority: authority } : {}),
      ...clockOption,
    }),
    lookup: (request) =>
      port.lookupManualLoop({
        missionId: request.missionId,
        payloadHash: createRuntimeMissionPayloadHash(request),
      }),
  };
}
