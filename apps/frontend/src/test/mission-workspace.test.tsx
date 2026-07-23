import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as client from "../api/client";
import { MissionWorkspacePanel } from "../components/MissionWorkspacePanel";
import type {
  AutoPosterObservationEscalationView,
  AutoPosterObservationJobView,
  AutoPosterResultProjectionsResponse,
  MissionGraphView,
} from "../api/types";
import { mockHealthHealthy } from "./fixtures";

const baseNode: MissionGraphView["nodes"][number] = {
  nodeId: "autoposter_schedule",
  product: "auto_poster",
  action: "autoposter.post.schedule",
  objective: "Schedule one unapproved AutoPoster draft",
  dependsOn: [],
  childMissionId: "child-mission-001",
  childTraceId: "child-trace-001",
  childIdempotencyKey: "child-key-001",
  status: "ready",
  attempts: 0,
  resultStatus: null,
  resultSummary: null,
  typedError: null,
  childMission: null,
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
};

const approvalGraph: MissionGraphView = {
  replayed: false,
  graphId: "graph-ascension-0001",
  traceId: "trace-ascension-0001",
  idempotencyKey: "idem-ascension-0001",
  schemaVersion: "chanter.mission.graph.v1",
  source: { system: "chanter-mcp-server", requestedBy: "founder" },
  objective: "AutoPoster schedule mission",
  tenant: { userId: "owner", workspaceId: "workspace-a", accountId: "account-a" },
  graphHash: "a".repeat(64),
  status: "approval_required",
  approvalRequired: true,
  approvedBy: null,
  approvedAt: null,
  approvedGraphHash: null,
  requestedAt: "2026-07-23T08:00:00.000Z",
  createdAt: "2026-07-23T08:00:00.000Z",
  updatedAt: "2026-07-23T08:00:00.000Z",
  nodeCount: 1,
  normalizedGraph: {},
  nodes: [baseNode],
  edges: [],
  events: [
    {
      eventId: "event-001",
      graphId: "graph-ascension-0001",
      sequence: 1,
      scope: "graph",
      nodeId: null,
      eventType: "graph_submitted",
      previousState: null,
      newState: "approval_required",
      actor: "chanter-mcp-server",
      reason: "Durable submission",
      timestamp: "2026-07-23T08:00:00.000Z",
      evidenceReferences: [],
      typedError: null,
    },
  ],
};

const approvedGraph: MissionGraphView = {
  ...approvalGraph,
  status: "completed",
  approvedBy: "founder",
  approvedAt: "2026-07-23T08:05:00.000Z",
  approvedGraphHash: approvalGraph.graphHash,
  nodes: [{ ...baseNode, status: "completed", attempts: 1, resultStatus: "succeeded" }],
  events: [
    ...approvalGraph.events,
    {
      eventId: "event-002",
      graphId: "graph-ascension-0001",
      sequence: 2,
      scope: "graph",
      nodeId: null,
      eventType: "graph_approved",
      previousState: "approval_required",
      newState: "completed",
      actor: "founder",
      reason: "Founder approval",
      timestamp: "2026-07-23T08:05:00.000Z",
      evidenceReferences: [],
      typedError: null,
    },
  ],
};

const emptyResults: AutoPosterResultProjectionsResponse = {
  graphId: approvalGraph.graphId,
  graphHash: approvalGraph.graphHash,
  nodes: [{ nodeId: "autoposter_schedule", childMissionId: "child-mission-001", projection: null }],
  batch: { status: "awaiting_results", nodeCount: 1, observedCount: 0, totals: {} },
};

const observationJob: AutoPosterObservationJobView = {
  observationJobId: "obs-001",
  graphId: approvalGraph.graphId,
  nodeId: "autoposter_schedule",
  missionId: "child-mission-001",
  workspaceId: "workspace-a",
  connectedAccountId: "tiktok:account-a",
  accountId: "account-a",
  provider: "tiktok",
  queueJobId: "queue-draft-001",
  sourceBinding: {},
  sourceBindingHash: "b".repeat(64),
  status: "pending",
  attemptCount: 0,
  maxAttempts: 8,
  nextAttemptAt: "2026-07-23T08:06:00.000Z",
  leaseOwner: null,
  leaseExpiresAt: null,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  convergenceReason: null,
  createdAt: "2026-07-23T08:05:00.000Z",
  updatedAt: "2026-07-23T08:05:00.000Z",
};

const openEscalation: AutoPosterObservationEscalationView = {
  escalationId: "esc-001",
  observationJobId: "obs-001",
  graphId: approvalGraph.graphId,
  nodeId: "autoposter_schedule",
  reasonCode: "outcome_unknown",
  severity: "high",
  humanActionRequired: true,
  recommendedHumanAction: "Inspect /private/autoposter and confirm the queue job outcome.",
  summary: "The downstream outcome could not be confirmed within the observation window.",
  evidenceReferences: [],
  status: "open",
  acknowledgedBy: null,
  acknowledgedAt: null,
  resolvedBy: null,
  resolvedAt: null,
  resolutionNote: null,
  createdAt: "2026-07-23T08:10:00.000Z",
  updatedAt: "2026-07-23T08:10:00.000Z",
};

