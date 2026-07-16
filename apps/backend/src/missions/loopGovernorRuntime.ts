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
  type RuntimeMissionRequest,
  type RuntimeMissionResult,
} from "chanter-agent-runtime";

export interface LoopGovernorRuntimeConfiguration {
  pythonExecutable: string;
  governorRoot: string;
  dataDir: string;
  timeoutMs?: number;
  timeoutValid: boolean;
}

export interface LoopGovernorMissionExecutor {
  readonly configured: boolean;
  execute(request: RuntimeMissionRequest): Promise<RuntimeMissionResult>;
  lookup(
    request: RuntimeMissionRequest,
  ): Promise<LoopGovernorManualLoopLookupSuccess | LoopGovernorPortFailure>;
}

interface LoopGovernorRuntimeDependencies {
  port?: LoopGovernorMissionPort;
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
  const idempotencyStore = createInMemoryIdempotencyStore();

  return {
    configured,
    execute: (request) => executeMission(request, { registry, idempotencyStore }),
    lookup: (request) =>
      port.lookupManualLoop({
        missionId: request.missionId,
        payloadHash: createRuntimeMissionPayloadHash(request),
      }),
  };
}
