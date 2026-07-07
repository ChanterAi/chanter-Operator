// ── CHANTER Operator P2A: Runtime Bridge — Redaction (real dependency) ──
//
// Operator P1A's hand-copied duplicate of chanter-agent-runtime's
// `src/redaction.ts` has been replaced with a real import — see contract.ts
// for the dependency rationale. The redaction *pattern logic* itself
// (redactText/redactJsonValue/redactRecord) was always byte-identical to
// upstream, so importing it changes nothing behaviorally.
//
// DELIBERATE HARDENING THAT REMAINS LOCAL: this repo's `tasks.ts` and
// `evidence.ts` call these functions on more fields than upstream
// chanter-agent-runtime's own `tasks.ts`/`evidence.ts` do — an end-to-end
// secret-leakage test found upstream never redacts `RuntimeTask.objective`,
// `RuntimeResult.summary`, or `RuntimeValidationResult.summary` at either the
// write or export boundary (only `inputs`, evidence `detail`/`source`,
// validation check `message`, result `output`, and recommendation `reason`
// are covered upstream). That extra coverage is Operator-specific behavior
// living in tasks.ts/evidence.ts, not in this module, and is unaffected by
// this file now importing the underlying redaction functions instead of
// duplicating them. Flagged for upstreaming in a future chanter-agent-runtime
// hardening pass.
//
// Pattern-matching redaction is inherently best-effort, not a cryptographic
// guarantee: it cannot catch every possible secret shape. It is a defensive
// net, not a substitute for callers keeping real secrets out of task data.

export { redactText, redactJsonValue, redactRecord } from "chanter-agent-runtime";
