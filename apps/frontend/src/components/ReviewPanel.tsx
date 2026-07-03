import type { TaskDetail } from "../api/types";

interface Props {
  detail: TaskDetail | null;
  busy: boolean;
  onApprove: (stepId: string) => Promise<void>;
  onReject: (stepId: string) => Promise<void>;
}

export function ReviewPanel({ detail, busy, onApprove, onReject }: Props) {
  const step = detail?.steps[0];
  const pending = step?.status === "pending_approval";

  return (
    <aside className="panel panel--review">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Human gate</p>
          <h2>Review</h2>
        </div>
        <span className={`safety-indicator${pending ? " safety-indicator--pending" : ""}`}>
          {pending ? "Decision needed" : "Contained"}
        </span>
      </div>

      <section className="review-section">
        <h3>Approval</h3>
        {pending && step ? (
          <>
            <p>This simulated <strong>{step.action_type.replaceAll("_", " ")}</strong> step requires explicit approval.</p>
            <div className="approval-actions">
              <button className="button button--primary" disabled={busy} onClick={() => onApprove(step.id)} type="button">Approve & simulate</button>
              <button className="button button--danger" disabled={busy} onClick={() => onReject(step.id)} type="button">Reject</button>
            </div>
          </>
        ) : (
          <p className="muted">{detail ? "No approval decision is pending." : "Select a task to review its gate."}</p>
        )}
      </section>

      <section className="review-section">
        <h3>Evidence timeline</h3>
        {!detail?.evidence.length ? <p className="muted">No evidence recorded.</p> : (
          <ol className="timeline">
            {detail.evidence.map((evidence) => (
              <li key={evidence.id}>
                <span className={evidence.validation_passed ? "timeline__marker timeline__marker--pass" : "timeline__marker timeline__marker--fail"} />
                <div>
                  <strong>{evidence.validation_passed ? "Validation passed" : "Validation failed"}</strong>
                  <p>{evidence.validation_summary}</p>
                  <time>{new Date(evidence.created_at).toLocaleString()} · exit {evidence.exit_code}</time>
                </div>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="review-section review-section--audit">
        <h3>Audit preview</h3>
        {!detail?.audit_events.length ? <p className="muted">No audit events.</p> : (
          <ol className="audit-list">
            {detail.audit_events.map((event) => (
              <li key={event.id}>
                <code>{event.event_type}</code>
                <time>{new Date(event.created_at).toLocaleTimeString()}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