function mockDetail(options: {
  graphs?: MissionGraphView[];
  jobs?: AutoPosterObservationJobView[];
  escalations?: AutoPosterObservationEscalationView[];
} = {}) {
  vi.spyOn(client, "listMissionGraphs").mockResolvedValue(options.graphs ?? [approvalGraph]);
  vi.spyOn(client, "fetchHealth").mockResolvedValue(mockHealthHealthy);
  vi.spyOn(client, "getMissionGraph").mockResolvedValue(approvalGraph);
  vi.spyOn(client, "getAutoPosterResults").mockResolvedValue(emptyResults);
  vi.spyOn(client, "listObservationJobs").mockResolvedValue({
    jobs: options.jobs ?? [observationJob],
    limit: 50,
    offset: 0,
  });
  vi.spyOn(client, "listObservationEscalations").mockResolvedValue({
    escalations: options.escalations ?? [],
    limit: 50,
    offset: 0,
  });
}

describe("Mission Workspace panel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("projects the durable mission list, atoms, event timeline, and health", async () => {
    mockDetail();
    render(<MissionWorkspacePanel />);

    // Detail: atoms/nodes and the event timeline are surfaced.
    expect(await screen.findByText("Atoms (1)")).toBeInTheDocument();

    // Mission list projects the graph with its atom count and worker (the
    // objective appears in both the list and the detail header).
    expect(screen.getAllByText("AutoPoster schedule mission").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/1 atom/).length).toBeGreaterThan(0);
    expect(screen.getByText("auto_poster.autoposter.post.schedule")).toBeInTheDocument();
    expect(screen.getByText("Event timeline (1)")).toBeInTheDocument();
    expect(screen.getByText("graph_submitted")).toBeInTheDocument();

    // Health projection reflects backend integrity + awaiting-approval count.
    expect(screen.getByText("Healthy")).toBeInTheDocument();
    expect(screen.getByText("Smallest safe next action:")).toBeInTheDocument();
  });

  it("approves a mission with the exact graph hash and explicit actor", async () => {
    const user = userEvent.setup();
    mockDetail();
    // First detail load returns approval_required; the reload after approval
    // returns the completed graph.
    vi.mocked(client.getMissionGraph)
      .mockResolvedValueOnce(approvalGraph)
      .mockResolvedValue(approvedGraph);
    const approveSpy = vi.spyOn(client, "approveMissionGraph").mockResolvedValue(approvedGraph);

    render(<MissionWorkspacePanel />);

    const approveButton = await screen.findByRole("button", { name: "Approve & dispatch" });
    expect(approveButton).toBeDisabled();

    await user.type(screen.getByLabelText("Approved by"), "founder");
    expect(approveButton).not.toBeDisabled();
    await user.click(approveButton);

    expect(approveSpy).toHaveBeenCalledWith("graph-ascension-0001", "founder", "a".repeat(64));
    await waitFor(() => expect(screen.getByText("founder")).toBeInTheDocument());
  });

  it("exposes acknowledge/resolve controls for an open observation escalation and no secret inputs", async () => {
    const user = userEvent.setup();
    mockDetail({ escalations: [openEscalation] });
    const ackSpy = vi
      .spyOn(client, "acknowledgeObservationEscalation")
      .mockResolvedValue({ ...openEscalation, status: "acknowledged", acknowledgedBy: "founder" });

    render(<MissionWorkspacePanel />);

    expect(await screen.findByText("Escalations (1)")).toBeInTheDocument();
    expect(screen.getByText("outcome unknown")).toBeInTheDocument();

    // No credential/token/secret inputs anywhere on the control surface.
    expect(screen.queryByLabelText(/token/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/secret/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/api key/i)).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Actor"), "founder");
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(ackSpy).toHaveBeenCalledWith("esc-001", "founder");
  });

  it("renders connected-proof truth labels and runtime/publishing health from backend health", async () => {
    // mockHealthHealthy reports autoposter.configured=true and
    // publishingEnabled=false — the panel must surface those verifiable facts
    // and never overclaim provider proof.
    mockDetail();
    render(<MissionWorkspacePanel />);

    expect(await screen.findByText("Atoms (1)")).toBeInTheDocument();
    const labels = screen.getByLabelText("Proof truth labels");
    expect(within(labels).getByText("Connected proof")).toBeInTheDocument();
    expect(within(labels).getByText("Provider not contacted")).toBeInTheDocument();
    expect(within(labels).getByText("Public publishing blocked")).toBeInTheDocument();

    // Health tiles reflect the same verifiable backend signals.
    expect(screen.getByText("AutoPoster runtime")).toBeInTheDocument();
    expect(screen.getByText("Connected")).toBeInTheDocument();
    // No production-provider-proof language anywhere.
    expect(document.body.textContent).not.toMatch(/production provider proof/i);
  });
});
