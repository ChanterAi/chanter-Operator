import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import * as client from "../api/client";
import type { AgentRunLedgerEntry, AgentRunLedgerRunDetail } from "../api/types";
import { AgentRunLedgerPanel } from "../components/AgentRunLedgerPanel";
import { mockHealthHealthy } from "./fixtures";

const failedEntry: AgentRunLedgerEntry = {
  schema_version: "1.0",
  run_id: "lg-failed-run-001",
  event_id: "lg-failed-run-001:event:5",
  sequence: 5,
  product_id: "loop_governor",
  workflow_id: "controlled_p0",
  agent_id: "loop-governor-local",
  attempt_id: "lg-failed-run-001:attempt:1",
  parent_run_id: null,
  trace_id: "lg-failed-run-001:trace",
  status: "failed",
  outcome: "failure",
  started_at: "2026-07-14T10:00:00.000Z",
  completed_at: "2026-07-14T10:05:00.000Z",
  provider: "not_applicable",
  model: "not_applicable",
  input_summary: "Controlled local failure run.",
  actions_taken: [{
    action_id: "controlled-action",
    action_type: "local_controlled_run",
    summary: "Ran deterministic local validation.",
    outcome: "failed",
  }],
  tools_used: [{
    tool_id: "loop-governor-local",
    name: "Loop Governor local harness",
    version: "1.0",
  }],
  latency_ms: 300_000,
  cost_estimate: {
    kind: "unknown",
    amount_micros: null,
    currency: null,
  },
  approval_status: "approved",
  approval_actor: "founder-local",
  approval_timestamp: "2026-07-14T10:02:00.000Z",
  risk_level: "high",
  production_impact: true,
  validation_result: "failed",
  validation_summary: "The controlled failure was retained.",
  failure_reason: "Controlled local failure.",
  failure_code: "CONTROLLED_FAILURE",
  evidence_refs: [{
    evidence_id: "failed-evidence-1",
    kind: "log",
    uri: "artifact://loop-governor/failure-log",
    sha256: null,
    captured_at: "2026-07-14T10:05:00.000Z",
  }],
  evidence_count: 1,
  evidence_integrity_status: "unverified",
  payload_hash: "a".repeat(64),
  scope_hash: "b".repeat(64),
  created_at: "2026-07-14T10:00:00.000Z",
  updated_at: "2026-07-14T10:05:00.000Z",
  source_subsystem: "chanter-loop-governor",
};

const detail: AgentRunLedgerRunDetail = {
  entry: failedEntry,
  transitions: [
    { ...failedEntry, event_id: "lg-failed-run-001:event:1", sequence: 1, status: "created", outcome: "pending", completed_at: null, updated_at: "2026-07-14T10:01:00.000Z" },
    { ...failedEntry, event_id: "lg-failed-run-001:event:2", sequence: 2, status: "approval_required", outcome: "pending", completed_at: null, updated_at: "2026-07-14T10:02:00.000Z" },
    { ...failedEntry, event_id: "lg-failed-run-001:event:3", sequence: 3, status: "approved", outcome: "pending", completed_at: null, updated_at: "2026-07-14T10:03:00.000Z" },
    { ...failedEntry, event_id: "lg-failed-run-001:event:4", sequence: 4, status: "running", outcome: "pending", completed_at: null, updated_at: "2026-07-14T10:04:00.000Z" },
    failedEntry,
  ],
};

function mockLedgerReads(): void {
  vi.spyOn(client, "listAgentRunLedgerRuns").mockResolvedValue({
    runs: [failedEntry],
    filters: { limit: 50 },
  });
  vi.spyOn(client, "getAgentRunLedgerRun").mockResolvedValue(detail);
}

