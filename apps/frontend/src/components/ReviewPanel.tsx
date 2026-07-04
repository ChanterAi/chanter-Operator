import { useState } from "react";
import type { TaskDetail } from "../api/types";
import { canCancelTask, canRetryTask, recommendNextAction } from "../api/types";
import type { ValidationEvidence } from "../api/types";

interface Props {
  detail: TaskDetail | null;
  busy: boolean;
  decision?: "approving" | "rejecting";
  cancelDecision?: "cancelling";
  retryDecision?: "retrying";
  onApprove: (stepId: string) => Promise<void>;
  onReject: (stepId: string) => Promise<void>;
  onCancel: (taskId: string) => Promise<void>;
  onRetry: (taskId: string) => Promise<void>;
  onAddValidation: (taskId: string, commandLabel: string, status: string, output: string) => Promise<void>;
}

export function ReviewPanel({ detail, busy, decision, cancelDecision, retryDecision, onApprove, onReject, onCancel, onRetry, onAddValidation }: Props) {
  const step = detail?.steps[0];
  const pending = step?.status === "pending_approval";
  const recommendation = detail ? recommendNextAction(detail) : null;
  const showCancel = detail ? canCancelTask(detail.task.status) : false;
  const showRetry = detail ? canRetryTask(detail.task.status) : false;

  // Manual validation form state
  const [valLabel, setValLabel] = useState("");
  const [valStatus, setValStatus] = useState<string>("passed");
  const [valOutput, setValOutput] = useState("");
  const [addingEvidence, setAddingEvidence] = useState(false);

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

      {/* Recommended next action */}
      {recommendation && (
        <section className="review-section review-section--recommendation">
          <h3>Next action</h3>
          <p className="recommendation-text">{recommendation}</p>
        </section>
      )}

      {/* Lifecycle controls */}
      {(showCancel || showRetry) && (
        <section className="review-section review-section--lifecycle">
          <h3>Lifecycle</h3>
          <div className="lifecycle-actions">
            {showCancel && (
              <button
                aria-busy={cancelDecision === "cancelling"}
                className="button button--lifecycle button--lifecycle-cancel"
                disabled={busy}
                onClick={() => onCancel(detail!.task.id)}
                type="button"
              >
                {cancelDecision === "cancelling" ? "Cancelling..." : "Cancel task"}
              </button>
            )}
            {showRetry && (
              <button
                aria-busy={retryDecision === "retrying"}
                className="button button--lifecycle button--lifecycle-retry"
                disabled={busy}
                onClick={() => onRetry(detail!.task.id)}
                type="button"
              >
                {retryDecision === "retrying" ? "Retrying..." : "Retry task"}
              </button>
            )}
          </div>
        </section>
      )}

      <section className="review-section">
        <h3>Approval</h3>
        {pending && step ? (
          <>
            <p>This simulated <strong>{step.action_type.replaceAll("_", " ")}</strong> step requires explicit approval.</p>
            <div className="approval-actions">
              <button aria-busy={decision === "approving"} className="button button--primary" disabled={busy} onClick={() => onApprove(step.id)} type="button">
                {decision === "approving" ? "Approving..." : "Approve & simulate"}
              </button>
              <button aria-busy={decision === "rejecting"} className="button button--danger" disabled={busy} onClick={() => onReject(step.id)} type="button">
                {decision === "rejecting" ? "Rejecting..." : "Reject"}
              </button>
            </div>
          </>
        ) : (
          <p className="muted">
            {detail
              ? recommendation === "Task complete"
                ? "Task is complete. No further action needed."
                : recommendation === "Rejected"
                  ? "Task was rejected. No further action is available."
                  : recommendation === "Cancelled"
                    ? "Task was cancelled. No further action is available."
                    : recommendation === "Retry available"
                      ? "Task can be retried. Use the lifecycle controls above."
                      : recommendation === "Blocked / invalid"
                        ? "Task is blocked. Review the evidence and audit trail."
                        : "No approval decision is pending."
              : "Select a task to review its gate."}
          </p>
        )}
      </section>

      <section className="review-section review-section--manual-validation">
        <h3>Manual validation</h3>
        <p className="evidence-disclaimer">Manual evidence only — no command is run.</p>

        <form
          className="manual-validation-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!detail) return;
            setAddingEvidence(true);
            try {
              await onAddValidation(detail.task.id, valLabel, valStatus, valOutput);
              setValLabel("");
              setValOutput("");
            } finally {
              setAddingEvidence(false);
            }
          }}
        >
          <div className="manual-validation-form__fields">
            <input
              className="input input--compact"
              disabled={busy || addingEvidence}
              maxLength={200}
              onChange={(e) => setValLabel(e.target.value)}
              placeholder="e.g. npm test, npm run build, git diff --check"
              required
              type="text"
              value={valLabel}
            />
            <select
              className="input input--compact"
              disabled={busy || addingEvidence}
              onChange={(e) => setValStatus(e.target.value)}
              value={valStatus}
            >
              <option value="passed">Passed</option>
              <option value="failed">Failed</option>
              <option value="warning">Warning</option>
              <option value="not_run">Not run</option>
            </select>
            <button
              className="button button--primary button--compact"
              disabled={busy || addingEvidence}
              type="submit"
            >
              {addingEvidence ? "Adding..." : "Add evidence"}
            </button>
          </div>
          <textarea
            className="input input--textarea input--compact"
            disabled={busy || addingEvidence}
            maxLength={10000}
            onChange={(e) => setValOutput(e.target.value)}
            placeholder="Paste command output or summary..."
            rows={3}
            value={valOutput}
          />
        </form>

        {detail?.validation_evidence && detail.validation_evidence.length > 0 && (
          <ul className="validation-list">
            {detail.validation_evidence.map((ve: ValidationEvidence) => (
              <li key={ve.id} className="validation-item">
                <span className={`validation-status validation-status--${ve.status}`}>
                  {ve.status === "passed" ? "Pass" : ve.status === "failed" ? "Fail" : ve.status === "warning" ? "Warn" : "Not run"}
                </span>
                <code className="validation-label-text">{ve.command_label}</code>
                {ve.output && (
                  <pre className="validation-output">{ve.output.slice(0, 500)}{ve.output.length > 500 ? "..." : ""}</pre>
                )}
                <time>{new Date(ve.created_at).toLocaleString()}</time>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section">
        <div className="review-section__title"><h3>Evidence timeline</h3><span>{detail?.evidence.length ?? 0}</span></div>
        <p className="evidence-disclaimer">All P0.2 evidence is generated by the contained deterministic mock runner.</p>
        {!detail?.evidence.length ? <p className="muted">No mock evidence recorded.</p> : (
          <ol className="timeline">
            {detail.evidence.map((evidence) => (
              <li key={evidence.id}>
                <span className={evidence.validation_passed ? "timeline__marker timeline__marker--pass" : "timeline__marker timeline__marker--fail"} />
                <div>
                  <strong>{evidence.validation_passed ? "Mock validation passed" : "Mock validation failed"}</strong>
                  <p>{evidence.validation_summary}</p>
                  <div className="evidence-tags">
                    <span>Exit {evidence.exit_code}</span>
                    <span>{evidence.diff ? "Diff preview" : "No diff"}</span>
                  </div>
                  <time>{new Date(evidence.created_at).toLocaleString()}</time>
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
