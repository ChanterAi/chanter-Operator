import { useCallback, useEffect, useState, type FormEvent } from "react";
import { getAgentRunLedgerRun, listAgentRunLedgerRuns } from "../api/client";
import type {
  AgentRunLedgerEntry,
  AgentRunLedgerFilters,
  AgentRunLedgerRunDetail,
} from "../api/types";
import { StatusBadge } from "./StatusBadge";

interface FilterDraft {
  product: string;
  workflow: string;
  provider: string;
  model: string;
  status: string;
  approvalStatus: string;
  validationResult: string;
  outcome: string;
  from: string;
  to: string;
}

const EMPTY_FILTERS: FilterDraft = {
  product: "",
  workflow: "",
  provider: "",
  model: "",
  status: "",
  approvalStatus: "",
  validationResult: "",
  outcome: "",
  from: "",
  to: "",
};

const STATUSES = [
  "created",
  "approval_required",
  "approved",
  "running",
  "validating",
  "completed",
  "failed",
  "cancelled",
  "blocked",
  "reconciliation_required",
] as const;

function displayValue(value: string | null): string {
  return value || "not available";
}

function displayCost(entry: AgentRunLedgerEntry): string {
  const cost = entry.cost_estimate;
  if (cost.kind !== "known" || cost.amount_micros === null || !cost.currency) {
    return cost.kind.replaceAll("_", " ");
  }
  return `${(cost.amount_micros / 1_000_000).toFixed(6)} ${cost.currency}`;
}

function displayLatency(value: number | null): string {
  return value === null ? "unknown" : `${value} ms`;
}

function toFilters(draft: FilterDraft): AgentRunLedgerFilters {
  return {
    ...(draft.product ? { product: draft.product } : {}),
    ...(draft.workflow ? { workflow: draft.workflow } : {}),
    ...(draft.provider ? { provider: draft.provider } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.status ? { status: draft.status as AgentRunLedgerFilters["status"] } : {}),
    ...(draft.approvalStatus ? { approvalStatus: draft.approvalStatus as AgentRunLedgerFilters["approvalStatus"] } : {}),
    ...(draft.validationResult ? { validationResult: draft.validationResult as AgentRunLedgerFilters["validationResult"] } : {}),
    ...(draft.outcome ? { outcome: draft.outcome as AgentRunLedgerFilters["outcome"] } : {}),
    ...(draft.from ? { from: draft.from } : {}),
    ...(draft.to ? { to: draft.to } : {}),
    limit: 50,
  };
}

