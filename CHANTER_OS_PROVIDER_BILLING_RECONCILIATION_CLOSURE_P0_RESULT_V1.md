# CHANTER OS — Provider Billing Reconciliation Closure P0 — Result V1

## 1. Verdict

**GOVERNED PROVIDER-BACKED MODEL-WORKER ADMISSION: PASS**

The canonical acceptance command

```
npm run os:csi-model-workers -- --require-billed-provider
```

returned **PASS (32/32 steps)** against a live billed provider on 2026-08-07.
Two real inference calls were purchased, and **both charges were confirmed
against OpenRouter's own generation record at a delta of zero**.

## 2. Exact root cause

The predecessor run failed at step 29 with `unavailable, unavailable`. Nothing
was wrong with the money. The charges were real, correctly measured, and durably
recorded with their generation ids intact.

The lookup was **three milliseconds early**:

| Charge | `recorded_at` | reconcile `checkedAt` | Gap | Result |
| --- | --- | --- | --- | --- |
| N3 | `11:30:07.634Z` | `11:30:07.637Z` | 3 ms | `HTTP 404` |
| N2 | `11:30:08.513Z` | `11:30:08.516Z` | 3 ms | `HTTP 404` |

OpenRouter writes its generation record **after** the completion returns, so an
immediate lookup races the provider's own bookkeeping and legitimately finds
nothing. Two defects turned that transient miss into a permanent one:

1. **`openRouterModelAdapter.reconcile` was single-shot.** It mapped every
   non-2xx to `unavailable` and stopped. A `404` from this endpoint does not mean
   "no such generation" — it means "not yet", and a single ask cannot tell those
   apart.
2. **Reconciliation was reachable only during invocation.** The generation id was
   already durable in `operator_agentic_provider_usage.provider_request_id`, but
   nothing could read it. A mission replay is refused at
   `AGENTIC_PROVIDER_ALREADY_INVOKED` long before reconciliation is reachable, so
   `unavailable` was terminal for a charge that was merely early.

**Seam ownership:** both defects are **Agent Runtime**. The missing operator-facing
surface is **Operator**. **Loop Governor is not involved and changed by zero lines.**

## 3. Repository starting and ending truth

| Repository | Branch | Start HEAD | End HEAD | Worktree |
| --- | --- | --- | --- | --- |
| `apps/chanter-agent-runtime` | `runtime/billed-external-provider-cost-authority-p0` | `874a1fc` | **`650cdce`** | clean |
| `apps/chanter-Operator` | `os/billed-external-provider-cost-authority-p0` | `a3546d6` | this commit | clean |
| `apps/chanter-loop.governor` | `governor/agentic-plan-governance-p0` | `60cb42a` | `60cb42a` | clean, **0 lines** |

No unrelated commit was amended. Nothing was pushed.

## 4. Live billed evidence

