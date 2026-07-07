// ── CHANTER Operator P2A: Runtime Bridge — Action Policy (real dependency) ──
//
// Operator P1A's hand-copied duplicate of chanter-agent-runtime's `src/policy.ts`
// has been replaced with a real import — see contract.ts for the dependency
// rationale. Sibling files keep importing from "./policy.js" unchanged.
//
// This module never performs an action and never mutates a task — it only
// returns a decision. Enforcement is the caller's responsibility.
//
// No execution. No network.

export type { RuntimeActionType, RuntimeActionRequest, RuntimeActionDecision } from "chanter-agent-runtime";
export { evaluateRuntimeActionPolicy } from "chanter-agent-runtime";
