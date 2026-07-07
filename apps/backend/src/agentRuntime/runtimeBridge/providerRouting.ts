// ── CHANTER Operator P2A: Runtime Bridge — Provider Routing (real dependency) ──
//
// Operator P1A's hand-copied duplicate of chanter-agent-runtime's
// `src/providerRouting.ts` has been replaced with a real import — see
// contract.ts for the dependency rationale. Sibling files keep importing
// from "./providerRouting.js" unchanged.
//
// Deliberately dumb: this module never calls a model, a tool, or the
// network. It only decides *which* configured candidate a caller should use
// for a given product/capability pair, from a plain in-memory candidate
// list the caller supplies. Wiring an actual provider call is entirely the
// caller's responsibility — this is routing selection, not invocation.

export type {
  RuntimeProviderRoute,
  RuntimeProviderRouteRequest,
  RuntimeProviderRouteDecision,
} from "chanter-agent-runtime";
export { selectProviderRoute } from "chanter-agent-runtime";
