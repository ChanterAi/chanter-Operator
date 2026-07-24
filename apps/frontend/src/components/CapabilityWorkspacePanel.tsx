// CHANTER Operator — SDK Forge Capability Workspace (§14). Read-only founder
// view of the certified capability registry: id, version, category, risk,
// status, and invocation health. Pure formatting helpers are unit-tested so the
// display cannot drift from the projection contract.
import { useEffect, useState } from "react";
import { fetchForgeCapabilities } from "../api/client";
import type { CapabilitySummary, CapabilityWorkspaceProjection } from "../api/types";

export type StatusTone = "ok" | "warn" | "muted" | "error";

export function statusTone(status: string): StatusTone {
  switch (status) {
    case "certified": return "ok";
    case "deprecated": return "warn";
    case "disabled": return "error";
    default: return "muted"; // draft / validating
  }
}

export function riskTone(riskClass: string): StatusTone {
  switch (riskClass) {
    case "read_only": return "ok";
    case "bounded_write": return "warn";
    case "external_effect": return "warn";
    case "destructive": return "error";
    default: return "muted";
  }
}

export function healthLabel(cap: CapabilitySummary): string {
  if (!cap.health) return "no invocations";
  const { success, failure } = cap.health;
  if (success + failure === 0) return "no invocations";
  return `${success}✓ / ${failure}✗`;
}

const TONE_COLOR: Record<StatusTone, string> = { ok: "#1a7f37", warn: "#9a6700", error: "#b42318", muted: "#57606a" };

export function CapabilityWorkspacePanel() {
  const [projection, setProjection] = useState<CapabilityWorkspaceProjection | null>(null);

  useEffect(() => {
    let active = true;
    const load = () => {
      fetchForgeCapabilities().then((p) => { if (active) setProjection(p); }).catch(() => { /* projection carries its own state */ });
    };
    load();
    const timer = setInterval(load, 30_000);
    return () => { active = false; clearInterval(timer); };
  }, []);

  return (
    <section className="capability-workspace" aria-labelledby="capability-workspace-heading">
      <h2 id="capability-workspace-heading">SDK Forge — Capabilities</h2>
      {!projection ? (
        <p>Loading capabilities…</p>
      ) : !projection.configured ? (
        <p role="note">Capability registry not configured (set CHANTER_FORGE_BASE_URL).</p>
      ) : !projection.reachable ? (
        <p role="alert">Capability registry unreachable{projection.error ? ` (${projection.error})` : ""}.</p>
      ) : (
        <table>
          <thead>
            <tr><th>Capability</th><th>Version</th><th>Category</th><th>Risk</th><th>Status</th><th>Health</th></tr>
          </thead>
          <tbody>
            {projection.capabilities.map((cap) => (
              <tr key={`${cap.capabilityId}@${cap.version}`}>
                <td>{cap.capabilityId}</td>
                <td>{cap.version}</td>
                <td>{cap.category}</td>
                <td style={{ color: TONE_COLOR[riskTone(cap.riskClass)] }}>{cap.riskClass}</td>
                <td style={{ color: TONE_COLOR[statusTone(cap.status)] }}>{cap.status}</td>
                <td>{healthLabel(cap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
