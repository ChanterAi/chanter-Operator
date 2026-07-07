// ── CHANTER Operator P1.1: Agent Runtime Module ──
export type {
  AgentRuntime,
  AgentRunManifest,
  AgentRunLifecycleState,
  AgentRuntimePolicy,
  AgentRuntimeTimeoutPolicy,
  AgentRuntimeRetryPolicy,
  AgentRuntimeCancelPolicy,
  AgentRuntimeEvidenceRef,
  AgentRuntimeValidationResult,
  AgentRuntimeFailure,
} from "./types.js";

export {
  AgentRunLifecycleStates,
  DEFAULT_RUNTIME_POLICY,
} from "./types.js";

export { MockAgentRuntime } from "./mockRuntime.js";

export {
  isValidTransition,
  enforceTransition,
  verifyCompletedManifest,
  verifySerialization,
  createEmptyManifest,
  AgentRuntimeContractError,
} from "./agentRuntimeContract.js";

// ── CHANTER Operator P1A: Runtime Bridge (shared CHANTER Agent Runtime contract) ──
// See runtimeBridge/index.ts for the full export surface and
// docs/OPERATOR_RUNTIME_BRIDGE_P1A.md for how this relates to the
// AgentRunManifest/AgentRuntime contract above (P1.1–P1.6, dormant/mock-only).
export type {
  RuntimeProduct,
  RuntimeStatus,
  RuntimeRiskLevel,
  RuntimeExecutionPolicy,
  RuntimeTask,
  RuntimeActionType,
  RuntimeActionRequest,
  RuntimeActionDecision,
  RuntimeEvidenceBundle,
  RuntimeReviewSummary,
  RuntimeProviderRoute,
  RuntimeProviderRouteRequest,
  RuntimeProviderRouteDecision,
  RuntimeProductAdapter,
  CreateOperatorRuntimeTaskInput,
  OperatorRuntimeBridgeReadinessReport,
} from "./runtimeBridge/index.js";
export {
  createOperatorRuntimeTask,
  evaluateOperatorRuntimeAction,
  mapOperatorActionTypeToRuntimeActionType,
  buildOperatorEvidenceBundle,
  summarizeOperatorRuntimeTask,
  selectOperatorProviderRoute,
  DEFAULT_OPERATOR_PROVIDER_ROUTES,
  operatorRuntimeAdapter,
  runOperatorRuntimeAdapter,
  createOperatorAdapterReadinessReport,
  redactText as redactOperatorRuntimeText,
  redactJsonValue as redactOperatorRuntimeJsonValue,
} from "./runtimeBridge/index.js";
