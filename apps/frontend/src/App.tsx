import { useCallback, useEffect, useState } from "react";
import { approveStep, createTask, getTask, listTasks, rejectStep } from "./api/client";
import type { CreateTaskInput, TaskDetail, TaskIntent } from "./api/types";
import { ReviewPanel } from "./components/ReviewPanel";
import { TaskDetailPanel } from "./components/TaskDetailPanel";
import { TaskQueuePanel } from "./components/TaskQueuePanel";

export default function App() {
  const [tasks, setTasks] = useState<TaskIntent[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string>();
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refreshTasks = useCallback(async () => {
    const nextTasks = await listTasks();
    setTasks(nextTasks);
    return nextTasks;
  }, []);

  const selectTask = useCallback(async (taskId: string) => {
    setSelectedTaskId(taskId);
    setDetail(await getTask(taskId));
  }, []);

  useEffect(() => {
    refreshTasks()
      .then((nextTasks) => nextTasks[0] && selectTask(nextTasks[0].id))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not load tasks."));
  }, [refreshTasks, selectTask]);

  async function runAction(action: () => Promise<TaskDetail>) {
    setBusy(true);
    setError("");
    try {
      const nextDetail = await action();
      setDetail(nextDetail);
      setSelectedTaskId(nextDetail.task.id);
      await refreshTasks();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The local action failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand"><span className="brand__mark">C</span><div><strong>CHANTER</strong><span>Operator</span></div></div>
        <div className="mode"><span className="mode__dot" />Local · Mock runner</div>
      </header>
      {error && <div className="error-banner" role="alert">{error}<button onClick={() => setError("")} type="button" aria-label="Dismiss error">×</button></div>}
      <div className="cockpit">
        <TaskQueuePanel
          busy={busy}
          onCreate={(input: CreateTaskInput) => runAction(() => createTask(input))}
          onSelect={(taskId) => runAction(() => getTask(taskId))}
          selectedTaskId={selectedTaskId}
          tasks={tasks}
        />
        <TaskDetailPanel detail={detail} />
        <ReviewPanel
          busy={busy}
          detail={detail}
          onApprove={(stepId) => runAction(() => approveStep(stepId))}
          onReject={(stepId) => runAction(() => rejectStep(stepId))}
        />
      </div>
    </div>
  );
}

