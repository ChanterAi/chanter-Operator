/**
 * CHANTER OS — closed-world provider binding registry.
 *
 * The Operator owns *which* provider a capability is authorized to reach; the
 * Runtime owns *how* that reach is bounded, measured, and recorded. This file is
 * the Operator's half, and like the capability registry it is a reviewed code
 * change rather than data: a binding that could be added at runtime is a binding
 * a mission could add for itself, and "the submission asked for a different
 * model endpoint" is precisely the exfiltration path a closed registry removes.
 *
 * ## What a mission may and may not choose
 *
 * A mission may **select among** the bindings a capability already authorizes.
 * It may not register one, name an unregistered one, point one at a different
 * URL, widen a capability's worker kinds, or attach a model to a capability the
 * registry declares deterministic. Every one of those is a typed refusal at
 * compile time — before a plan exists, and therefore long before a worker does.
 *
 * ## Why deterministic capabilities have no bindings at all
 *
 * `evidence.verify`, `result.synthesize`, `artifact.local.write` and
 * `outcome.verify` appear nowhere below. That is the enforcement, not an
 * omission: there is no binding for a mission to select, so "force the verifier
 * onto a model" has no representable form. A verifier whose judgement is itself
 * probabilistic adds no assurance to anything.
 *
 * ## Cost honesty
 *
 * The one live binding here runs a local inference server. It is a real model
 * and reports real measured token usage — and it is also unbilled, because no
 * invoice exists for a process on this machine. It therefore declares
 * `unpriced_local_compute`, which makes a monetary ceiling *unenforceable*
 * against it by construction. That is deliberate: a fabric that reported `0`
 * here would be claiming an invoice it never received.
 */
import {
  createAgenticProviderBindingRegistry,
  OLLAMA_ADAPTER_ID,
  SIMULATED_ADAPTER_ID,
  type AgenticProviderBinding,
  type AgenticProviderBindingRegistry,
} from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import type { AgenticSimulatorScenario } from "./agenticProviderAdapters.js";

/**
 * The versioned price snapshot this deployment computes local costs from.
 *
 * Bumping it is a reviewed change, and every usage record stamped with it can be
 * re-derived from the exact rates that were in force. An unversioned price table
 * produces numbers nobody can reproduce, which is not evidence.
 */
export const AGENTIC_PRICE_SNAPSHOT_REVISION = "chanter.agentic-price-snapshot.v1" as const;

export interface AgenticProviderConfiguration {
  /**
   * Origin of the local inference server, from configuration only. Empty
   * disables every live binding — an unconfigured deployment reaches no
   * provider at all rather than guessing at a default endpoint.
   */
  readonly localModelBaseUrl: string;
  /**
   * Enables the test-mode simulator bindings. Off in any real deployment; the
   * proof runner and the contract tests turn it on deliberately.
   */
  readonly simulatorEnabled: boolean;
  /** Which reviewed simulator scenario is active. `disabled` registers none. */
  readonly simulatorScenario: AgenticSimulatorScenario;
}

export const LOCAL_JUDGMENT_BINDING_ID = "local.ollama.gemma4-e4b.judgment" as const;
export const SIMULATOR_PRIMARY_BINDING_ID = "simulator.primary" as const;
export const SIMULATOR_FALLBACK_BINDING_ID = "simulator.fallback" as const;

function bindings(configuration: AgenticProviderConfiguration): readonly AgenticProviderBinding[] {
  const liveEnabled = configuration.localModelBaseUrl.trim().length > 0;
  return [
    {
      bindingId: LOCAL_JUDGMENT_BINDING_ID,
      providerName: "ollama",
      adapterId: OLLAMA_ADAPTER_ID,
      modelId: "gemma4:e4b",
      enabled: liveEnabled,
      structuredOutputMode: "json_schema",
      maxContextTokens: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 240_000,
      pricing: {
        costMode: "unpriced_local_compute",
        pricingRevision: null,
        inputMicrosPerMillionTokens: null,
        outputMicrosPerMillionTokens: null,
        unpricedReason:
          "This binding runs a local inference process. No provider bills it, so no invoice exists to "
          + "measure; estimating electricity or hardware amortization would be a fabricated number, and "
          + "reporting zero would be a claim about a charge that was never issued.",
      },
      // One attempt. A second automatic attempt against an outcome this fabric
      // could not establish is how one inference becomes two.
      retryPolicy: { maxAttempts: 1, fallbackOnRateLimit: false },
      // Terminal fallback. There is exactly one authorized live provider in this
      // deployment, so an unavailable provider fails closed rather than being
      // answered by a simulator — a simulated analysis presented as a real one
      // would be the worst possible fallback.
      fallbackBindingId: null,
      dataHandlingClass: "local_process_only",
      mode: "live",
    },
    {
      bindingId: SIMULATOR_PRIMARY_BINDING_ID,
      providerName: "simulator",
      adapterId: SIMULATED_ADAPTER_ID,
      modelId: "sim-judgment-a",
      enabled: configuration.simulatorEnabled,
      structuredOutputMode: "json_schema",
      maxContextTokens: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 10_000,
      pricing: {
        costMode: "local_price_snapshot",
        pricingRevision: AGENTIC_PRICE_SNAPSHOT_REVISION,
        // Deliberately fictional rates for a deliberately fictional provider.
        // They exist so cost enforcement is exercised end to end; they are never
        // applied to a real provider, and no real provider's prices are invented
        // anywhere in this fabric.
        inputMicrosPerMillionTokens: 3_000_000,
        outputMicrosPerMillionTokens: 15_000_000,
        unpricedReason: null,
      },
      retryPolicy: { maxAttempts: 1, fallbackOnRateLimit: true },
      fallbackBindingId: SIMULATOR_FALLBACK_BINDING_ID,
      dataHandlingClass: "local_process_only",
      mode: "test",
    },
    {
      bindingId: SIMULATOR_FALLBACK_BINDING_ID,
      providerName: "simulator",
      adapterId: SIMULATED_ADAPTER_ID,
      modelId: "sim-judgment-b",
      enabled: configuration.simulatorEnabled,
      structuredOutputMode: "json_schema",
      maxContextTokens: 8_192,
      maxOutputTokens: 1_024,
      timeoutMs: 10_000,
      pricing: {
        costMode: "local_price_snapshot",
        pricingRevision: AGENTIC_PRICE_SNAPSHOT_REVISION,
        inputMicrosPerMillionTokens: 3_000_000,
        outputMicrosPerMillionTokens: 15_000_000,
        unpricedReason: null,
      },
      retryPolicy: { maxAttempts: 1, fallbackOnRateLimit: false },
      fallbackBindingId: null,
      dataHandlingClass: "local_process_only",
      mode: "test",
    },
  ];
}

