import type { TaskDetail } from "../api/types";
import { StatusBadge } from "./StatusBadge";

export function TaskDetailPanel({ detail }: { detail: TaskDetail | null }) {
  if (!detail) {
    return (
      <main className="panel panel--detail panel--empty">
        <div className="empty-state empty-state--large">Create or select a task to inspect its execution plan.</div>
      </main>
    );
  }

  const step = detail.steps[0];
  const evidence = detail.evidence[0];

  return (
    <main className="panel panel--detail">
      <div className="panel__heading panel__heading--detail">
        <div>
          <p className="eyebrow">Selected task</p>
          <h1>{detail.task.parsed_description}</h1>
        </div>
        <StatusBadge status={detail.task.status} />
      </div>

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

      <section className="detail-section output-section">
        <h3>Runner output</h3>
        <pre className={!evidence ? "muted-output" : ""}>
          {evidence?.stdout || "Runner output will appear after an approved step executes."}
          {evidence?.stderr ? `\n\nSTDERR\n${evidence.stderr}` : ""}
        </pre>
      </section>

      <section className="detail-section">
        <h3>Diff viewer</h3>
        <pre className={!evidence?.diff ? "muted-output" : "diff-output"}>
          {evidence?.diff || "No diff was produced for this step."}
        </pre>
      </section>
    </main>
  );
}

