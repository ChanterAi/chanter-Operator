import { useState, type FormEvent } from "react";
import type { ActionType, CreateTaskInput, ProductLane, TaskIntent } from "../api/types";
import { StatusBadge } from "./StatusBadge";

interface Props {
  tasks: TaskIntent[];
  selectedTaskId?: string;
  busy: boolean;
  creating: boolean;
  loading: boolean;
  error: string;
  onSelect: (taskId: string) => void;
  onCreate: (input: CreateTaskInput) => Promise<boolean>;
}

const actions: Array<{ value: ActionType; label: string }> = [
  { value: "analysis", label: "Analysis (safe)" },
  { value: "read_file", label: "Read preview (safe)" },
  { value: "file_write", label: "File write (approval)" },
  { value: "file_edit", label: "File edit (approval)" },
  { value: "shell_command", label: "Shell command (approval)" },
  { value: "unknown", label: "Unknown (approval)" },
];

const lanes: ProductLane[] = [
  "AutoPoster",
  "Loop Governor",
  "Clean Engine",
  "Crypto Radar",
  "Premium Site",
  "CHANTER Operator",
];

const needsWorkspacePath = (action: ActionType) =>
  action === "file_write" || action === "file_edit" || action === "read_file";

export function TaskQueuePanel({
  tasks,
  selectedTaskId,
  busy,
  creating,
  loading,
  error,
  onSelect,
  onCreate,
}: Props) {
  const [rawInput, setRawInput] = useState("");
  const [actionType, setActionType] = useState<ActionType>("file_edit");
  const [priority, setPriority] = useState(1);
  const [productLane, setProductLane] = useState<ProductLane>("CHANTER Operator");
  const [workspacePath, setWorkspacePath] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    const created = await onCreate({
      rawInput,
      actionType,
      priority,
      productLane,
      workspaceRelativePath: workspacePath.trim() || undefined,
    });
    if (created) {
      setRawInput("");
      setWorkspacePath("");
    }
  }

  return (
    <aside className="panel panel--queue">
      <div className="panel__heading">
        <div>
          <p className="eyebrow">Task intake</p>
          <h2>Queue</h2>
        </div>
        <span className="count">{tasks.length}</span>
      </div>

      <form aria-busy={creating} className="task-form" onSubmit={submit}>
        <label htmlFor="task-input">Task description</label>
        <textarea
          id="task-input"
          disabled={busy}
          maxLength={4000}
          onChange={(event) => setRawInput(event.target.value)}
          placeholder="Describe one reviewable operator task..."
          required
          rows={4}
          value={rawInput}
        />
        <div className="form-row">
          <label>
            Action
            <select disabled={busy} value={actionType} onChange={(event) => setActionType(event.target.value as ActionType)}>
              {actions.map((action) => (
                <option key={action.value} value={action.value}>{action.label}</option>
              ))}
            </select>
          </label>
          <label>
            Priority
            <select disabled={busy} value={priority} onChange={(event) => setPriority(Number(event.target.value))}>
              <option value={0}>Low</option>
              <option value={1}>Normal</option>
              <option value={2}>High</option>
            </select>
          </label>
        </div>
        <div className="form-row">
          <label>
            Product lane
            <select disabled={busy} value={productLane} onChange={(event) => setProductLane(event.target.value as ProductLane)}>
              {lanes.map((lane) => (
                <option key={lane} value={lane}>{lane}</option>
              ))}
            </select>
          </label>
          {needsWorkspacePath(actionType) && (
            <label>
              Workspace path
              <input
                className="text-input"
                disabled={busy}
                onChange={(event) => setWorkspacePath(event.target.value)}
                placeholder="e.g. config/preview.json"
                type="text"
                value={workspacePath}
              />
            </label>
          )}
        </div>
        <button className="button button--primary" disabled={busy || !rawInput.trim()} type="submit">
          {creating ? "Creating..." : "Create task"}
        </button>
        <p className="form-note">
          <span className="safety-pill">MOCK ONLY</span>
          {" "}Safe / review-only mode. No command, file, model, or network operation will execute.
        </p>
      </form>

      <div aria-busy={loading} className="task-list" aria-label="Task queue">
        {loading ? (
          <div className="state-message" role="status">Loading task queue...</div>
        ) : error && tasks.length === 0 ? (
          <div className="state-message state-message--error" role="alert">Task queue unavailable. Check the local backend and retry.</div>
        ) : tasks.length === 0 ? (
          <div className="empty-state">No tasks yet. Create one reviewable mock task above.</div>
        ) : tasks.map((task) => (
          <button
            className={`task-card${selectedTaskId === task.id ? " task-card--selected" : ""}`}
            key={task.id}
            disabled={busy}
            onClick={() => onSelect(task.id)}
            type="button"
          >
            <div className="task-card__topline">
              <StatusBadge status={task.status} />
              <span className="priority">P{task.priority}</span>
            </div>
            <div className="task-card__lane">{task.product_lane}</div>
            <strong>{task.parsed_description}</strong>
            <time>{new Date(task.created_at).toLocaleString()}</time>
          </button>
        ))}
      </div>
    </aside>
  );
}
