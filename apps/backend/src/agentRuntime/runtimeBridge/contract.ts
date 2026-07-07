// ── CHANTER Operator P2A: Runtime Bridge — Contract (real dependency) ──
//
// Operator P1A's hand-copied duplicate of `chanter-agent-runtime`'s public
// contract types and transition rules has been replaced with real imports:
// `chanter-agent-runtime` is now a `file:../../../chanter-agent-runtime`
// dependency of this package (see package.json), so this module simply
// re-exports the upstream contract instead of duplicating it. Every sibling
// file in this directory continues to import from "./contract.js" — that
// import path (and the exported names) is unchanged, so no other file in
// runtimeBridge/ needed to change its imports.
//
// No execution. No network.

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
} from "chanter-agent-runtime";

export {
  requiresApprovalBeforeExecution,
  isTerminalStatus,
  getAllowedNextStatuses,
  assertTransitionAllowed,
  RuntimeTransitionError,
} from "chanter-agent-runtime";
