/**
 * CHANTER OS — provider adapter wiring.
 *
 * Turns configuration into the concrete transports the Runtime's model-worker
 * port may reach. Two properties matter and are both structural:
 *
 *   - **an unconfigured deployment reaches nothing.** No adapter is registered
 *     for a provider whose configuration is absent, so a binding that somehow
 *     survived the `enabled` check still has no transport and fails closed with
 *     a typed `AGENTIC_PROVIDER_ADAPTER_UNAVAILABLE`.
 *   - **no credential passes through here.** The one live provider is a local
 *     process that requires none. When a credentialed provider is added, its
 *     secret must be read from secure configuration inside its own adapter and
 *     must never reach a binding, a usage record, a log line, or a mission.
 *
 * ## Why simulator behaviour is a closed scenario name
 *
 * Provider failure modes cannot be summoned from a real provider on demand, so
 * they have to be simulated — but "simulate whatever this environment variable
 * says" would be an injection surface that decides what a specialist node
 * concludes. Instead the scenarios below are reviewed code, selected by name,
 * and every one of them derives its document from the prompt it was actually
 * shown. A simulator that invented context ids would fail the verifier for the
 * wrong reason and prove nothing.
 */
import {
  createOllamaModelAdapter,
  createOpenRouterModelAdapter,
  createSimulatedModelAdapter,
  OLLAMA_ADAPTER_ID,
  OPENROUTER_ADAPTER_ID,
  SIMULATED_ADAPTER_ID,
  type AgenticProviderAdapter,
  type AgenticProviderDispatch,
  type SimulatedProviderBehaviour,
  type SimulatedProviderScript,
} from "chanter-agent-runtime";
import {
  EXTERNAL_BILLED_UPSTREAM_PROVIDERS,
  type AgenticProviderConfiguration,
} from "./agenticProviderRegistry.js";

/**
 * Closed set of simulator scenarios. Test mode only.
 *
 * `disabled` is the default and registers no simulator at all, so a deployment
 * that never opts in cannot answer a mission with a simulation.
 */
export const AGENTIC_SIMULATOR_SCENARIOS = [
  "disabled",
  "succeed",
  "primary_unavailable_fallback_succeeds",
  "primary_timeout_unknown_outcome",
  "primary_malformed_output",
  "usage_not_reported",
] as const;

export type AgenticSimulatorScenario = (typeof AGENTIC_SIMULATOR_SCENARIOS)[number];

export function normalizeSimulatorScenario(raw: string): AgenticSimulatorScenario {
  const value = raw.trim();
  return AGENTIC_SIMULATOR_SCENARIOS.includes(value as AgenticSimulatorScenario)
    ? (value as AgenticSimulatorScenario)
    : "disabled";
}

/** The context ids a dispatch was actually shown, read back out of the prompt. */
function citableContextIds(dispatch: AgenticProviderDispatch): string[] {
  return [...dispatch.userInput.matchAll(/^## CONTEXT_ID: (.+)$/gm)].map((match) => match[1] ?? "");
}

/**
 * A schema-valid claim set grounded in the prompt's own admitted context.
 *
 * Two claims: one supported, one citing an id that was never admitted. The
 * second is deliberate — it is the simulator's contribution to proving the
 * independent verifier rejects unsupported citations, and it mirrors exactly
 * what a real model does when it cites something plausible that does not exist.
 */
function groundedDocument(dispatch: AgenticProviderDispatch, label: string): Record<string, unknown> {
  const ids = citableContextIds(dispatch);
  const first = ids[0] ?? "ctx-unknown";
  return {
    claims: [
      {
        claimId: `${label}-sim-supported`,
        statement: `Simulated ${label} finding grounded in admitted context ${first}.`,
        confidence: "medium",
        evidenceRefs: [first],
      },
      {
        claimId: `${label}-sim-unsupported`,
        statement: `Simulated ${label} finding citing a reference the context compiler never admitted.`,
        confidence: "low",
        evidenceRefs: ["ctx-never-admitted-by-the-context-compiler"],
      },
    ],
  };
}

function scenarioScript(scenario: AgenticSimulatorScenario): SimulatedProviderScript {
  return {
    behaviours: {},
    resolve: (dispatch): SimulatedProviderBehaviour | null => {
      const isPrimary = dispatch.binding.modelId.endsWith("-a");
      const label = dispatch.userInput.includes("risk") ? "risk" : "architecture";
      const succeed: SimulatedProviderBehaviour = {
        kind: "succeed",
        document: groundedDocument(dispatch, label) as never,
        // Deterministic, plausible usage. It is *simulated* usage and every
        // record it produces is stamped `mode: "test"`, which the proof runner
        // refuses to count as live-provider evidence.
        inputTokens: Math.min(Math.ceil(dispatch.userInput.length / 4), 4_000),
        outputTokens: 180,
      };
      switch (scenario) {
        case "disabled":
          return null;
        case "succeed":
          return succeed;
        case "primary_unavailable_fallback_succeeds":
          return isPrimary ? { kind: "unavailable" } : succeed;
        case "primary_timeout_unknown_outcome":
          return isPrimary ? { kind: "timeout" } : succeed;
        case "primary_malformed_output":
          return isPrimary ? { kind: "malformed_json", inputTokens: 100, outputTokens: 20 } : succeed;
        case "usage_not_reported":
          return isPrimary
            ? { kind: "usage_missing", document: groundedDocument(dispatch, label) as never }
            : succeed;
      }
    },
  };
}

export function createAgenticProviderAdapters(
  configuration: AgenticProviderConfiguration,
): ReadonlyMap<string, AgenticProviderAdapter> {
  const adapters = new Map<string, AgenticProviderAdapter>();
  const baseUrl = configuration.localModelBaseUrl.trim();
  if (baseUrl) {
    try {
      adapters.set(OLLAMA_ADAPTER_ID, createOllamaModelAdapter({ baseUrl }));
    } catch {
      // A malformed base URL leaves the adapter unregistered rather than
      // throwing at startup. The binding then fails closed at the moment it is
      // used, naming the problem far more precisely than a boot crash would.
    }
  }
  // The billed adapter exists only when a credential does. Without one there is
  // no transport, so the enabled-check and the adapter-check both have to fail
  // before money could be spent — two independent gates, not one.
  const openRouterKey = configuration.openRouterApiKey.trim();
  if (openRouterKey) {
    try {
      adapters.set(OPENROUTER_ADAPTER_ID, createOpenRouterModelAdapter({
        baseUrl: configuration.openRouterBaseUrl.trim() || "https://openrouter.ai",
        apiKey: openRouterKey,
        allowedUpstreamProviders: EXTERNAL_BILLED_UPSTREAM_PROVIDERS,
        title: "CHANTER OS",
      }));
    } catch {
      // A malformed origin or empty credential leaves the adapter unregistered,
      // so the binding fails closed at use with a typed error rather than
      // crashing the process at boot.
    }
  }
  if (configuration.simulatorEnabled && configuration.simulatorScenario !== "disabled") {
    adapters.set(SIMULATED_ADAPTER_ID, createSimulatedModelAdapter(scenarioScript(configuration.simulatorScenario)));
  }
  return adapters;
}
