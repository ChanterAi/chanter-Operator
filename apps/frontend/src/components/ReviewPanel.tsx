import { useEffect, useState } from "react";
import type { TaskDetail } from "../api/types";
import { canCancelTask, canRetryTask, recommendNextAction } from "../api/types";
import { fetchEvidenceBundle, previewRunnerPolicy } from "../api/client";
import type { CommitReview, EvidenceBundleResponse, RunnerPolicyPreview, ValidationEvidence } from "../api/types";

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
  onAddCommitReview: (taskId: string, summaryText: string, changedFilesText: string, validationText: string, riskNotesText: string) => Promise<void>;
  onEvidenceBundleGenerated?: (bundle: EvidenceBundleResponse) => void;
  onPolicyPreviewGenerated?: (result: TaskDetail) => void;
}

export function ReviewPanel({ detail, busy, decision, cancelDecision, retryDecision, onApprove, onReject, onCancel, onRetry, onAddValidation, onAddCommitReview, onEvidenceBundleGenerated, onPolicyPreviewGenerated }: Props) {
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

  // Commit review form state
  const [crSummary, setCrSummary] = useState("");
  const [crFiles, setCrFiles] = useState("");
  const [crValidation, setCrValidation] = useState("");
  const [crRisk, setCrRisk] = useState("");
  const [addingCommitReview, setAddingCommitReview] = useState(false);

  // Evidence bundle state
  const [bundleResult, setBundleResult] = useState<EvidenceBundleResponse | null>(null);
  const [generatingBundle, setGeneratingBundle] = useState(false);
  const [bundleError, setBundleError] = useState("");
  const [copied, setCopied] = useState(false);

  // Runner policy preview state
  const [policyCommand, setPolicyCommand] = useState("");
  const [policyPurpose, setPolicyPurpose] = useState("");
  const [previewingPolicy, setPreviewingPolicy] = useState(false);
  const [policyError, setPolicyError] = useState("");
  // Clear stale bundle when selected task changes
  useEffect(() => {
    setBundleResult(null);
    setBundleError("");
    setCopied(false);
  }, [detail?.task.id]);

  // Only show bundle if it matches the currently selected task
  const currentBundle = bundleResult?.taskId === detail?.task.id ? bundleResult : null;

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

      <section className="review-section review-section--policy-preview">
        <h3>Runner policy preview</h3>
        <p className="evidence-disclaimer">Policy preview only — no command is run.</p>

        <form
          className="policy-preview-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!detail) return;
            setPreviewingPolicy(true);
            setPolicyError("");
            try {
              const result = await previewRunnerPolicy(detail.task.id, policyCommand, policyPurpose);
              onPolicyPreviewGenerated?.(result);
              setPolicyCommand("");
              setPolicyPurpose("");
            } catch (err: any) {
              setPolicyError(err.message || "Failed to preview policy");
            } finally {
              setPreviewingPolicy(false);
            }
          }}
        >
          <input
            className="input input--compact"
            disabled={busy || previewingPolicy}
            maxLength={1000}
            onChange={(e) => setPolicyCommand(e.target.value)}
            placeholder="e.g. git status --short, npm test..."
            required
            type="text"
            value={policyCommand}
          />
          <input
            className="input input--compact"
            disabled={busy || previewingPolicy}
            maxLength={2000}
            onChange={(e) => setPolicyPurpose(e.target.value)}
            placeholder="Purpose (e.g. check working tree before commit)"
            type="text"
            value={policyPurpose}
          />
          <button
            className="button button--primary button--compact"
            disabled={busy || previewingPolicy}
            type="submit"
          >
            {previewingPolicy ? "Checking..." : "Preview policy"}
          </button>
        </form>
        {policyError && <p className="error-text">{policyError}</p>}

        {detail?.runner_policy_previews && detail.runner_policy_previews.length > 0 && (
          <div className="policy-preview-list">
            {detail.runner_policy_previews.map((pp: RunnerPolicyPreview) => (
              <div key={pp.id} className={`policy-preview-card policy-preview-card--${pp.verdict}`}>
                <div className="policy-preview-card__header">
                  <span className={`verdict-badge verdict-badge--${pp.verdict}`}>
                    {pp.verdict === "allowed_readonly" ? "✅ ALLOWED (READ-ONLY)" : pp.verdict === "requires_approval" ? "⚠️ REQUIRES APPROVAL" : "⛔ BLOCKED"}
                  </span>
                  <time>{new Date(pp.created_at).toLocaleString()}</time>
                </div>
                <code className="validation-label-text">{pp.proposed_command}</code>
                {pp.reasons.length > 0 && (
                  <ul className="verdict-reasons">
                    {pp.reasons.map((r, i) => (
                      <li key={i} className="verdict-reason-item">{r}</li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="review-section review-section--evidence-bundle">
        <h3>Evidence bundle</h3>
        <p className="evidence-disclaimer">Evidence bundle only — no command is run.</p>

        <div className="evidence-bundle-controls">
          <button
            className="button button--primary button--compact"
            disabled={!detail || busy || generatingBundle}
            onClick={async () => {
              if (!detail) return;
              setGeneratingBundle(true);
              setBundleError("");
              try {
                const result = await fetchEvidenceBundle(detail.task.id);
                setBundleResult(result);
                onEvidenceBundleGenerated?.(result);
              } catch (err: any) {
                setBundleError(err.message || "Failed to generate bundle");
              } finally {
                setGeneratingBundle(false);
              }
            }}
          >
            {generatingBundle ? "Generating..." : "Generate evidence bundle"}
          </button>
          {currentBundle && (
            <button
              className="button button--compact"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(currentBundle.markdown);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  setBundleError("Clipboard not available");
                }
              }}
            >
              {copied ? "Copied!" : "Copy bundle"}
            </button>
          )}
        </div>
        {bundleError && <p className="error-text">{bundleError}</p>}
        {currentBundle && (
          <textarea
            className="input input--textarea input--compact evidence-bundle-textarea"
            readOnly
            rows={16}
            value={currentBundle.markdown}
          />
        )}
      </section>

      <section className="review-section review-section--commit-review">
        <h3>Safe commit review intake</h3>
        <p className="evidence-disclaimer">Manual review only — no git command is run.</p>

        <form
          className="commit-review-form"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!detail) return;
            setAddingCommitReview(true);
            try {
              await onAddCommitReview(detail.task.id, crSummary, crFiles, crValidation, crRisk);
              setCrSummary("");
              setCrFiles("");
              setCrValidation("");
              setCrRisk("");
            } finally {
              setAddingCommitReview(false);
            }
          }}
        >
          <textarea
            className="input input--textarea input--compact"
            disabled={busy || addingCommitReview}
            maxLength={10000}
            onChange={(e) => setCrSummary(e.target.value)}
            placeholder="Paste implementation report / summary..."
            rows={3}
            value={crSummary}
          />
          <textarea
            className="input input--textarea input--compact"
            disabled={busy || addingCommitReview}
            maxLength={10000}
            onChange={(e) => setCrFiles(e.target.value)}
            placeholder="Paste changed files summary..."
            rows={2}
            value={crFiles}
          />
          <textarea
            className="input input--textarea input--compact"
            disabled={busy || addingCommitReview}
            maxLength={10000}
            onChange={(e) => setCrValidation(e.target.value)}
            placeholder="Paste validation results..."
            rows={2}
            value={crValidation}
          />
          <textarea
            className="input input--textarea input--compact"
            disabled={busy || addingCommitReview}
            maxLength={10000}
            onChange={(e) => setCrRisk(e.target.value)}
            placeholder="Risk notes (optional)..."
            rows={2}
            value={crRisk}
          />
          <button
            className="button button--primary button--compact"
            disabled={busy || addingCommitReview}
            type="submit"
          >
            {addingCommitReview ? "Analyzing..." : "Submit review"}
          </button>
        </form>

        {detail?.commit_reviews && detail.commit_reviews.length > 0 && (
          <div className="commit-review-list">
            {detail.commit_reviews.map((cr: CommitReview) => (
              <div key={cr.id} className={`commit-review-card commit-review-card--${cr.verdict}`}>
                <div className="commit-review-card__header">
                  <span className={`verdict-badge verdict-badge--${cr.verdict}`}>
                    {cr.verdict === "blocked" ? "⛔ BLOCKED" : cr.verdict === "needs_review" ? "⚠️ NEEDS REVIEW" : "✅ SAFE TO REVIEW"}
                  </span>
                  <time>{new Date(cr.created_at).toLocaleString()}</time>
                </div>
                {cr.reasons.length > 0 && (
                  <ul className="verdict-reasons">
                    {cr.reasons.map((r, i) => (
                      <li key={i} className="verdict-reason-item">{r}</li>
                    ))}
                  </ul>
                )}
                {cr.summary_text && (
                  <details className="review-detail">
                    <summary>Summary ({cr.summary_text.length} chars)</summary>
                    <pre className="validation-output">{cr.summary_text.slice(0, 500)}{cr.summary_text.length > 500 ? "..." : ""}</pre>
                  </details>
                )}
                {cr.changed_files_text && (
                  <details className="review-detail">
                    <summary>Changed files ({cr.changed_files_text.length} chars)</summary>
                    <pre className="validation-output">{cr.changed_files_text.slice(0, 500)}{cr.changed_files_text.length > 500 ? "..." : ""}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
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
