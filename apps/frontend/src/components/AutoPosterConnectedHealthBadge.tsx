// CHANTER Operator — AutoPoster connected-health truth label.
//
// Renders the *verified* Firestore mode (never optimistic): the label reflects
// exactly what AutoPoster's connected-health read reported, plus freshness. The
// mapping is a pure, unit-tested function so the display can never drift from
// the projection contract.
import type { ConnectedHealthProjection } from "../api/types";

export type HealthTone = "ok" | "warn" | "error" | "neutral";

export interface ConnectedHealthDisplay {
  text: string;
  tone: HealthTone;
  detail: string;
  badges: string[];
}

export function describeConnectedHealth(p: ConnectedHealthProjection | null): ConnectedHealthDisplay {
  if (!p) {
    return { text: "AutoPoster health: loading…", tone: "neutral", detail: "", badges: [] };
  }
  const badges: string[] = [];
  if (p.autoPosterReachable) badges.push("AutoPoster connected");
  if (p.publishingBlocked) badges.push("Publishing blocked");
  if (p.stale) badges.push("Health stale");

  const age =
    p.ageMs === null ? "" : `observed ${Math.max(0, Math.round(p.ageMs / 1000))}s ago`;
  const observed = p.observedAt ? ` · ${age}` : "";

  switch (p.primaryLabel) {
    case "unconfigured":
      return { text: "AutoPoster health: not configured", tone: "neutral", detail: "Set AUTOPOSTER_BASE_URL + runtime token.", badges };
    case "unreachable":
      return { text: "AutoPoster: unreachable", tone: "error", detail: p.error ?? "no response", badges };
    case "firestore_emulator":
      return { text: "Firestore: emulator", tone: "ok", detail: `verified${observed}`, badges };
    case "firestore_real":
      return { text: "Firestore: real", tone: "ok", detail: `verified${observed}`, badges };
    case "firestore_unavailable":
      return { text: "Firestore: unavailable", tone: "error", detail: `backend read failed${observed}`, badges };
    case "health_stale":
      return { text: "Firestore mode: stale", tone: "warn", detail: `last read too old${observed}`, badges };
    case "health_unknown":
    default:
      return { text: "Firestore mode: unknown", tone: "warn", detail: `not verifiable${observed}`, badges };
  }
}

const TONE_COLOR: Record<HealthTone, string> = {
  ok: "#1a7f37",
  warn: "#9a6700",
  error: "#b42318",
  neutral: "#57606a",
};

export function AutoPosterConnectedHealthBadge({
  projection,
}: {
  projection: ConnectedHealthProjection | null;
}) {
  const d = describeConnectedHealth(projection);
  return (
    <div
      className="autoposter-connected-health"
      role="status"
      aria-label={`AutoPoster connected health: ${d.text}`}
      style={{ display: "flex", flexDirection: "column", gap: 4, padding: "8px 12px", border: "1px solid #d0d7de", borderRadius: 8 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: "50%", background: TONE_COLOR[d.tone] }} />
        <strong style={{ color: TONE_COLOR[d.tone] }}>{d.text}</strong>
        {d.detail ? <span style={{ color: "#57606a", fontSize: 12 }}>{d.detail}</span> : null}
      </div>
      {d.badges.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {d.badges.map((b) => (
            <span key={b} style={{ fontSize: 11, color: "#57606a", border: "1px solid #d0d7de", borderRadius: 999, padding: "1px 8px" }}>
              {b}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
