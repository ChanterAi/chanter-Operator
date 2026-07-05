import { useCallback, useEffect, useState } from "react";
import { addCommitReview, addValidationEvidence, approveStep, cancelTask, createTask, fetchEvidenceBundle, fetchHealth, getTask, listTasks, previewRunnerPolicy, rejectStep, retryTask } from "./api/client";
import type { CreateTaskInput, ReadinessState, TaskDetail, TaskIntent, ReadonlyCommandResult } from "./api/types";
import { ReadinessBar } from "./components/ReadinessBar";
import { ReviewPanel } from "./components/ReviewPanel";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskQueuePanel } from "./components/TaskQueuePanel";
import { ReadonlyRunnerPanel } from "./components/ReadonlyRunnerPanel";

type Operation = "creating" | "approving" | "rejecting" | "cancelling" | "retrying" | "adding-evidence" | "adding-commit-review";

export default function App() {
  const [tasks, setTasks] = useState<TaskIntent[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [operation, setOperation] = useState<Operation>();
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [taskListError, setTaskListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [error, setError] = useState("");
  const [readiness, setReadiness] = useState<ReadinessState>({ kind: "loading" });
  const [activeTab, setActiveTab] = useState<"cockpit" | "runner">("cockpit");

  const refreshTasks = useCallback(async () => {
    const nextTasks = await listTasks();
    setTasks(nextTasks);
    return nextTasks;
  }, []);

  const selectTask = useCallback(async (taskId: string) => {
    setSelectedTaskId(taskId);
    setLoadingDetail(true);
    setDetailError("");
    try {
      setDetail(await getTask(taskId));
    } catch (reason) {
      setDetail(null);
      setDetailError(reason instanceof Error ? reason.message : "Could not load the selected task.");
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    setReadiness({ kind: "loading" });
    fetchHealth()
      .then((health) => {
        setReadiness(
          health.integrity.healthy ? { kind: "healthy", health } : { kind: "unhealthy", health },
        );
      })
      .catch((reason: unknown) => {
        setReadiness({
          kind: "unavailable",
          error: reason instanceof Error ? reason.message : "Backend unreachable.",
        });
      });
  }, []);

  useEffect(() => {
    setLoadingTasks(true);
    setTaskListError("");
    refreshTasks()
      .then((nextTasks) => nextTasks[0] && selectTask(nextTasks[0].id))
      .catch((reason: unknown) => {
        const message = reason instanceof Error ? reason.message : "Could not load tasks.";
        setTaskListError(message);
        setError(message);
      })
      .finally(() => setLoadingTasks(false));
  }, [refreshTasks, selectTask]);

  async function runAction(nextOperation: Operation, action: () => Promise<TaskDetail>): Promise<boolean> {
    setOperation(nextOperation);
    setError("");
    try {
      const nextDetail = await action();
      setDetail(nextDetail);
      setDetailError("");
      setSelectedTaskId(nextDetail.task.id);
      try {
        await refreshTasks();
        setTaskListError("");
      } catch {
        setError("The action completed, but the task queue could not be refreshed.");
      }
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The local action failed.");
      return false;
    } finally {
      setOperation(undefined);
    }
  }

  const busy = operation !== undefined || loadingDetail || loadingTasks;

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand__mark">C</span><div><strong>CHANTER</strong><span>Operator</span></div></div>
        <div className="agent-mode-bar">
          <span className="agent-mode-bar__item"><span className="agent-mode-bar__label">Runner</span> Mock + Read-only</span>
          <span className="agent-mode-bar__sep" />
          <span className="agent-mode-bar__item"><span className="agent-mode-bar__label">Mode</span> Safe / Review-only</span>
          <span className="agent-mode-bar__sep" />
          <span className="agent-mode-bar__item"><span className="agent-mode-bar__label">Execution</span> Contained</span>
        </div>
        <div className="mode"><span className="mode__dot" />Local</div>
      </header>
      <ReadinessBar state={readiness} />

      {/* Tab navigation */}
      <nav className="tab-nav">
        <button
          className={"tab-nav__button" + (activeTab === "cockpit" ? " tab-nav__button--active" : "")}
          onClick={() => setActiveTab("cockpit")}
          type="button"
        >
          Cockpit
        </button>
        <button
          className={"tab-nav__button" + (activeTab === "runner" ? " tab-nav__button--active" : "")}
          onClick={() => setActiveTab("runner")}
          type="button"
        >
          Read-only Runner
        </button>
      </nav>

      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} type="button" aria-label="Dismiss error">&times;</button></div>}

      {activeTab === "cockpit" ? (
        <div className="cockpit">
          <TaskQueuePanel
            busy={busy}
            creating={operation === "creating"}
            error={taskListError}
            loading={loadingTasks}
            onCreate={(input: CreateTaskInput) => runAction("creating", () => createTask(input))}
            onSelect={selectTask}
            selectedTaskId={selectedTaskId}
            tasks={tasks}
          />
          <TaskDetailPanel detail={detail} error={detailError} loading={loadingDetail} />
          <ReviewPanel
            busy={busy}
            decision={operation === "approving" || operation === "rejecting" ? operation : undefined}
            cancelDecision={operation === "cancelling" ? "cancelling" : undefined}
            retryDecision={operation === "retrying" ? "retrying" : undefined}
            detail={detail}
            onApprove={(stepId) => runAction("approving", () => approveStep(stepId)).then(() => undefined)}
            onReject={(stepId) => runAction("rejecting", () => rejectStep(stepId)).then(() => undefined)}
            onCancel={(taskId) => runAction("cancelling", () => cancelTask(taskId)).then(() => undefined)}
            onRetry={(taskId) => runAction("retrying", () => retryTask(taskId)).then(() => undefined)}
            onAddValidation={async (taskId, commandLabel, status, output) => { await runAction("adding-evidence", () => addValidationEvidence(taskId, { commandLabel, status: status as any, output })); }}
            onAddCommitReview={async (taskId, summaryText, changedFilesText, validationText, riskNotesText) => { await runAction("adding-commit-review", () => addCommitReview(taskId, { summaryText, changedFilesText, validationText, riskNotesText })); }}
          />
        </div>
      ) : (
        <div className="cockpit runner-tab-layout">
          <div className="panel panel--queue" style={{ borderRight: "1px solid #20242c" }}>
            <ReadonlyRunnerPanel busy={busy} />
          </div>
          <div className="panel panel--detail" style={{ flex: 1 }} />
          <div className="panel panel--review">
            <div className="panel__heading" style={{ padding: "18px" }}>
              <div>
                <p className="eyebrow">P1.0 Info</p>
                <h2>Safety</h2>
              </div>
            </div>
            <div style={{ padding: "0 18px 18px" }}>
              <p className="evidence-note">
                This runner executes only 5 pre-approved git read-only commands.
                All other commands are blocked at the policy level before any process is spawned.
              </p>
              <ul style={{ fontSize: "11px", color: "#8d97a8", lineHeight: 1.6, paddingLeft: "16px", marginTop: "10px" }}>
                <li>shell: false — no shell interpretation</li>
                <li>executable + args — no raw strings</li>
                <li>Workspace containment enforced</li>
                <li>15s timeout per command</li>
                <li>1MB output limit</li>
                <li>Full audit trail per execution</li>
                <li>Results persisted to DB</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
