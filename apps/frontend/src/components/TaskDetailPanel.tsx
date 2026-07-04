import type { TaskDetail } from "../api/types";
import { recommendNextAction } from "../api/types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  detail: TaskDetail | null;
  loading: boolean;
  error: string;
}

export function TaskDetailPanel({ detail, loading, error }: Props) {
  if (loading) {
    return (
      <main aria-busy="true" className="panel panel--detail panel--empty">
        <div className="state-message state-message--large" role="status">Loading task evidence...</div>
      </main>
    );
  }

  if (error) {
    return (
      <main className="panel panel--detail panel--empty">
        <div className="state-message state-message--error state-message--large" role="alert">{error}</div>
      </main>
    );
  }

  if (!detail) {
    return (
      <main className="panel panel--detail panel--empty">
        <div className="empty-state empty-state--large">Create or select a task to inspect its execution plan.</div>
      </main>
    );
  }

  const step = detail.steps[0];
  const evidence = detail.evidence[0];
  const recommendation = recommendNextAction(detail);

  return (
    <main className="panel panel--detail">
      <div className="panel__heading panel__heading--detail">
        <div>
          <p className="eyebrow">Selected task &mdash; {detail.task.product_lane}</p>
          <h1>{detail.task.parsed_description}</h1>
        </div>
        <StatusBadge status={detail.task.status} />
      </div>

      {/* Agent / mode framing */}
      <section className="detail-section agent-frame">
        <div className="agent-frame__row">
          <div className="agent-frame__item">
            <dt>Runner</dt>
            <dd>Mock Adapter</dd>
          </div>
          <div className="agent-frame__item">
            <dt>Mode</dt>
            <dd>Safe / Review-only</dd>
          </div>
          <div className="agent-frame__item">
            <dt>Execution</dt>
            <dd>Contained Simulation</dd>
          </div>
        </div>
      </section>

      {/* Recommended next action */}
      <section className="detail-section recommendation-bar">
        <div className="recommendation-bar__content">
          <span className="recommendation-bar__label">Recommended next action</span>
          <span className={`recommendation-bar__value recommendation-bar__value--${recommendation.toLowerCase().replace(/[^a-z]+/g, "-")}`}>
            {recommendation}
          </span>
        </div>
      </section>

      {step && (
        <section className="detail-section">
          <div className="section-title">
            <h3>Execution step {step.step_number}</h3>
            <StatusBadge status={step.status} />
          </div>
          <dl className="metadata-grid">
            <div><dt>Action</dt><dd>{step.action_type.replaceAll("_", " ")}</dd></div>
            <div><dt>Approval</dt><dd>{step.requires_approval ? "Required" : "Not required"}</dd></div>
            <div><dt>Runner</dt><dd>Mock adapter</dd></div>
            <div><dt>Execution</dt><dd>Contained simulation</dd></div>
          </dl>
          <h4>Action preview</h4>
          <pre>{JSON.stringify(step.action_payload, null, 2)}</pre>
        </section>
      )}

      <section className="detail-section evidence-overview">
        <div className="section-title">
          <h3>Evidence summary</h3>
          {evidence && (
            <span className={evidence.validation_passed ? "validation-label validation-label--pass" : "validation-label validation-label--fail"}>
              {evidence.validation_passed ? "Passed" : "Failed"}
            </span>
          )}
        </div>
        {evidence ? (
          <>
            <p className="evidence-note">Deterministic mock evidence only. No command, file write, model, or network operation was performed.</p>
            <dl className="evidence-facts">
              <div><dt>Exit code</dt><dd>{evidence.exit_code}</dd></div>
              <div><dt>Recorded</dt><dd>{new Date(evidence.created_at).toLocaleString()}</dd></div>
              <div><dt>Diff artifact</dt><dd>{evidence.diff ? "Mock preview" : "None"}</dd></div>
            </dl>
            <p className="validation-summary">{evidence.validation_summary}</p>
          </>
        ) : (
          <p className="muted evidence-note">No evidence has been recorded. Pending steps produce evidence only after approval and mock simulation.</p>
        )}
      </section>

      <section className="detail-section output-section">
        <h3>Mock standard output</h3>
        <pre className={!evidence ? "muted-output" : ""}>
          {evidence?.stdout || "Runner output will appear after an approved step executes."}
        </pre>
      </section>

      <section className="detail-section">
        <h3>Mock standard error</h3>
        <pre className={!evidence?.stderr ? "muted-output" : ""}>
          {evidence?.stderr || "No error output was recorded."}
        </pre>
      </section>

      <section className="detail-section">
        <h3>Mock diff preview</h3>
        <pre className={!evidence?.diff ? "muted-output" : "diff-output"}>
          {evidence?.diff || "No diff was produced for this step."}
        </pre>
      </section>
    </main>
  );
}