Two real inference calls, `deepseek/deepseek-v4-flash` via binding
`external.openrouter.deepseek-v4-flash.judgment`, routed to the pinned upstream
endpoint and confirmed as such by the provider's own record (`upstreamProvider:
"Baidu"`).

```text
total charged ................ 305 micros (USD 0.000305) across 2 calls
monetary cost source ......... provider_reported
pricing revision ............. null (a reported charge needs no invented price)
```

| Node | Provider generation id | CHANTER recorded | Provider-owned | Delta | Verdict | Lookups |
| --- | --- | --- | --- | --- | --- | --- |
| N2 | `gen-1786106182-WvGTls2z2goFoGQqaTcy` | **154 µ** | **154 µ** | **0** | `matched` | 5 |
| N3 | `gen-1786106182-LTMhMBnWlpP0JvJvULib` | **151 µ** | **151 µ** | **0** | `matched` | 5 |

Evidence type is `provider_generation_lookup` for both — the provider's own
authenticated record of what it charged, never a price list. There is
deliberately no evidence type for a rate card, a calculator, or a dashboard
figure: none of those is evidence of a *charge*.

## 5. Reconciliation safety evidence

```text
additional inference calls during reconciliation ....... 0
duplicate provider charges ............................. 0
restart reconciliation, provider calls ................. 2 -> 2
restart reconciliation, total charge ................... 305 µ -> 305 µ
restart reconciliation, lookups issued ................. 0
billed replay, provider calls .......................... 2 -> 2
billed replay, total charge ............................ 305 µ -> 305 µ
billed credential in any durable record ................ false
```

`0` here is a **measured count**, read from
`operator_agentic_provider_usage` before and after each operation, not an
assumption about what the code can do.

**The zero-inference guarantee is structural.** `reconcileRecordedCharges` can
reach exactly one adapter method — `reconcile`. No branch reaches `invoke`. That
is why restarting, retrying, or repeating it cannot produce a second charge,
rather than it merely being observed not to.

### An honest reading of the two zeros in step 29

Step 29's summary reports `lookupAttempts: 0` while each charge's own evidence
reports `attempts: 5`. Both are correct and they mean different things:

- The **inline** bounded poll — 5 lookups per charge, backoff 500/1000/2000/4000
  ms — is what actually confirmed these charges live. That is the fix for the
  observed defect, and it is measured.
- The **standalone** pass then correctly issued **zero** lookups, because both
  charges were already settled. Monotonicity is working exactly as designed.

So this live run proves the standalone pass is reachable, authorized, idempotent,
and free. It does **not** prove the standalone pass performing a real provider
lookup, because on this run there was nothing left to look up. That path is
proven deterministically (§7), and §10 names the zero-cost way to prove it live.

## 6. Implementation

### Agent Runtime — `650cdce`

- `src/adapters/openRouterModelAdapter.ts` — bounded polling. `404`, `429`, `5xx`,
  and a record whose `total_cost` has not settled are "ask again"; `401`, `403`,
  and any other `4xx` return immediately, because a refusal re-asked eight times
  proves nothing and only delays the answer. A cancelled lookup reaches the
  provider zero times and invents no verdict.
- `src/agenticModelProvider.ts` — `AgenticProviderReconciliation` gains
  `attempts`, so the polling count is reported rather than inferred;
  `AgenticProviderReconciliationRequest` gains `maxAttempts`, `retryDelayMs`, and
  an injected `wait`; new `reconcileRecordedCharges` drives confirmation from
  durable records alone.
- `src/index.ts` — exports the new surface.

Inline budget: 5 attempts. Standalone budget: 8. Both bounded, both configurable,
neither able to become an unbounded wait (backoff is capped at 4 s).

### Operator — this commit

- `agenticMissionService.reconcileBilling(missionId)` — mission-scoped pass over
  durable charges. It also refreshes the mission's durable
  `billingReconciliationVerdict`, journaled as `mission_billing_reconciled` with
  the generation ids as evidence references. Without that, a completed mission
  whose charges were later confirmed would keep asserting they were not — a stale
  financial statement, and the number a human reads is that one.
- `POST /api/os/missions/:osMissionId/billing/reconcile`, on the mission-control
  capability, listed in `/api/health` endpoint discovery.
- `tools/os-billing-reconciliation/` — operational recovery for charges recorded
  by a run that is already over. Registered in `tsconfig.tools.json` **in the same
  change that created it**.

## 7. Negative and deterministic proofs added

**Agent Runtime (6 new):** a late record is still confirmed and the poll count
reported; the bound is a hard ceiling; a decided refusal does not spend the
budget; an unsettled `total_cost` is "not yet" rather than zero; a cancelled
lookup reaches the provider zero times; reconciliation never sends a request body
(a POST here would be an inference call).

**Agent Runtime, standalone pass (6 new):** confirms what the inline attempt could
not, buying nothing; re-running costs nothing and cannot re-purchase; an
unconfirmable charge stays unconfirmed; a `mismatched` verdict is **never polled
away**; a charge whose binding is gone is unconfirmable, not fine; an unbilled
call is not a charge.

**Operator (7 new):** the same properties end to end through the real mission
service, plus preservation of every existing evidence field, the durable
observation refresh writing exactly once, and an unknown mission refused without
touching a provider.

No test was weakened, skipped, or deleted. One existing test was **updated**, not
worked around: `runtime-missions.test.ts` pins the exact mission-control endpoint
list, and the new route belongs in it.

## 8. Validation results

| Scope | Result |
| --- | --- |
| Agent Runtime `npm test` | **684 / 684** |
| Operator `test:backend` | **1002 / 1002** (995 → 1002) |
| Operator `validate:os` | **PASS 13 / 13** |
| Operator `os:csi-model-workers` (unbilled path) | **PASS 28 / 28** |
| Operator `os:csi-model-workers --require-billed-provider` | **PASS 32 / 32** |
| Loop Governor | **not run — zero lines changed** |

All re-run after the final edit.

## 9. Gate step count

The canonical gate is now **32 steps**, not 29. The brief's `29/29` target
reflected where the previous run died; the runner already contained 31 steps, of
which 30 and 31 had never been reached. This change adds exactly one:

> **[30] Reconcile again through a restarted server, buying nothing**

It exists because restart reconciliation is required evidence. A charge that
could only be confirmed by the process that incurred it would be unconfirmable
after any crash — which is precisely the situation this P0 was called to fix.

No stage was removed, reordered, or renamed, and no parallel "billing" gate was
created.

## 10. Residual risks and open items

1. **The predecessor run's two charges remain unconfirmed.** The 2026-08-07
   charges of **147 µ and 159 µ** (`gen-1786102202-r2xQm6YML2PXFwHnDMxn`,
   `gen-1786102202-zI9EmqkvAAbPrOOKoRXA`, 306 µ total) still read `unavailable /
   HTTP 404` in the preserved state at
   `%TEMP%\chanter-os-csi-GnRNNf\operator.sqlite`. The tool that would confirm
   them exists and **was not run**. It costs nothing — zero inference calls — and
   would additionally give the one piece of live evidence §5 says this run does
   not carry:

   ```
   npm run os:reconcile-charges -- --database "<path>\operator.sqlite"
   ```

   It backs the database up to `.pre-reconciliation.bak` before touching it.
2. **The inline poll adds real wall-clock latency** to a billed node when the
   provider's record is late — up to ~7.5 s per charge at the 5-attempt bound. It
   is off the dispatch deadline and does not corrupt measured latency, but it is
   real time on the critical path.
3. **`operator-p1 > handles timeout for a blocked command` failed once** under
   heavy parallel load during development and has not recurred across five
   subsequent full-suite runs; pristine HEAD ran green twice. It is a
   timing-sensitive test, unrelated to this seam, and is recorded rather than
   hidden.
4. **A `mismatched` verdict has never been observed live.** Its handling — escalate,
   never re-poll — is proven only deterministically.
5. **Generation-record retention is not characterized.** If OpenRouter expires
   records, a charge left unconfirmed long enough becomes permanently
   unconfirmable. Risk 1 is the near-term instance of this.

## 11. Security and privacy

- The credential is used only as an `Authorization` header, held in one closure,
  registered as a protected value so the redaction boundary scrubs it from any
  diagnostic.
- Step 32 scans **every column of every agentic table** for the literal credential
  and for `sk-or-` shaped material: **not present**.
- No prompt, completion, reasoning, or chain-of-thought is persisted. Reasoning is
  disabled at the provider (`reasoning: { enabled: false }`), not merely hidden.
- Reconciliation sends **no request body**; a POST from that path would be an
  inference call, and a test pins its absence.
- This artifact contains no secret and no fragment of one.

## 12. Scope discipline

Routing, pricing policy, provider selection, and every other CHANTER OS
capability were left untouched. The binding registry, the upstream pin, the cost
modes, and the approval chain are byte-identical to their starting state. No
authority was weakened, no provider billing evidence was fabricated, and the only
billed inference calls made were the two the acceptance proof itself requires.

---

**Execution rule compliance.** Every number above was read from the run's own
report or from durable SQLite. No cost, token count, test result, or verdict is
claimed that was not measured. Where this run's evidence is narrower than it
looks — the two zeros in step 29 — §5 says so explicitly rather than letting the
stronger reading stand.
