// ── CHANTER Operator P1A: Runtime Bridge — Public Exports ──
//
// Barrel export for the Operator Runtime Bridge. Import from this module
// (or from "../index.js", which re-exports the same names) rather than
// reaching into individual runtimeBridge/*.ts files directly.

// ── Contract (types + transitions) ──
export type {
  JsonValue,
  RuntimeProduct,
  RuntimeStatus,
  RuntimeRiskLevel,
  RuntimeExecutionPolicy,
  RuntimePlanStep,
  RuntimePlan,
  RuntimeEvidenceType,
  RuntimeEvidence,
  RuntimeValidationCheck,
  RuntimeValidationResult,
  RuntimeResult,
  RuntimeRecommendationAction,
  RuntimeRecommendation,
  RuntimeEventType,
  RuntimeEvent,
  RuntimeTask,
} from "./contract.js";
export {
  requiresApprovalBeforeExecution,
  isTerminalStatus,
  getAllowedNextStatuses,
  assertTransitionAllowed,
  RuntimeTransitionError,
} from "./contract.js";

// ── Redaction ──
export { redactText, redactJsonValue, redactRecord } from "./redaction.js";

// ── Task lifecycle (advanced use — most callers only need operatorRuntimeBridge exports) ──
export type {
  CreateTaskInput,
  RuntimePlanStepInput,
  RuntimePlanInput,
  RuntimeEvidenceInput,
  RuntimeGuardTag,
  RuntimeValidationInput,
  RuntimeResultInput,
  RuntimeRecommendationInput,
} from "./tasks.js";
export {
  createTask,
  attachPlan,
  requireApproval,
  approveTask,
  startExecution,
  attachEvidence,
  startValidation,
  passValidation,
  failValidation,
  completeTask,
  failTask,
  blockTask,
  cancelTask,
  attachRecommendation,
} from "./tasks.js";

// ── Evidence bundle + review summary ──
export type { RuntimeEvidenceBundle, RuntimeEventSummary, RuntimeReviewSummary, RuntimeReviewSummaryFields } from "./evidence.js";
export { createEvidenceBundle, summarizeTaskForReview, assertJsonSafe } from "./evidence.js";

// ── Action policy evaluator ──
export type { RuntimeActionType, RuntimeActionRequest, RuntimeActionDecision } from "./policy.js";
export { evaluateRuntimeActionPolicy } from "./policy.js";

// ── Provider routing foundation ──
export type { RuntimeProviderRoute, RuntimeProviderRouteRequest, RuntimeProviderRouteDecision } from "./providerRouting.js";
export { selectProviderRoute } from "./providerRouting.js";

// ── Operator Runtime Bridge (primary entry point) ──
export type {
  CreateOperatorRuntimeTaskInput,
  RuntimeAdapterInputEnvelope,
  RuntimeAdapterResult,
  RuntimeProductAdapter,
  OperatorRuntimeBridgePrimitive,
  OperatorRuntimeBridgeReadinessReport,
} from "./operatorRuntimeBridge.js";
export {
  createOperatorRuntimeTask,
  evaluateOperatorRuntimeAction,
  mapOperatorActionTypeToRuntimeActionType,
  buildOperatorEvidenceBundle,
  summarizeOperatorRuntimeTask,
  DEFAULT_OPERATOR_PROVIDER_ROUTES,
  selectOperatorProviderRoute,
  runOperatorRuntimeAdapter,
  operatorRuntimeAdapter,
  OPERATOR_RUNTIME_BRIDGE_PRIMITIVES,
  deriveOperatorRuntimeBridgeReadiness,
  createOperatorAdapterReadinessReport,
  SAMPLE_OPERATOR_RUNTIME_TASK_INPUT,
  SAMPLE_OPERATOR_HIGH_RISK_TASK_INPUT,
} from "./operatorRuntimeBridge.js";
