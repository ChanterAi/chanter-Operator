import { useCallback, useEffect, useMemo, useState } from "react";
import {
  acknowledgeObservationEscalation,
  approveMissionGraph,
  cancelMissionGraph,
  fetchHealth,
  generateMissionGraphEvidence,
  getMissionGraph,
  getAutoPosterResults,
  listMissionGraphs,
  listObservationEscalations,
  listObservationJobs,
  refreshAutoPosterResults,
  resolveObservationEscalation,
  resumeMissionGraph,
  runObservationBatch,
} from "../api/client";
import type {
  AutoPosterObservationEscalationView,
  AutoPosterObservationJobView,
  AutoPosterResultProjectionsResponse,
  HealthResponse,
  MissionGraphEvidenceResult,
  MissionGraphNodeView,
  MissionGraphView,
} from "../api/types";

type Operation =
  | "loading"
  | "loading-detail"
  | "approving"
  | "resuming"
  | "cancelling"
  | "refreshing-results"
  | "generating-evidence"
  | "running-observation"
  | "acknowledging"
  | "resolving";

const TERMINAL_GRAPH_STATES = new Set(["completed", "failed_terminal", "cancelled"]);

function humanize(value: string | null | undefined): string {
  if (!value) return "—";
  return value.replaceAll("_", " ");
}

function graphStatusClass(status: string): string {
  if (status === "completed") return "succeeded";
  if (status === "failed_terminal") return "failed";
  if (status === "failed_recoverable") return "executing";
  if (status === "cancelled") return "denied";
  if (status === "running") return "executing";
  return status;
}

function currentNode(graph: MissionGraphView): MissionGraphNodeView | null {
  const active = graph.nodes.find((node) => node.status === "running" || node.status === "ready");
  if (active) return active;
  const failed = graph.nodes.find(
    (node) => node.status === "failed_recoverable" || node.status === "failed_terminal",
  );
  return failed ?? graph.nodes[graph.nodes.length - 1] ?? null;
}

// The smallest safe next action a founder can take, derived only from durable
// state — never a fabricated recommendation.
function recommendedAction(
  graph: MissionGraphView,
  openEscalations: number,
  observationPending: boolean,
): string {
  if (graph.status === "approval_required") return "Review the exact request, then Approve to dispatch execution.";
  if (graph.status === "failed_recoverable") return "Resume safely, or Cancel if the mission should not continue.";
  if (graph.status === "failed_terminal") return "Terminal failure — inspect the node error and evidence; no safe retry.";
  if (graph.status === "cancelled") return "Cancelled — no further action.";
  if (openEscalations > 0) return "An observation escalation is open — acknowledge, then resolve it.";
  if (observationPending) return "Run the observation batch (or Refresh results) to collect the downstream outcome.";
  if (graph.status === "completed") return "Completed — generate or open the retained evidence bundle.";
  return "Monitor — execution is in progress.";
}

