import { useEffect, useState } from "react";
import type { ReadonlyCommandResult } from "../api/types";

/** The 5 allowed read-only commands. */
const ALLOWED_COMMANDS = [
  "git status --short",
  "git diff --stat",
  "git diff --check",
  "git show --stat --oneline HEAD",
  "git show --name-only HEAD",
];

interface Props {
  busy: boolean;
}

async function runCommand(command: string): Promise<ReadonlyCommandResult> {
  const response = await fetch("/api/commands/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });

  let payload: ReadonlyCommandResult & { error?: string };
  try {
    payload = (await response.json()) as ReadonlyCommandResult & { error?: string };
  } catch {
    throw new Error("The local Operator API returned an unreadable response.");
  }
  if (!response.ok) {
    throw new Error(payload.error || "The local operator request failed.");
  }
  return payload;
}

async function fetchResults(limit = 20): Promise<ReadonlyCommandResult[]> {
  const response = await fetch("/api/commands/results?limit=" + limit);
  if (!response.ok) throw new Error("Could not fetch command results.");
  const data = (await response.json()) as { results: ReadonlyCommandResult[] };
  return data.results;
}

export function ReadonlyRunnerPanel({ busy }: Props) {
  const [selectedCommand, setSelectedCommand] = useState(ALLOWED_COMMANDS[0]);
  const [running, setRunning] = useState(false);
  const [lastResult, setLastResult] = useState<ReadonlyCommandResult | null>(null);
  const [results, setResults] = useState<ReadonlyCommandResult[]>([]);
  const [error, setError] = useState("");

  // Load recent results on mount
  useEffect(() => {
    fetchResults(10)
      .then(setResults)
      .catch(() => { /* silent */ });
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError("");
    setLastResult(null);
    try {
      const result = await runCommand(selectedCommand);
      setLastResult(result);
      // Refresh results list
      const updated = await fetchResults(10);
      setResults(updated);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to run command.");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="readonly-runner">
      <div className="readonly-runner__header">
        <div>
          <p className="eyebrow">P1.0 Read-only Runner</p>
          <h2>Evidence Runner</h2>
        </div>
        <span className="safety-indicator">Read-only</span>
      </div>

      <p className="evidence-disclaimer">
        Executes only 5 allowlisted git read-only commands inside the configured workspace.
        All other commands are blocked.
      </p>

      <div className="readonly-runner__controls">
        <select
          className="input input--compact readonly-runner__select"
          disabled={busy || running}
          onChange={(e) => setSelectedCommand(e.target.value)}
          value={selectedCommand}
        >
          {ALLOWED_COMMANDS.map((cmd) => (
            <option key={cmd} value={cmd}>{cmd}</option>
          ))}
        </select>
        <button
          className="button button--primary button--compact"
          disabled={busy || running}
          onClick={handleRun}
          type="button"
        >
          {running ? "Running..." : "Run"}
        </button>
      </div>

      {error && <p className="error-text">{error}</p>}

      {/* Latest result */}
      {lastResult && (
        <div className={"readonly-runner__result readonly-runner__result--" + lastResult.verdict}>
          <div className="readonly-runner__result-header">
            <span className={"verdict-badge verdict-badge--" + (lastResult.verdict === "allowed_readonly" ? "allowed_readonly" : "blocked")}>
              {lastResult.verdict === "allowed_readonly"
                ? "\u2705 ALLOWED"
                : "\u26d4 BLOCKED"}
            </span>
            <span className="readonly-runner__meta">
              {lastResult.exitCode !== null && (
                <span className="readonly-runner__stat">
                  Exit: <strong>{lastResult.exitCode}</strong>
                </span>
              )}
              {lastResult.durationMs !== null && (
                <span className="readonly-runner__stat">
                  <strong>{lastResult.durationMs}ms</strong>
                </span>
              )}
              <time>{new Date(lastResult.timestamp).toLocaleTimeString()}</time>
            </span>
          </div>
          {lastResult.error && (
            <pre className="readonly-runner__output readonly-runner__output--error">
              {lastResult.error}
            </pre>
          )}
          {lastResult.stdout && (
            <pre className="readonly-runner__output">{lastResult.stdout}</pre>
          )}
          {lastResult.stderr && (
            <pre className="readonly-runner__output readonly-runner__output--stderr">
              {lastResult.stderr}
            </pre>
          )}
          {!lastResult.stdout && !lastResult.stderr && !lastResult.error && (
            <p className="muted-output">(no output)</p>
          )}
        </div>
      )}

      {/* History */}
      {results.length > 0 && (
        <div className="readonly-runner__history">
          <h3>Recent runs ({results.length})</h3>
          <div className="readonly-runner__history-list">
            {results.slice(0, 10).map((r) => (
              <div key={r.id} className={"readonly-runner__history-item readonly-runner__history-item--" + r.verdict}>
                <span className="readonly-runner__history-command">
                  <code>{r.command}</code>
                </span>
                <span className="readonly-runner__history-meta">
                  {r.verdict === "allowed_readonly" && r.exitCode !== null && (
                    <span>Exit {r.exitCode}</span>
                  )}
                  {r.durationMs !== null && <span>{r.durationMs}ms</span>}
                  <time>{new Date(r.timestamp).toLocaleTimeString()}</time>
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
