// CHANTER Operator — Platform Readiness demo presentation mode (CHANTER LIVE
// MISSION SHOWCASE I, §8). The smallest founder-facing projection of the
// disposable readiness mission into the Mission Workspace: title, objective,
// live phase/progress, current capability, local model + internet source,
// provenance, approval state, final result, evidence state, and the required
// truth badges — plus start / approve / reject / reset controls. Read-only
// mission; the browser never holds a token. Pure helpers are exported for unit
// tests so the display cannot drift from the projection contract.
import { useCallback, useEffect, useState } from "react";
import {
  approveDemoReadiness,
  fetchDemoReadinessState,
  rejectDemoReadiness,
  resetDemoReadiness,
  startDemoReadiness,
} from "../api/client";
import type { DemoReadinessAtom, DemoReadinessResponse, DemoReadinessState } from "../api/types";

export type Tone = "ok" | "warn" | "muted" | "error";

export function atomTone(status: string): Tone {
  switch (status) {
    case "succeeded": return "ok";
    case "degraded": return "warn";
    case "failed": return "error";
    case "running": return "warn";
    case "blocked_approval": return "warn";
    default: return "muted";
  }
}

export function badgeList(state: DemoReadinessState): Array<{ label: string; on: boolean }> {
  const b = state.badges;
  if (!b) return [];
  return [
    { label: "Read-only mission", on: b.readOnlyMission },
    { label: "Real internet capability", on: b.realInternetCapability },
    { label: "Local AI", on: b.localAI },
    { label: "Human approval required", on: b.humanApprovalRequired },
    { label: `External writes: ${b.externalWrites}`, on: b.externalWrites === 0 },
    { label: "Evidence retained", on: b.evidenceRetained },
  ];
}

const TONE_COLOR: Record<Tone, string> = { ok: "#1a7f37", warn: "#9a6700", error: "#b42318", muted: "#57606a" };
const hourKey = () => `operator-ui-${new Date().toISOString().slice(0, 13)}`;