export function AgentRunLedgerPanel() {
  const [draft, setDraft] = useState<FilterDraft>(EMPTY_FILTERS);
  const [runs, setRuns] = useState<AgentRunLedgerEntry[]>([]);
  const [detail, setDetail] = useState<AgentRunLedgerRunDetail | null>(null);
  const [selectedRunId, setSelectedRunId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const selectRun = useCallback(async (runId: string) => {
    setSelectedRunId(runId);
    setDetail(null);
    setError("");
    try {
      setDetail(await getAgentRunLedgerRun(runId));
    } catch (reason) {
      setDetail(null);
      setError(reason instanceof Error ? reason.message : "Could not load the selected ledger run.");
    }
  }, []);

  const loadRuns = useCallback(async (filters: AgentRunLedgerFilters = {}) => {
    setLoading(true);
    setError("");
    try {
      const result = await listAgentRunLedgerRuns(filters);
      setRuns(result.runs);
      const nextRun = result.runs[0];
      if (nextRun) {
        await selectRun(nextRun.run_id);
      } else {
        setSelectedRunId("");
        setDetail(null);
      }
    } catch (reason) {
      setRuns([]);
      setDetail(null);
      setSelectedRunId("");
      setError(reason instanceof Error ? reason.message : "Could not load Agent Run Ledger runs.");
    } finally {
      setLoading(false);
    }
  }, [selectRun]);

  useEffect(() => {
    void loadRuns({ limit: 50 });
  }, [loadRuns]);

  function updateFilter(name: keyof FilterDraft, value: string): void {
    setDraft((current) => ({ ...current, [name]: value }));
  }

  function applyFilters(event: FormEvent): void {
    event.preventDefault();
    void loadRuns(toFilters(draft));
  }

  function clearFilters(): void {
    setDraft(EMPTY_FILTERS);
    void loadRuns({ limit: 50 });
  }

  const entry = detail?.entry ?? null;
  const transitions = detail?.transitions ?? [];

  return (
    <main id="agent-run-ledger" className="agent-ledger-page" aria-labelledby="agent-ledger-heading">
      <header className="agent-ledger-page__header">
        <div>
          <p className="eyebrow">Durable supervision</p>
          <h1 id="agent-ledger-heading">Agent Run Ledger</h1>
          <p>Read-only SQLite truth for canonical, versioned agent lifecycles.</p>
        </div>
        <div className="agent-ledger-readonly" role="note">
          <strong>Read-only surface</strong>
          <span>No create, edit, approval, retry, or execution controls.</span>
        </div>
      </header>

      {error && <div className="error-banner agent-ledger-error" role="alert">{error}</div>}

      <form className="agent-ledger-filters" onSubmit={applyFilters} aria-label="Agent Run Ledger filters">
        <label>Product<input value={draft.product} onChange={(event) => updateFilter("product", event.target.value)} /></label>
        <label>Workflow<input value={draft.workflow} onChange={(event) => updateFilter("workflow", event.target.value)} /></label>
        <label>Provider<input value={draft.provider} onChange={(event) => updateFilter("provider", event.target.value)} /></label>
        <label>Model<input value={draft.model} onChange={(event) => updateFilter("model", event.target.value)} /></label>
        <label>Status<select value={draft.status} onChange={(event) => updateFilter("status", event.target.value)}><option value="">All</option>{STATUSES.map((value) => <option key={value} value={value}>{value.replaceAll("_", " ")}</option>)}</select></label>
        <label>Approval<select value={draft.approvalStatus} onChange={(event) => updateFilter("approvalStatus", event.target.value)}><option value="">All</option><option value="not_required">not required</option><option value="required">required</option><option value="approved">approved</option><option value="rejected">rejected</option></select></label>
        <label>Validation<select value={draft.validationResult} onChange={(event) => updateFilter("validationResult", event.target.value)}><option value="">All</option><option value="not_run">not run</option><option value="passed">passed</option><option value="failed">failed</option></select></label>
        <label>Outcome<select value={draft.outcome} onChange={(event) => updateFilter("outcome", event.target.value)}><option value="">All</option><option value="pending">pending</option><option value="success">success</option><option value="failure">failure</option><option value="cancelled">cancelled</option><option value="blocked">blocked</option><option value="reconciliation_required">reconciliation required</option></select></label>
        <label>From UTC<input placeholder="2026-07-14T00:00:00.000Z" value={draft.from} onChange={(event) => updateFilter("from", event.target.value)} /></label>
        <label>To UTC<input placeholder="2026-07-14T23:59:59.999Z" value={draft.to} onChange={(event) => updateFilter("to", event.target.value)} /></label>
        <div className="agent-ledger-filters__actions">
          <button className="button button--primary" type="submit" disabled={loading}>Apply filters</button>
          <button className="button" type="button" disabled={loading} onClick={clearFilters}>Clear filters</button>
          <button className="button" type="button" disabled={loading} onClick={() => void loadRuns(toFilters(draft))}>Refresh</button>
        </div>
      </form>

      <div className="agent-ledger-layout">
        <section className="agent-ledger-card agent-ledger-list" aria-labelledby="agent-ledger-runs-heading">
          <div className="panel__heading">
            <div><p className="eyebrow">Authoritative summaries</p><h2 id="agent-ledger-runs-heading">Runs</h2></div>
            <span className="count">{runs.length}</span>
          </div>
          {loading ? (
            <p className="agent-ledger-empty" role="status">Loading ledger runs...</p>
          ) : runs.length === 0 ? (
            <p className="agent-ledger-empty">No runs match the exact filters.</p>
          ) : (
            <ul>
              {runs.map((run) => (
                <li key={run.run_id}>
                  <button
                    type="button"
                    className={"agent-ledger-list__button" + (selectedRunId === run.run_id ? " agent-ledger-list__button--selected" : "")}
                    aria-pressed={selectedRunId === run.run_id}
                    onClick={() => void selectRun(run.run_id)}
                  >
                    <span>{run.product_id} / {run.workflow_id}</span>
                    <strong>{run.run_id}</strong>
                    <small>{run.provider} / {run.model} · {run.status}</small>
                    {run.failure_reason && <small className="agent-ledger-list__failure">{run.failure_reason}</small>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="agent-ledger-card agent-ledger-detail" aria-labelledby="agent-ledger-detail-heading">
          <div className="panel__heading">
            <div><p className="eyebrow">Exact run truth</p><h2 id="agent-ledger-detail-heading">Run detail</h2></div>
          </div>
          {!entry ? (
            <p className="agent-ledger-empty">Select a run to inspect its canonical scope and history.</p>
          ) : (
            <div className="agent-ledger-detail__content">
              <div className="agent-ledger-status-row">
                <StatusBadge status={entry.status} />
                <span>Outcome: {entry.outcome.replaceAll("_", " ")}</span>
                <span>Schema {entry.schema_version}</span>
              </div>

              {entry.failure_reason && (
                <div className="agent-ledger-failure" role="alert">
                  <strong>{displayValue(entry.failure_code)}</strong>
                  <span>{entry.failure_reason}</span>
                </div>
              )}

              <section aria-labelledby="agent-ledger-scope-heading">
                <h3 id="agent-ledger-scope-heading">Execution scope</h3>
                <dl className="agent-ledger-grid">
                  <div><dt>Run ID</dt><dd><code>{entry.run_id}</code></dd></div>
                  <div><dt>Event / sequence</dt><dd><code>{entry.event_id}</code> / {entry.sequence}</dd></div>
                  <div><dt>Product / workflow</dt><dd>{entry.product_id} / {entry.workflow_id}</dd></div>
                  <div><dt>Agent / attempt</dt><dd>{entry.agent_id} / <code>{entry.attempt_id}</code></dd></div>
                  <div><dt>Parent run</dt><dd>{displayValue(entry.parent_run_id)}</dd></div>
                  <div><dt>Trace</dt><dd>{displayValue(entry.trace_id)}</dd></div>
                  <div><dt>Provider / model</dt><dd>{entry.provider} / {entry.model}</dd></div>
                  <div><dt>Source</dt><dd>{entry.source_subsystem}</dd></div>
                </dl>
                <p className="agent-ledger-input-summary">{entry.input_summary}</p>
              </section>

              <section aria-labelledby="agent-ledger-governance-heading">
                <h3 id="agent-ledger-governance-heading">Governance and validation</h3>
                <dl className="agent-ledger-grid">
                  <div><dt>Approval</dt><dd>{entry.approval_status.replaceAll("_", " ")}</dd></div>
                  <div><dt>Approval actor</dt><dd>{displayValue(entry.approval_actor)}</dd></div>
                  <div><dt>Approval time</dt><dd>{displayValue(entry.approval_timestamp)}</dd></div>
                  <div><dt>Risk / production</dt><dd>{entry.risk_level} / {entry.production_impact ? "yes" : "no"}</dd></div>
                  <div><dt>Validation</dt><dd>{entry.validation_result.replaceAll("_", " ")}</dd></div>
                  <div><dt>Latency</dt><dd>{displayLatency(entry.latency_ms)}</dd></div>
                  <div><dt>Cost estimate</dt><dd>{displayCost(entry)}</dd></div>
                  <div><dt>Evidence</dt><dd>{entry.evidence_count} / {entry.evidence_integrity_status.replaceAll("_", " ")}</dd></div>
                </dl>
                <p>{displayValue(entry.validation_summary)}</p>
              </section>

              <section aria-labelledby="agent-ledger-actions-heading">
                <h3 id="agent-ledger-actions-heading">Actions and tools</h3>
                {entry.actions_taken.length === 0 ? <p>None recorded.</p> : <ul>{entry.actions_taken.map((action) => <li key={action.action_id}><strong>{action.action_type}</strong> — {action.summary} ({action.outcome})</li>)}</ul>}
                {entry.tools_used.length === 0 ? <p>No tools recorded.</p> : <ul>{entry.tools_used.map((tool) => <li key={tool.tool_id}>{tool.name} {tool.version ?? "version unknown"}</li>)}</ul>}
              </section>

              <section aria-labelledby="agent-ledger-evidence-heading">
                <h3 id="agent-ledger-evidence-heading">Evidence references</h3>
                {entry.evidence_refs.length === 0 ? <p>No evidence recorded.</p> : <ul>{entry.evidence_refs.map((evidence) => <li key={evidence.evidence_id}><strong>{evidence.kind}</strong> <code>{evidence.uri}</code><span>{evidence.sha256 ? `SHA-256 ${evidence.sha256}` : "hash unavailable"}</span></li>)}</ul>}
              </section>

              <section aria-labelledby="agent-ledger-integrity-heading">
                <h3 id="agent-ledger-integrity-heading">Integrity and timestamps</h3>
                <dl className="agent-ledger-grid">
                  <div><dt>Payload hash</dt><dd><code>{entry.payload_hash}</code></dd></div>
                  <div><dt>Scope hash</dt><dd><code>{entry.scope_hash}</code></dd></div>
                  <div><dt>Started</dt><dd>{entry.started_at}</dd></div>
                  <div><dt>Completed</dt><dd>{displayValue(entry.completed_at)}</dd></div>
                  <div><dt>Created</dt><dd>{entry.created_at}</dd></div>
                  <div><dt>Updated</dt><dd>{entry.updated_at}</dd></div>
                </dl>
              </section>

              <section aria-labelledby="agent-ledger-history-heading">
                <h3 id="agent-ledger-history-heading">Ordered transition history</h3>
                <ol className="agent-ledger-history">
                  {transitions.map((transition) => (
                    <li key={transition.event_id}>
                      <strong>{transition.sequence}. {transition.status.replaceAll("_", " ")}</strong>
                      <span>{transition.updated_at}</span>
                      <code>{transition.event_id}</code>
                    </li>
                  ))}
                </ol>
              </section>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