export function MissionWorkspacePanel() {
  const [graphs, setGraphs] = useState<MissionGraphView[]>([]);
  const [selectedGraphId, setSelectedGraphId] = useState<string | null>(null);
  const [graph, setGraph] = useState<MissionGraphView | null>(null);
  const [results, setResults] = useState<AutoPosterResultProjectionsResponse | null>(null);
  const [jobs, setJobs] = useState<AutoPosterObservationJobView[]>([]);
  const [escalations, setEscalations] = useState<AutoPosterObservationEscalationView[]>([]);
  const [allOpenEscalations, setAllOpenEscalations] = useState<number>(0);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [evidence, setEvidence] = useState<MissionGraphEvidenceResult | null>(null);

  const [operation, setOperation] = useState<Operation>();
  const [error, setError] = useState("");
  const [observationNote, setObservationNote] = useState("");

  const [approvedBy, setApprovedBy] = useState("");
  const [cancelledBy, setCancelledBy] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [escalationActor, setEscalationActor] = useState("");
  const [resolutionNote, setResolutionNote] = useState("");

  const busy = operation !== undefined;

  const loadDetail = useCallback(async (graphId: string) => {
    setOperation("loading-detail");
    setError("");
    setEvidence(null);
    try {
      const nextGraph = await getMissionGraph(graphId);
      setGraph(nextGraph);
    } catch (reason) {
      setGraph(null);
      setError(reason instanceof Error ? reason.message : "Could not load the mission graph.");
      setOperation(undefined);
      return;
    }
    // Each downstream read is independent: an unavailable projection or a
    // control-token-gated observation surface must not blank the whole graph.
    const [resultsOutcome, jobsOutcome, escalationsOutcome] = await Promise.allSettled([
      getAutoPosterResults(graphId),
      listObservationJobs(graphId),
      listObservationEscalations(graphId),
    ]);
    setResults(resultsOutcome.status === "fulfilled" ? resultsOutcome.value : null);
    setJobs(jobsOutcome.status === "fulfilled" ? jobsOutcome.value.jobs : []);
    setEscalations(escalationsOutcome.status === "fulfilled" ? escalationsOutcome.value.escalations : []);
    setObservationNote(
      jobsOutcome.status === "rejected"
        ? "Observation surface unavailable (Operator control capability not configured)."
        : "",
    );
    setOperation(undefined);
  }, []);

  const selectGraph = useCallback(
    (graphId: string) => {
      setSelectedGraphId(graphId);
      setApprovedBy("");
      setCancelledBy("");
      setCancelReason("");
      setEscalationActor("");
      setResolutionNote("");
      void loadDetail(graphId);
    },
    [loadDetail],
  );

  const refreshGraphList = useCallback(async () => {
    const nextGraphs = await listMissionGraphs();
    setGraphs(nextGraphs);
    return nextGraphs;
  }, []);

  useEffect(() => {
    setOperation("loading");
    setError("");
    void (async () => {
      const [graphsOutcome, healthOutcome, escalationsOutcome] = await Promise.allSettled([
        listMissionGraphs(),
        fetchHealth(),
        listObservationEscalations(),
      ]);
      if (graphsOutcome.status === "fulfilled") {
        setGraphs(graphsOutcome.value);
        const first = graphsOutcome.value[0];
        if (first) selectGraph(first.graphId);
      } else {
        setError(
          graphsOutcome.reason instanceof Error
            ? graphsOutcome.reason.message
            : "Could not load mission graphs.",
        );
      }
      setHealth(healthOutcome.status === "fulfilled" ? healthOutcome.value : null);
      setAllOpenEscalations(
        escalationsOutcome.status === "fulfilled"
          ? escalationsOutcome.value.escalations.filter((item) => item.status === "open").length
          : 0,
      );
      setOperation((current) => (current === "loading" ? undefined : current));
    })();
    // selectGraph is stable (useCallback); run once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runControl(next: Operation, action: () => Promise<unknown>): Promise<void> {
    if (busy || !selectedGraphId) return;
    setOperation(next);
    setError("");
    try {
      await action();
      await refreshGraphList();
      await loadDetail(selectedGraphId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The control action failed.");
      setOperation(undefined);
    }
  }

  const observationPending = useMemo(
    () => jobs.some((job) => !TERMINAL_GRAPH_STATES.has(job.status) && job.status !== "converged"),
    [jobs],
  );
  const openEscalations = escalations.filter((item) => item.status === "open").length;

  const autoposterConnected = health?.runtimeMissions?.autoposter?.configured ?? false;
  const publishingEnabled = health?.runtimeMissions?.autoposter?.publishingEnabled ?? false;

  const backlog = graphs.filter((item) => !TERMINAL_GRAPH_STATES.has(item.status)).length;
  const awaitingApproval = graphs.filter((item) => item.status === "approval_required").length;
  const lastCompleted = graphs.find((item) => item.status === "completed") ?? null;
  const lastFailed =
    graphs.find((item) => item.status === "failed_terminal" || item.status === "failed_recoverable") ?? null;

  return (
    <main className="mission-workspace" aria-labelledby="mission-workspace-heading">
      <header className="mission-workspace__header">
        <div>
          <p className="eyebrow">Operator control plane</p>
          <h1 id="mission-workspace-heading">Mission Workspace</h1>
          <p>
            One coherent surface for the durable mission-graph lifecycle: what is running, what
            completed, what failed, what is blocked, what needs approval, and the smallest safe next
            action.
          </p>
        </div>
        <div className="runtime-mission-safety" role="note">
          <strong>Read model + bounded controls</strong>
          <span>Every action routes through the independent Operator control authority; no publishing.</span>
        </div>
      </header>

      {/* §5.4 Health projection */}
      <section className="mission-health" aria-label="Operational health">
        <div className="mission-health__tile">
          <span className="mission-health__label">Runtime</span>
          <strong>{health ? (health.integrity.healthy ? "Healthy" : "Degraded") : "Unknown"}</strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Mission backlog</span>
          <strong>{backlog}</strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Awaiting approval</span>
          <strong>{awaitingApproval}</strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Open escalations</span>
          <strong className={allOpenEscalations > 0 ? "mission-health__alert" : undefined}>
            {allOpenEscalations}
          </strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Last completed</span>
          <strong>{lastCompleted ? lastCompleted.graphId.slice(0, 8) : "None"}</strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Last failed</span>
          <strong>{lastFailed ? lastFailed.graphId.slice(0, 8) : "None"}</strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">AutoPoster runtime</span>
          <strong className={autoposterConnected ? undefined : "mission-health__alert"}>
            {autoposterConnected ? "Connected" : "Unconfigured"}
          </strong>
        </div>
        <div className="mission-health__tile">
          <span className="mission-health__label">Publishing</span>
          <strong className={publishingEnabled ? "mission-health__alert" : undefined}>
            {publishingEnabled ? "ENABLED" : "Blocked"}
          </strong>
        </div>
      </section>

      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button onClick={() => setError("")} type="button" aria-label="Dismiss error">
            &times;
          </button>
        </div>
      )}

      <div className="mission-workspace__layout">
        {/* §5.1 Mission list */}
        <section className="mission-list-card" aria-labelledby="mission-list-heading">
          <div className="panel__heading">
            <div>
              <p className="eyebrow">Durable</p>
              <h2 id="mission-list-heading">Missions</h2>
            </div>
            <span className="count">{graphs.length}</span>
          </div>
          {operation === "loading" ? (
            <p className="runtime-mission-empty" role="status">
              Loading missions…
            </p>
          ) : graphs.length === 0 ? (
            <p className="runtime-mission-empty">No mission graphs yet.</p>
          ) : (
            <ul className="mission-list" aria-label="Mission graphs">
              {graphs.map((item) => {
                const node = currentNode(item);
                return (
                  <li key={item.graphId}>
                    <button
                      type="button"
                      className={
                        "mission-list__button" +
                        (item.graphId === selectedGraphId ? " mission-list__button--selected" : "")
                      }
                      onClick={() => selectGraph(item.graphId)}
                      disabled={busy}
                      aria-pressed={item.graphId === selectedGraphId}
                    >
                      <span className={`status status--${graphStatusClass(item.status)}`}>
                        <span className="status__dot" />
                        {humanize(item.status)}
                      </span>
                      <strong>{item.objective || item.graphId}</strong>
                      <small>
                        {item.nodeCount} atom{item.nodeCount === 1 ? "" : "s"}
                        {node ? ` · ${node.product}.${node.action}` : ""}
                        {item.approvedBy ? ` · approved by ${item.approvedBy}` : ""}
                      </small>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {/* §5.2 Mission detail + §5.3 controls */}
        <section className="mission-detail-card" aria-labelledby="mission-detail-heading">
          <div className="panel__heading">
            <div>
              <p className="eyebrow">Execution lineage</p>
              <h2 id="mission-detail-heading">Mission detail</h2>
            </div>
          </div>

          {!graph ? (
            <p className="runtime-mission-empty">
              {operation === "loading-detail" ? "Loading mission…" : "Select a mission to inspect it."}
            </p>
          ) : (
            <div className="mission-detail">
              <div className="mission-detail__status" aria-live="polite">
                <span className={`status status--${graphStatusClass(graph.status)}`}>
                  <span className="status__dot" />
                  {humanize(graph.status)}
                </span>
              </div>

              {/* Truth labels — only what the Operator can itself verify. The
                  Firestore mode (emulator vs real) is owned by AutoPoster and is
                  recorded authoritatively in the retained evidence bundle, not
                  claimed here. */}
              <div className="mission-truth-labels" aria-label="Proof truth labels">
                <span className={"truth-chip" + (autoposterConnected ? " truth-chip--ok" : " truth-chip--warn")}>
                  {autoposterConnected ? "Connected proof" : "Runtime unconfigured"}
                </span>
                <span className="truth-chip">Provider not contacted</span>
                <span className={"truth-chip" + (publishingEnabled ? " truth-chip--warn" : " truth-chip--ok")}>
                  {publishingEnabled ? "Publishing ENABLED" : "Public publishing blocked"}
                </span>
              </div>

              <p className="mission-detail__next" role="note">
                <strong>Smallest safe next action:</strong>{" "}
                {recommendedAction(graph, openEscalations, observationPending)}
              </p>

              <section className="mission-detail__section">
                <h3>Mission input</h3>
                <dl className="mission-kv">
                  <div><dt>Objective</dt><dd>{graph.objective}</dd></div>
                  <div><dt>Graph ID</dt><dd><code>{graph.graphId}</code></dd></div>
                  <div><dt>Graph hash</dt><dd><code>{graph.graphHash.slice(0, 16)}…</code></dd></div>
                  <div><dt>Trace ID</dt><dd><code>{graph.traceId}</code></dd></div>
                  <div><dt>Idempotency key</dt><dd><code>{graph.idempotencyKey}</code></dd></div>
                  <div><dt>Source</dt><dd>{graph.source.system} · {graph.source.requestedBy}</dd></div>
                  <div><dt>Workspace</dt><dd>{graph.tenant.workspaceId ?? "—"}</dd></div>
                  <div><dt>Account</dt><dd>{graph.tenant.accountId ?? "—"}</dd></div>
                  <div><dt>Approved by</dt><dd>{graph.approvedBy ?? "Not approved"}</dd></div>
                  <div><dt>Cost</dt><dd>Not measured (mission-graph executions record no cost)</dd></div>
                </dl>
              </section>

              {/* §5.3 Human controls */}
              <section className="mission-detail__section mission-controls" aria-label="Human controls">
                <h3>Controls</h3>
                {graph.status === "approval_required" && (
                  <div className="mission-control-row">
                    <label>
                      Approved by
                      <input
                        className="text-input"
                        value={approvedBy}
                        onChange={(event) => setApprovedBy(event.target.value)}
                        placeholder="founder"
                        disabled={busy}
                      />
                    </label>
                    <button
                      type="button"
                      className="button button--primary"
                      disabled={busy || !approvedBy.trim()}
                      onClick={() =>
                        runControl("approving", () =>
                          approveMissionGraph(graph.graphId, approvedBy.trim(), graph.graphHash),
                        )
                      }
                    >
                      {operation === "approving" ? "Approving…" : "Approve & dispatch"}
                    </button>
                  </div>
                )}

                {graph.status === "failed_recoverable" && (
                  <button
                    type="button"
                    className="button button--primary"
                    disabled={busy}
                    onClick={() => runControl("resuming", () => resumeMissionGraph(graph.graphId))}
                  >
                    {operation === "resuming" ? "Resuming…" : "Resume safely"}
                  </button>
                )}

                {!TERMINAL_GRAPH_STATES.has(graph.status) && (
                  <div className="mission-control-row">
                    <label>
                      Cancelled by
                      <input
                        className="text-input"
                        value={cancelledBy}
                        onChange={(event) => setCancelledBy(event.target.value)}
                        placeholder="founder"
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Reason
                      <input
                        className="text-input"
                        value={cancelReason}
                        onChange={(event) => setCancelReason(event.target.value)}
                        placeholder="Why cancel"
                        disabled={busy}
                      />
                    </label>
                    <button
                      type="button"
                      className="button"
                      disabled={busy || !cancelledBy.trim() || !cancelReason.trim()}
                      onClick={() =>
                        runControl("cancelling", () =>
                          cancelMissionGraph(graph.graphId, cancelledBy.trim(), cancelReason.trim()),
                        )
                      }
                    >
                      {operation === "cancelling" ? "Cancelling…" : "Cancel mission"}
                    </button>
                  </div>
                )}

                <div className="mission-control-row mission-control-row--secondary">
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      runControl("refreshing-results", () => refreshAutoPosterResults(graph.graphId))
                    }
                  >
                    {operation === "refreshing-results" ? "Refreshing…" : "Refresh results"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() => runControl("running-observation", () => runObservationBatch())}
                  >
                    {operation === "running-observation" ? "Observing…" : "Run observation batch"}
                  </button>
                  <button
                    type="button"
                    className="button"
                    disabled={busy}
                    onClick={() =>
                      runControl("generating-evidence", async () => {
                        const bundle = await generateMissionGraphEvidence(graph.graphId);
                        setEvidence(bundle);
                      })
                    }
                  >
                    {operation === "generating-evidence" ? "Generating…" : "Generate evidence"}
                  </button>
                </div>
              </section>

              {/* §5.2 Atoms / nodes */}
              <section className="mission-detail__section">
                <h3>Atoms ({graph.nodes.length})</h3>
                <ul className="mission-nodes">
                  {graph.nodes.map((node) => (
                    <li key={node.nodeId} className="mission-node">
                      <div className="mission-node__head">
                        <span className={`status status--${graphStatusClass(node.status)}`}>
                          <span className="status__dot" />
                          {humanize(node.status)}
                        </span>
                        <strong>{node.nodeId}</strong>
                        <code>{node.product}.{node.action}</code>
                      </div>
                      <dl className="mission-kv mission-kv--compact">
                        <div><dt>Objective</dt><dd>{node.objective}</dd></div>
                        <div><dt>Depends on</dt><dd>{node.dependsOn.length ? node.dependsOn.join(", ") : "—"}</dd></div>
                        <div><dt>Attempts</dt><dd>{node.attempts}</dd></div>
                        <div><dt>Result</dt><dd>{humanize(node.resultStatus)}</dd></div>
                        <div><dt>Child mission</dt><dd><code>{node.childMissionId || "—"}</code></dd></div>
                        {node.childMission && (
                          <div>
                            <dt>Worker state</dt>
                            <dd>
                              {humanize(node.childMission.executionState)}
                              {node.childMission.retryCount !== null
                                ? ` · ${node.childMission.retryCount} retries`
                                : ""}
                            </dd>
                          </div>
                        )}
                      </dl>
                      {node.typedError && (
                        <p className="mission-node__error">
                          <code>{node.typedError.code}</code> {node.typedError.message}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                {graph.edges.length > 0 && (
                  <p className="mission-detail__edges">
                    Dependency order:{" "}
                    {graph.edges.map((edge) => `${edge.fromNodeId} → ${edge.toNodeId}`).join(",  ")}
                  </p>
                )}
              </section>

              {/* §5.2 Result projections */}
              {results && (
                <section className="mission-detail__section">
                  <h3>Result projections</h3>
                  <p className="mission-detail__batch">
                    Batch: <strong>{humanize(results.batch.status)}</strong> · {results.batch.observedCount}/
                    {results.batch.nodeCount} observed
                  </p>
                  <ul className="mission-projections">
                    {results.nodes.map((entry) => (
                      <li key={entry.nodeId}>
                        <strong>{entry.nodeId}</strong>
                        {entry.projection ? (
                          <span>
                            {humanize(entry.projection.projectionStatus)} · {entry.projection.provider} ·
                            source {humanize(entry.projection.sourceStatus)}
                            {entry.projection.escalationReason
                              ? ` · escalation: ${humanize(entry.projection.escalationReason)}`
                              : ""}
                            {entry.projection.queueJobId ? (
                              <>
                                {" · draft "}
                                <code>{entry.projection.queueJobId}</code>
                              </>
                            ) : null}
                            {entry.projection.observedAt
                              ? ` · observed ${entry.projection.observedAt}`
                              : ""}
                          </span>
                        ) : (
                          <span>No projection yet</span>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* §5.2 Observation jobs */}
              <section className="mission-detail__section">
                <h3>Observation jobs ({jobs.length})</h3>
                {observationNote ? (
                  <p className="mission-detail__note">{observationNote}</p>
                ) : jobs.length === 0 ? (
                  <p className="mission-detail__note">No observation jobs for this mission.</p>
                ) : (
                  <ul className="mission-jobs">
                    {jobs.map((job) => (
                      <li key={job.observationJobId}>
                        <span className={`status status--${graphStatusClass(job.status)}`}>
                          <span className="status__dot" />
                          {humanize(job.status)}
                        </span>
                        <strong>{job.nodeId}</strong>
                        <small>
                          attempt {job.attemptCount}/{job.maxAttempts}
                          {job.convergenceReason ? ` · ${humanize(job.convergenceReason)}` : ""}
                          {job.lastErrorCode ? ` · ${job.lastErrorCode}` : ""}
                        </small>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* §5.2 Escalations + §5.3 ack/resolve */}
              {escalations.length > 0 && (
                <section className="mission-detail__section mission-escalations">
                  <h3>Escalations ({escalations.length})</h3>
                  <div className="mission-control-row mission-control-row--secondary">
                    <label>
                      Actor
                      <input
                        className="text-input"
                        value={escalationActor}
                        onChange={(event) => setEscalationActor(event.target.value)}
                        placeholder="founder"
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Resolution note
                      <input
                        className="text-input"
                        value={resolutionNote}
                        onChange={(event) => setResolutionNote(event.target.value)}
                        placeholder="How it was resolved"
                        disabled={busy}
                      />
                    </label>
                  </div>
                  <ul className="mission-escalation-list">
                    {escalations.map((item) => (
                      <li key={item.escalationId}>
                        <div className="mission-escalation__head">
                          <span className={`status status--${item.status === "open" ? "failed" : "succeeded"}`}>
                            <span className="status__dot" />
                            {humanize(item.status)}
                          </span>
                          <strong>{humanize(item.reasonCode)}</strong>
                          <code>{item.severity}</code>
                        </div>
                        <p>{item.summary}</p>
                        <p className="mission-escalation__action">→ {item.recommendedHumanAction}</p>
                        <div className="mission-control-row mission-control-row--secondary">
                          <button
                            type="button"
                            className="button"
                            disabled={busy || item.status !== "open" || !escalationActor.trim()}
                            onClick={() =>
                              runControl("acknowledging", () =>
                                acknowledgeObservationEscalation(item.escalationId, escalationActor.trim()),
                              )
                            }
                          >
                            {operation === "acknowledging" ? "Acknowledging…" : "Acknowledge"}
                          </button>
                          <button
                            type="button"
                            className="button"
                            disabled={
                              busy ||
                              item.status === "resolved" ||
                              item.status === "dismissed" ||
                              !escalationActor.trim() ||
                              !resolutionNote.trim()
                            }
                            onClick={() =>
                              runControl("resolving", () =>
                                resolveObservationEscalation(
                                  item.escalationId,
                                  escalationActor.trim(),
                                  resolutionNote.trim(),
                                ),
                              )
                            }
                          >
                            {operation === "resolving" ? "Resolving…" : "Resolve"}
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* §5.2 Evidence bundle */}
              {evidence && (
                <section className="mission-detail__section mission-evidence">
                  <h3>Retained evidence bundle</h3>
                  <dl className="mission-kv mission-kv--compact">
                    <div><dt>Path</dt><dd><code>{evidence.path}</code></dd></div>
                    <div>
                      <dt>Manifest keys</dt>
                      <dd>{Object.keys(evidence.manifest).join(", ") || "—"}</dd>
                    </div>
                  </dl>
                </section>
              )}

              {/* §5.2 Event timeline */}
              <section className="mission-detail__section">
                <h3>Event timeline ({graph.events.length})</h3>
                <ol className="mission-events">
                  {graph.events.map((event) => (
                    <li key={event.eventId}>
                      <span className="mission-events__seq">#{event.sequence}</span>
                      <span className="mission-events__type">{event.eventType}</span>
                      {(event.previousState || event.newState) && (
                        <span className="mission-events__transition">
                          {humanize(event.previousState)} → {humanize(event.newState)}
                        </span>
                      )}
                      <span className="mission-events__meta">
                        {event.scope}
                        {event.nodeId ? ` · ${event.nodeId}` : ""} · {event.actor}
                      </span>
                      {event.reason && <span className="mission-events__reason">{event.reason}</span>}
                      {event.typedError && (
                        <span className="mission-events__error">
                          <code>{event.typedError.code}</code> {event.typedError.message}
                        </span>
                      )}
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