/**
 * Which reviewed bindings each capability may reach, in preference order.
 *
 * A capability absent from this map can never run on a model, whatever a mission
 * asks for. That is how "deterministic capabilities can never be forced onto a
 * model" is enforced: not by a check that could be reordered or skipped, but by
 * the absence of anything to select.
 */
const CAPABILITY_BINDINGS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "architecture.analyze": Object.freeze([
    LOCAL_JUDGMENT_BINDING_ID,
    SIMULATOR_PRIMARY_BINDING_ID,
    SIMULATOR_FALLBACK_BINDING_ID,
  ]),
  "risk.analyze": Object.freeze([
    LOCAL_JUDGMENT_BINDING_ID,
    SIMULATOR_PRIMARY_BINDING_ID,
    SIMULATOR_FALLBACK_BINDING_ID,
  ]),
});

/** Every binding id any capability may reach. Used for typed compile-time refusals. */
export function authorizedBindingIdsFor(capabilityId: string): readonly string[] {
  return CAPABILITY_BINDINGS[capabilityId] ?? [];
}

export function capabilitySupportsModelWorker(capabilityId: string): boolean {
  return authorizedBindingIdsFor(capabilityId).length > 0;
}

/** Every binding id in the reviewed registry, independent of configuration. */
export function allRegisteredBindingIds(): readonly string[] {
  return Object.freeze(
    bindings({ localModelBaseUrl: "configured", simulatorEnabled: true, simulatorScenario: "succeed" }).map((binding) => binding.bindingId),
  );
}

export function createOperatorProviderBindingRegistry(
  configuration: AgenticProviderConfiguration,
): AgenticProviderBindingRegistry {
  return createAgenticProviderBindingRegistry(bindings(configuration));
}

/**
 * The binding a capability uses when a mission expresses no preference.
 *
 * The first *enabled* authorized binding, in the reviewed preference order —
 * which puts the live provider ahead of the simulator, so a configured
 * deployment never silently answers with a simulation.
 */
export function defaultBindingFor(
  capabilityId: string,
  registry: AgenticProviderBindingRegistry,
): string | null {
  for (const bindingId of authorizedBindingIdsFor(capabilityId)) {
    if (registry.resolve(bindingId)?.enabled === true) return bindingId;
  }
  return null;
}

/**
 * Validates one mission-selected binding against the closed registry.
 *
 * Refuses before a plan is compiled, so an unauthorized selection never reaches
 * a node payload, a Governor decision, or a worker.
 */
export function assertBindingSelectable(capabilityId: string, bindingId: string): void {
  if (!allRegisteredBindingIds().includes(bindingId)) {
    throw new OperatorError(
      `Provider binding ${bindingId} is not in the reviewed registry.`,
      409,
      "AGENTIC_INTENT_PROVIDER_BINDING_UNREGISTERED",
      { capabilityId, bindingId, registered: allRegisteredBindingIds().join(", ") },
    );
  }
  const authorized = authorizedBindingIdsFor(capabilityId);
  if (authorized.length === 0) {
    throw new OperatorError(
      `Capability ${capabilityId} authorizes no provider binding, so it cannot be executed by a model worker.`,
      409,
      "AGENTIC_INTENT_MODEL_WORKER_NOT_PERMITTED",
      { capabilityId, bindingId },
    );
  }
  if (!authorized.includes(bindingId)) {
    throw new OperatorError(
      `Capability ${capabilityId} is not authorized to use provider binding ${bindingId}.`,
      409,
      "AGENTIC_INTENT_PROVIDER_BINDING_NOT_AUTHORIZED",
      { capabilityId, bindingId, authorized: authorized.join(", ") },
    );
  }
}
