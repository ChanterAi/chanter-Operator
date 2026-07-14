import type { ReadinessState } from "../api/types";

interface Props {
  state: ReadinessState;
}

export function ReadinessBar({ state }: Props) {
  if (state.kind === "loading") {
    return (
      <div className="readiness-bar readiness-bar--loading" role="status" aria-live="polite">
        <span className="readiness-bar__item">Checking backend readiness...</span>
      </div>
    );
  }

  if (state.kind === "unavailable" || state.kind === "error") {
    return (
      <div className="readiness-bar readiness-bar--unavailable" role="alert" aria-live="assertive">
        <span className="readiness-bar__dot readiness-bar__dot--unavailable" />
        <span className="readiness-bar__item">Backend unavailable</span>
        <span className="readiness-bar__sep" />
        <span className="readiness-bar__detail">{state.error}</span>
      </div>
    );
  }

  const { health } = state;
  const integrity = health.integrity;
  const ok = integrity.healthy && state.kind === "healthy";
  const dbIssueCount = integrity.database.issues;
  const auditIssueCount = integrity.audit.parseErrors + integrity.audit.missingFieldErrors + integrity.audit.invalidTypeErrors + integrity.audit.crossRefIssues;
  const autoPosterReadiness = health.runtimeMissions.autoposter;

  return (
    <div className={`readiness-bar${ok ? " readiness-bar--ok" : " readiness-bar--unhealthy"}`} role="status" aria-live="polite">
      <span className={`readiness-bar__dot${ok ? " readiness-bar__dot--ok" : " readiness-bar__dot--unhealthy"}`} />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">Backend</span>
        {health.status === "ok" ? "Reachable" : health.status}
      </span>
      <span className="readiness-bar__sep" />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">Integrity</span>
        {ok ? "Healthy" : "Unhealthy"}
      </span>
      <span className="readiness-bar__sep" />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">DB</span>
        {health.real_execution_enabled ? "WARNING" : "Mock-only"}
      </span>
      <span className="readiness-bar__sep" />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">Records</span>
        {integrity.database.tasks}T / {integrity.database.steps}S / {integrity.database.evidence}E
      </span>
      <span className="readiness-bar__sep" />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">AutoPoster drafts</span>
        {autoPosterReadiness.configured ? "Configured" : "Unavailable"}
      </span>
      <span className="readiness-bar__sep" />

      <span className="readiness-bar__item">
        <span className="readiness-bar__label">Publishing</span>
        {autoPosterReadiness.publishingEnabled ? "WARNING" : "Disabled"}
      </span>

      {!ok && (
        <>
          <span className="readiness-bar__sep" />
          <span className="readiness-bar__item readiness-bar__item--issues">
            {dbIssueCount > 0 && <span>DB: {dbIssueCount}</span>}
            {dbIssueCount > 0 && auditIssueCount > 0 && <span>·</span>}
            {auditIssueCount > 0 && <span>Audit: {auditIssueCount}</span>}
          </span>
        </>
      )}
    </div>
  );
}