export function PlatformReadinessPanel() {
  const [projection, setProjection] = useState<DemoReadinessResponse | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    fetchDemoReadinessState().then(setProjection).catch(() => { /* projection carries its own state */ });
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 2500);
    return () => clearInterval(timer);
  }, [load]);

  const state = projection?.state ?? null;
  const missionId = state?.missionId;
  const status = state?.status;

  const doStart = async () => { setBusy(true); try { setProjection(await startDemoReadiness(hourKey())); } finally { setBusy(false); load(); } };
  const doApprove = async () => { if (!missionId) return; setBusy(true); try { setProjection(await approveDemoReadiness(missionId, "founder")); } finally { setBusy(false); load(); } };
  const doReject = async () => { if (!missionId) return; setBusy(true); try { setProjection(await rejectDemoReadiness(missionId, "founder")); } finally { setBusy(false); load(); } };
  const doReset = async () => { setBusy(true); try { setProjection(await resetDemoReadiness()); } finally { setBusy(false); load(); } };

  return (
    <section className="platform-readiness" aria-labelledby="platform-readiness-heading">
      <h2 id="platform-readiness-heading">CHANTER Platform Readiness Mission</h2>
      {!projection ? (
        <p>Loading readiness mission…</p>
      ) : !projection.configured ? (
        <p role="note">Readiness demo not configured (set CHANTER_DEMO_BASE_URL).</p>
      ) : !projection.reachable ? (
        <p role="alert">
          Readiness demo server unreachable{projection.error ? ` (${projection.error})` : ""}. Start it with{" "}
          <code>.\chanter.ps1 demo-start</code>.
        </p>
      ) : (
        <>
          <p style={{ color: "#57606a", maxWidth: "70ch" }}>
            {state?.objective ?? "Read-only platform inspection, local AI assessment, deterministic validation, human-approved briefing."}
          </p>

          <div className="platform-readiness__badges" style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "12px 0" }}>
            {state && badgeList(state).map((badge) => (
              <span key={badge.label} style={{ border: "1px solid #d0d7de", borderRadius: 999, padding: "4px 12px", fontSize: 12, color: badge.on ? TONE_COLOR.ok : TONE_COLOR.muted }}>
                {badge.label}
              </span>
            ))}
          </div>

          <div className="platform-readiness__controls" style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button type="button" onClick={doStart} disabled={busy || status === "running" || status === "blocked_approval"}>▶ Start mission</button>
            <button type="button" onClick={doApprove} disabled={busy || status !== "blocked_approval"}>✓ Approve final brief</button>
            <button type="button" onClick={doReject} disabled={busy || status !== "blocked_approval"}>✕ Reject</button>
            <button type="button" onClick={doReset} disabled={busy}>↻ Reset demo</button>
            {state?.replayed && <span style={{ alignSelf: "center", color: "#9a6700", fontSize: 12 }}>replayed — idempotent, no duplicate</span>}
          </div>

          {!state?.present ? (
            <p role="note">No mission yet. Click “Start mission”.</p>
          ) : (
            <div className="platform-readiness__grid" style={{ display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 16 }}>
              <div>
                <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#57606a" }}>Execution timeline</h3>
                <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
                  {(state.atoms ?? []).map((atom: DemoReadinessAtom) => (
                    <li key={atom.atomId} style={{ display: "flex", gap: 8, padding: "4px 0", borderBottom: "1px dashed #eaeef2" }}>
                      <span style={{ color: TONE_COLOR[atomTone(atom.status)], minWidth: 90 }}>{atom.status}</span>
                      <span>{atom.title}</span>
                      <span style={{ marginLeft: "auto", color: "#57606a", fontSize: 12 }}>
                        {atom.capability ? `· ${atom.capability}` : ""} {atom.durationMs != null ? `· ${atom.durationMs}ms` : ""}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
              <div>
                <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#57606a" }}>Live truth</h3>
                <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 12px", fontSize: 13 }}>
                  <dt>Status</dt><dd><b>{state.status}</b></dd>
                  <dt>Current phase</dt><dd>{state.currentPhase?.title ?? "—"}</dd>
                  <dt>Progress</dt><dd>{state.progress ? `${state.progress.done} / ${state.progress.total}` : "—"}</dd>
                  <dt>Current capability</dt><dd>{state.currentCapability ?? "—"}</dd>
                  <dt>Local model</dt><dd>{state.localModel ?? "—"}</dd>
                  <dt>Internet source</dt><dd>{state.internetSource ?? "—"}</dd>
                  <dt>Provenance</dt><dd>{(state.liveProvenance ?? []).join(", ") || "—"}</dd>
                  <dt>Approval</dt><dd>{state.approvalState ?? "—"}</dd>
                  <dt>External writes</dt><dd><b style={{ color: TONE_COLOR.ok }}>{state.counters?.providerWrites ?? "—"}</b></dd>
                  <dt>Evidence</dt><dd>{state.evidenceState?.retained ? `retained · ${state.evidenceState.evidenceRef}` : "not yet"}</dd>
                  <dt>Readiness</dt><dd>{state.brief?.readiness ?? state.claims?.readiness.final ?? "—"}</dd>
                </dl>
              </div>
            </div>
          )}

          {state?.claims && (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 13, textTransform: "uppercase", color: "#57606a" }}>Validated claims &amp; sources</h3>
              {state.claims.validated.length === 0 ? (
                <p style={{ color: "#57606a" }}>No validated claims yet.</p>
              ) : (
                <ul>
                  {state.claims.validated.map((claim, index) => (
                    <li key={index}>✓ {claim.claim} <small style={{ color: "#57606a" }}>(sources: {claim.sourceRefs.join(", ")})</small></li>
                  ))}
                </ul>
              )}
              {state.claims.rejected.length > 0 && (
                <ul>
                  {state.claims.rejected.map((claim, index) => (
                    <li key={index} style={{ color: "#57606a" }}>✕ rejected: {claim.reason}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