describe("Agent Run Ledger read-only supervision", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockLedgerReads();
  });

  it("renders failure, unknown cost, evidence integrity, exact scope, and ordered history", async () => {
    render(<AgentRunLedgerPanel />);

    expect(await screen.findByRole("heading", { name: "Agent Run Ledger" })).toBeInTheDocument();
    expect(await screen.findByText("CONTROLLED_FAILURE")).toBeInTheDocument();
    expect(screen.getAllByText("Controlled local failure.").length).toBeGreaterThan(0);
    expect(screen.getByText("unknown")).toBeInTheDocument();
    expect(screen.getByText("1 / unverified")).toBeInTheDocument();
    expect(screen.getByText("artifact://loop-governor/failure-log")).toBeInTheDocument();
    expect(screen.getByText("lg-failed-run-001:attempt:1")).toBeInTheDocument();

    const history = screen.getByRole("heading", { name: "Ordered transition history" }).parentElement!;
    expect(within(history).getByText("1. created")).toBeInTheDocument();
    expect(within(history).getByText("5. failed")).toBeInTheDocument();
  });

  it("sends every UI filter with exact backend query semantics", async () => {
    const user = userEvent.setup();
    render(<AgentRunLedgerPanel />);
    await screen.findByText("CONTROLLED_FAILURE");

    await user.type(screen.getByLabelText("Product"), "loop_governor");
    await user.type(screen.getByLabelText("Workflow"), "controlled_p0");
    await user.type(screen.getByLabelText("Provider"), "not_applicable");
    await user.type(screen.getByLabelText("Model"), "not_applicable");
    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await user.selectOptions(screen.getByLabelText("Approval"), "approved");
    await user.selectOptions(screen.getByLabelText("Validation"), "failed");
    await user.selectOptions(screen.getByLabelText("Outcome"), "failure");
    await user.type(screen.getByLabelText("From UTC"), "2026-07-14T10:00:00.000Z");
    await user.type(screen.getByLabelText("To UTC"), "2026-07-14T10:00:00.000Z");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));

    await waitFor(() => expect(client.listAgentRunLedgerRuns).toHaveBeenLastCalledWith({
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "failed",
      approvalStatus: "approved",
      validationResult: "failed",
      outcome: "failure",
      from: "2026-07-14T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
      limit: 50,
    }));
  });

  it("maps the filter contract to the exact backend query parameter names", async () => {
    vi.restoreAllMocks();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ runs: [], filters: { limit: 25 } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await client.listAgentRunLedgerRuns({
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "failed",
      approvalStatus: "approved",
      validationResult: "failed",
      outcome: "failure",
      from: "2026-07-14T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
      limit: 25,
    });

    const requestedUrl = String(fetchMock.mock.calls[0]![0]);
    const parsed = new URL(requestedUrl, "http://operator.local");
    expect(parsed.pathname).toBe("/api/agent-run-ledger/runs");
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      product: "loop_governor",
      workflow: "controlled_p0",
      provider: "not_applicable",
      model: "not_applicable",
      status: "failed",
      approvalStatus: "approved",
      validationResult: "failed",
      outcome: "failure",
      from: "2026-07-14T10:00:00.000Z",
      to: "2026-07-14T10:00:00.000Z",
      limit: "25",
    });
  });

  it("offers no ledger mutation, approval, retry, or execution controls", async () => {
    render(<AgentRunLedgerPanel />);
    await screen.findByText("CONTROLLED_FAILURE");

    expect(screen.queryByRole("button", { name: /create|edit|approve|retry|execute|reconcile|delete/i })).not.toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent("No create, edit, approval, retry, or execution controls.");
    expect(client.listAgentRunLedgerRuns).toHaveBeenCalled();
    expect(client.getAgentRunLedgerRun).toHaveBeenCalledWith("lg-failed-run-001");
  });

  it("opens from a fourth tab without replacing the existing cockpit or AutoPoster lane", async () => {
    const user = userEvent.setup();
    vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
    vi.spyOn(client, "listTasks").mockResolvedValue([]);
    render(<App />);

    expect(screen.getByRole("heading", { name: "Queue" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AutoPoster Mission" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Agent Run Ledger" }));
    expect(await screen.findByRole("heading", { name: "Agent Run Ledger" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cockpit" })).toBeInTheDocument();
  });
});
