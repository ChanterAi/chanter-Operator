import { useEffect, useState, type FormEvent } from "react";
import {
  approveRuntimeMission,
  createAutoPosterScheduleMission,
  listAutoPosterConnectedAccounts,
  listRuntimeMissions,
  reconcileRuntimeMission,
  resumeRuntimeMission,
  stopRuntimeMission,
} from "../api/client";
import type {
  AutoPosterConnectedAccount,
  AutoPosterProvider,
  CreateAutoPosterScheduleMissionInput,
  RuntimeJsonValue,
  RuntimeMission,
  RuntimeMissionResult,
} from "../api/types";

type MissionOperation =
  | "loading"
  | "loading_accounts"
  | "creating"
  | "approving"
  | "reconciling"
  | "resuming"
  | "stopping";

interface VerifiedQueueDraft {
  id: string;
  approved: false;
  status: string | null;
  scheduledAt: string | null;
}

function upsertMission(missions: RuntimeMission[], nextMission: RuntimeMission): RuntimeMission[] {
  return [nextMission, ...missions.filter((mission) => mission.missionId !== nextMission.missionId)];
}

function connectedAccountName(account: AutoPosterConnectedAccount): string {
  return account.displayName || account.username || "Unnamed channel";
}

function connectedAccountOptionLabel(account: AutoPosterConnectedAccount): string {
  const readiness = account.publishingReady ? "publishing ready" : "publishing blocked";
  return `${account.providerDisplayName} · ${connectedAccountName(account)} · ${account.connectionStatus.replaceAll("_", " ")} · ${readiness} · ${account.accountId}`;
}

function isJsonObject(
  value: RuntimeJsonValue | undefined,
): value is { [key: string]: RuntimeJsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function getVerifiedQueueDraft(
  result: RuntimeMissionResult | null,
  expectedAccountId: string,
  expectedProvider: AutoPosterProvider,
  expectedScheduledAt: string,
): VerifiedQueueDraft | null {
  if (!result || (result.status !== "succeeded" && result.status !== "duplicate")) {
    return null;
  }
  const output = result.output;
  if (!isJsonObject(output)) {
    return null;
  }
  const postValue = output.post;
  if (!isJsonObject(postValue)) return null;

  const post = postValue;
  const id = typeof post.id === "string" ? post.id : "";
  const accountId = typeof post.accountId === "string" ? post.accountId : "";
  const provider = typeof post.provider === "string" ? post.provider.trim() : "";
  const status = typeof post.status === "string" ? post.status.trim() : "";
  const scheduledAt = typeof post.scheduledAt === "string" ? post.scheduledAt.trim() : "";
  if (
    !id.trim() ||
    id !== id.trim() ||
    accountId !== expectedAccountId ||
    provider !== expectedProvider ||
    status !== "scheduled" ||
    !scheduledAt ||
    Number.isNaN(Date.parse(scheduledAt)) ||
    Date.parse(scheduledAt) !== Date.parse(expectedScheduledAt) ||
    post.approved !== false
  ) {
    return null;
  }

  return {
    id,
    approved: false,
    status,
    scheduledAt,
  };
}

function missionStatusLabel(mission: RuntimeMission): string {
  const status = mission.runtimeResult?.status ?? mission.status;
  if (status === "approval_required" || status === "pending_approval") return "Approval required";
  if (status === "succeeded" || status === "duplicate") {
    if (mission.execution && mission.execution.state !== "completed") return "Result persistence pending";
    if (
      !getVerifiedQueueDraft(
        mission.runtimeResult,
        mission.accountId,
        mission.provider,
        mission.scheduledAt,
      )
    ) {
      return "Runtime response rejected";
    }
    return status === "succeeded" ? "Draft scheduled" : "Existing draft returned";
  }
  return status.replaceAll("_", " ");
}

function missionStatusClass(mission: RuntimeMission): string {
  const status = mission.runtimeResult?.status ?? mission.status;
  if (mission.execution && mission.execution.state !== "completed" && (status === "succeeded" || status === "duplicate")) {
    return "executing";
  }
  if (
    (status === "succeeded" || status === "duplicate") &&
    !getVerifiedQueueDraft(
      mission.runtimeResult,
      mission.accountId,
      mission.provider,
      mission.scheduledAt,
    )
  ) {
    return "failed";
  }
  return status;
}

function isAwaitingApproval(mission: RuntimeMission): boolean {
  return (
    mission.approvalRequired &&
    mission.runtimeResult === null &&
    (mission.status === "approval_required" || mission.status === "pending_approval")
  );
}

export function AutoPosterMissionPanel() {
  const [missions, setMissions] = useState<RuntimeMission[]>([]);
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [operation, setOperation] = useState<MissionOperation>();
  const [error, setError] = useState("");

  const [workspaceId, setWorkspaceId] = useState("");
  const [selectedConnectionId, setSelectedConnectionId] = useState("");
  const [connectedAccounts, setConnectedAccounts] = useState<AutoPosterConnectedAccount[]>([]);
  const [mediaUrl, setMediaUrl] = useState("");
  const [caption, setCaption] = useState("");
  const [hashtags, setHashtags] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [scheduledAt, setScheduledAt] = useState("");
  const [approvedBy, setApprovedBy] = useState("");

  const selectedMission =
    missions.find((mission) => mission.missionId === selectedMissionId) ?? null;
  const selectedConnectedAccount =
    connectedAccounts.find((account) => account.connectedAccountId === selectedConnectionId) ?? null;
  const provider: AutoPosterProvider = selectedConnectedAccount?.provider ?? "tiktok";
  const verifiedQueueDraft = selectedMission
    ? getVerifiedQueueDraft(
        selectedMission.runtimeResult,
        selectedMission.accountId,
        selectedMission.provider,
        selectedMission.scheduledAt,
      )
    : null;
  const missionBusy = operation !== undefined;
  const formBusy = operation === "creating";
  const accountsBusy = operation === "loading_accounts";
  const approvalBusy = operation === "approving";

  useEffect(() => {
    let active = true;
    setOperation("loading");
    setError("");

    listRuntimeMissions()
      .then((nextMissions) => {
        if (!active) return;
        setMissions(nextMissions);
        setSelectedMissionId((currentId) => currentId ?? nextMissions[0]?.missionId ?? null);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "Could not load runtime missions.");
      })
      .finally(() => {
        if (active) setOperation(undefined);
      });

    return () => {
      active = false;
    };
  }, []);

  async function handleLoadConnectedAccounts(): Promise<void> {
    if (missionBusy) return;
    const requestedWorkspaceId = workspaceId.trim();
    if (!requestedWorkspaceId) {
      setError("workspaceId is required before loading connected accounts.");
      return;
    }
    setOperation("loading_accounts");
    setError("");
    setConnectedAccounts([]);
    setSelectedConnectionId("");

    try {
      const result = await listAutoPosterConnectedAccounts(requestedWorkspaceId);
      setConnectedAccounts(result.accounts);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load connected accounts.");
    } finally {
      setOperation(undefined);
    }
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (missionBusy) return;
    setOperation("creating");
    setError("");

    if (!selectedConnectedAccount) {
      setOperation(undefined);
      setError("Select a canonical connected account before creating the mission.");
      return;
    }

    const input: CreateAutoPosterScheduleMissionInput = {
      workspaceId: workspaceId.trim(),
      accountId: selectedConnectedAccount.accountId,
      provider: selectedConnectedAccount.provider,
      mediaUrl: mediaUrl.trim(),
      caption: caption.trim(),
      hashtags: hashtags.trim(),
      scheduledAt: scheduledAt.trim(),
      ...(provider === "youtube" && title.trim() ? { title: title.trim() } : {}),
      ...(provider === "youtube" && description.trim()
        ? { description: description.trim() }
        : {}),
    };

    try {
      const mission = await createAutoPosterScheduleMission(input);
      setMissions((current) => upsertMission(current, mission));
      setSelectedMissionId(mission.missionId);
      setApprovedBy("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the mission.");
    } finally {
      setOperation(undefined);
    }
  }

  async function handleApprove(): Promise<void> {
    if (missionBusy || !selectedMission || !approvedBy.trim()) return;
    setOperation("approving");
    setError("");

    try {
      const mission = await approveRuntimeMission(selectedMission.missionId, approvedBy.trim());
      setMissions((current) => upsertMission(current, mission));
      setSelectedMissionId(mission.missionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not schedule the draft.");
    } finally {
      setOperation(undefined);
    }
  }

  async function handleRecoveryAction(
    nextOperation: "reconciling" | "resuming" | "stopping",
  ): Promise<void> {
    if (missionBusy || !selectedMission) return;
    setOperation(nextOperation);
    setError("");
    try {
      const mission = nextOperation === "reconciling"
        ? await reconcileRuntimeMission(selectedMission.missionId)
        : nextOperation === "resuming"
          ? await resumeRuntimeMission(selectedMission.missionId)
          : await stopRuntimeMission(selectedMission.missionId);
      setMissions((current) => upsertMission(current, mission));
      setSelectedMissionId(mission.missionId);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not update mission recovery state.");
    } finally {
      setOperation(undefined);
    }
  }

  function selectMission(missionId: string): void {
    setSelectedMissionId(missionId);
    setApprovedBy("");
    setError("");
  }

  return (
    <main className="runtime-mission-page" aria-labelledby="autoposter-mission-heading">
      <header className="runtime-mission-page__header">
        <div>
          <p className="eyebrow">Bounded runtime mission</p>
          <h1 id="autoposter-mission-heading">AutoPoster schedule mission</h1>
          <p>
            Create one queue draft, review the exact request, then approve scheduling explicitly.
          </p>
        </div>
        <div className="runtime-mission-safety" role="note">
          <strong>Publishing disabled</strong>
          <span>This mission cannot publish; any returned queue draft must remain unapproved.</span>
        </div>
      </header>

      {error && <div className="error-banner runtime-mission-error" role="alert">{error}</div>}

      <div className="runtime-mission-layout">
        <section className="runtime-mission-card" aria-labelledby="mission-create-heading">
          <div className="panel__heading">
            <div>
              <p className="eyebrow">Step 1</p>
              <h2 id="mission-create-heading">Create mission</h2>
            </div>
          </div>

          <form className="runtime-mission-form" onSubmit={handleCreate}>
            <fieldset disabled={missionBusy}>
              <label>
                Workspace ID
                <input
                  className="text-input"
                  value={workspaceId}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value);
                    setConnectedAccounts([]);
                    setSelectedConnectionId("");
                  }}
                  required
                />
              </label>
              <button
                className="button runtime-mission-account-refresh"
                type="button"
                onClick={handleLoadConnectedAccounts}
                disabled={!workspaceId.trim() || missionBusy}
              >
                {accountsBusy ? "Loading accounts..." : "Load connected accounts"}
              </button>
              <label>
                Connected account
                <select
                  value={selectedConnectionId}
                  onChange={(event) => setSelectedConnectionId(event.target.value)}
                  required
                >
                  <option value="">Select an exact canonical account</option>
                  {connectedAccounts.map((account) => (
                    <option key={account.connectedAccountId} value={account.connectedAccountId}>
                      {connectedAccountOptionLabel(account)}
                    </option>
                  ))}
                </select>
              </label>
              {selectedConnectedAccount && (
                <dl className="runtime-mission-account-summary" aria-label="Selected connected account">
                  <div><dt>Provider</dt><dd>{selectedConnectedAccount.providerDisplayName}</dd></div>
                  <div><dt>Account</dt><dd>{connectedAccountName(selectedConnectedAccount)}</dd></div>
                  <div><dt>Connection</dt><dd>{selectedConnectedAccount.connectionStatus.replaceAll("_", " ")}</dd></div>
                  <div><dt>Publishing</dt><dd>{selectedConnectedAccount.publishingReady ? "Ready" : "Blocked"}</dd></div>
                  <div className="runtime-mission-account-summary__canonical">
                    <dt>Exact canonical ID</dt><dd><code>{selectedConnectedAccount.accountId}</code></dd>
                  </div>
                </dl>
              )}
              <label>
                Media URL
                <input
                  className="text-input"
                  type="url"
                  value={mediaUrl}
                  onChange={(event) => setMediaUrl(event.target.value)}
                  placeholder="https://trusted-media.example/video.mp4"
                  required
                />
              </label>
              <label>
                Caption
                <textarea
                  value={caption}
                  onChange={(event) => setCaption(event.target.value)}
                  required
                />
              </label>
              <label>
                Hashtags
                <input
                  className="text-input"
                  value={hashtags}
                  onChange={(event) => setHashtags(event.target.value)}
                  placeholder="#one #two"
                  required
                />
              </label>

              {provider === "youtube" && (
                <>
                  <label>
                    YouTube title
                    <input
                      className="text-input"
                      value={title}
                      onChange={(event) => setTitle(event.target.value)}
                      required
                    />
                  </label>
                  <label>
                    YouTube description (optional)
                    <textarea
                      value={description}
                      onChange={(event) => setDescription(event.target.value)}
                    />
                  </label>
                </>
              )}

              <label>
                Scheduled date/time (ISO 8601 with explicit timezone)
                <input
                  className="text-input"
                  value={scheduledAt}
                  onChange={(event) => setScheduledAt(event.target.value)}
                  placeholder="2026-07-15T18:50:00Z"
                  required
                />
              </label>
              <p className="form-note">
                Include <code>Z</code> or an offset such as <code>+03:00</code>. Account loading and
                mission creation perform read-only AutoPoster registry validation; only a later
                explicit approval may create an unapproved queue draft.
              </p>

              <button
                className="button button--primary"
                type="submit"
                disabled={!selectedConnectedAccount}
              >
                {formBusy ? "Creating mission..." : "Create schedule mission"}
              </button>
            </fieldset>
          </form>
        </section>

        <section className="runtime-mission-card runtime-mission-history" aria-labelledby="mission-history-heading">
          <div className="panel__heading">
            <div>
              <p className="eyebrow">Persisted</p>
              <h2 id="mission-history-heading">Recent missions</h2>
            </div>
            <span className="count">{missions.length}</span>
          </div>

          {operation === "loading" ? (
            <p className="runtime-mission-empty" role="status">Loading missions...</p>
          ) : missions.length === 0 ? (
            <p className="runtime-mission-empty">No AutoPoster schedule missions yet.</p>
          ) : (
            <ul className="runtime-mission-list" aria-label="Runtime missions">
              {missions.map((mission) => (
                <li key={mission.missionId}>
                  <button
                    className={
                      "runtime-mission-list__button" +
                      (mission.missionId === selectedMissionId
                        ? " runtime-mission-list__button--selected"
                        : "")
                    }
                    type="button"
                    onClick={() => selectMission(mission.missionId)}
                    disabled={missionBusy}
                    aria-pressed={mission.missionId === selectedMissionId}
                  >
                    <span>{mission.provider === "youtube" ? "YouTube" : "TikTok"}</span>
                    <strong>{mission.caption || mission.mediaUrl}</strong>
                    <small>{missionStatusLabel(mission)}</small>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="runtime-mission-card runtime-mission-detail" aria-labelledby="mission-detail-heading">
          <div className="panel__heading">
            <div>
              <p className="eyebrow">Steps 2–3</p>
              <h2 id="mission-detail-heading">Review and approve</h2>
            </div>
          </div>

          {!selectedMission ? (
            <p className="runtime-mission-empty">Create or select a mission to inspect it.</p>
          ) : (
            <div className="runtime-mission-detail__content">
              <div className="runtime-mission-status" aria-live="polite">
                <span className={`status status--${missionStatusClass(selectedMission)}`}>
                  <span className="status__dot" />
                  {missionStatusLabel(selectedMission)}
                </span>
                {verifiedQueueDraft && (
                  <span className="runtime-mission-release-state">Unapproved for publishing</span>
                )}
              </div>

              <dl className="runtime-mission-identifiers">
                <div><dt>Mission ID</dt><dd><code>{selectedMission.missionId}</code></dd></div>
                <div><dt>Trace ID</dt><dd><code>{selectedMission.traceId}</code></dd></div>
              </dl>

              <section className="runtime-mission-summary" aria-labelledby="requested-operation-heading">
                <h3 id="requested-operation-heading">Requested operation</h3>
                <dl>
                  <div><dt>Workspace</dt><dd>{selectedMission.workspaceId}</dd></div>
                  <div><dt>Account</dt><dd>{selectedMission.accountId}</dd></div>
                  <div><dt>Provider</dt><dd>{selectedMission.provider}</dd></div>
                  <div><dt>Media URL</dt><dd>{selectedMission.mediaUrl}</dd></div>
                  <div><dt>Caption</dt><dd>{selectedMission.caption}</dd></div>
                  <div><dt>Hashtags</dt><dd>{selectedMission.hashtags}</dd></div>
                  {selectedMission.title !== null && <div><dt>Title</dt><dd>{selectedMission.title}</dd></div>}
                  {selectedMission.description !== null && <div><dt>Description</dt><dd>{selectedMission.description}</dd></div>}
                  <div><dt>Scheduled at</dt><dd>{selectedMission.scheduledAt}</dd></div>
                </dl>
              </section>

              {isAwaitingApproval(selectedMission) && (
                <section className="runtime-mission-approval" aria-labelledby="mission-approval-heading">
                  <h3 id="mission-approval-heading">Approval required</h3>
                  <p>Confirm the exact request above before scheduling the unapproved queue draft.</p>
                  <label>
                    Approved by
                    <input
                      className="text-input"
                      value={approvedBy}
                      onChange={(event) => setApprovedBy(event.target.value)}
                      placeholder="founder"
                      disabled={missionBusy}
                    />
                  </label>
                  <button
                    className="button button--primary"
                    type="button"
                    onClick={handleApprove}
                    disabled={missionBusy || !approvedBy.trim()}
                  >
                    {approvalBusy ? "Scheduling draft..." : "Approve and schedule draft"}
                  </button>
                </section>
              )}

              {selectedMission.approvedBy && (
                <p className="runtime-mission-approved-by">Approved by {selectedMission.approvedBy}</p>
              )}

              {selectedMission.execution &&
                selectedMission.execution.state !== "approval_required" &&
                selectedMission.execution.state !== "completed" && (
                <section className="runtime-mission-summary" aria-labelledby="mission-recovery-heading">
                  <h3 id="mission-recovery-heading">Recovery supervision</h3>
                  <dl>
                    <div><dt>Durable state</dt><dd>{selectedMission.execution.state.replaceAll("_", " ")}</dd></div>
                    <div><dt>Last confirmed boundary</dt><dd>{selectedMission.execution.lastConfirmedBoundary.replaceAll("_", " ")}</dd></div>
                    <div><dt>Recovery reason</dt><dd>{selectedMission.execution.recoveryReason || "No recovery decision recorded"}</dd></div>
                    <div><dt>Downstream queue job</dt><dd>{selectedMission.execution.downstreamQueueJobExists ? "Exists" : "Not confirmed"}</dd></div>
                    <div><dt>Authoritative queue ID</dt><dd>{selectedMission.execution.authoritativeQueueId ?? "Not confirmed"}</dd></div>
                    <div><dt>Evidence status</dt><dd>{selectedMission.execution.evidenceStatus.replaceAll("_", " ")}</dd></div>
                    {selectedMission.execution.typedError && (
                      <div className="runtime-mission-evidence-summary__error">
                        <dt>Typed recovery error</dt>
                        <dd><code>{selectedMission.execution.typedError.code}</code> {selectedMission.execution.typedError.message}</dd>
                      </div>
                    )}
                  </dl>
                  {selectedMission.execution.nextPermittedActions.length ? (
                    <div className="runtime-mission-recovery-actions" aria-label="Recovery actions">
                      {selectedMission.execution.nextPermittedActions.includes("Reconcile") && (
                        <button className="button" type="button" disabled={missionBusy} onClick={() => handleRecoveryAction("reconciling")}>
                          {operation === "reconciling" ? "Reconciling..." : "Reconcile"}
                        </button>
                      )}
                      {selectedMission.execution.nextPermittedActions.includes("Resume safely") && (
                        <button className="button button--primary" type="button" disabled={missionBusy} onClick={() => handleRecoveryAction("resuming")}>
                          {operation === "resuming" ? "Resuming safely..." : "Resume safely"}
                        </button>
                      )}
                      {selectedMission.execution.nextPermittedActions.includes("Stop / escalate") && (
                        <button className="button" type="button" disabled={missionBusy} onClick={() => handleRecoveryAction("stopping")}>
                          {operation === "stopping" ? "Stopping..." : "Stop / escalate"}
                        </button>
                      )}
                    </div>
                  ) : null}
                </section>
              )}

              {selectedMission.runtimeResult && (
                <section className="runtime-mission-decisions" aria-labelledby="runtime-decisions-heading">
                  <h3 id="runtime-decisions-heading">Runtime decisions</h3>
                  <dl>
                    <div>
                      <dt>Policy</dt>
                      <dd>
                        {selectedMission.runtimeResult.policyDecision
                          ? selectedMission.runtimeResult.policyDecision.allowed
                            ? "Allowed"
                            : selectedMission.runtimeResult.policyDecision.blocked
                              ? "Blocked"
                              : "Approval required"
                          : "Not evaluated"}
                      </dd>
                    </div>
                    <div>
                      <dt>Runtime approval</dt>
                      <dd>
                        {selectedMission.runtimeResult.approvalDecision.approved
                          ? `Approved by ${selectedMission.runtimeResult.approvalDecision.approvedBy ?? "unknown"}`
                          : selectedMission.runtimeResult.approvalDecision.required
                            ? "Required"
                            : "Not required"}
                      </dd>
                    </div>
                    <div>
                      <dt>Idempotency</dt>
                      <dd>{selectedMission.runtimeResult.idempotency.outcome.replaceAll("_", " ")}</dd>
                    </div>
                    {selectedMission.runtimeResult.idempotency.key && (
                      <div>
                        <dt>Idempotency key</dt>
                        <dd><code>{selectedMission.runtimeResult.idempotency.key}</code></dd>
                      </div>
                    )}
                    {selectedMission.runtimeResult.idempotency.originalMissionId && (
                      <div>
                        <dt>Original mission</dt>
                        <dd><code>{selectedMission.runtimeResult.idempotency.originalMissionId}</code></dd>
                      </div>
                    )}
                  </dl>
                </section>
              )}

              {verifiedQueueDraft && (
                <section className="runtime-mission-result runtime-mission-result--draft" aria-labelledby="queue-draft-heading">
                  <h3 id="queue-draft-heading">
                    {selectedMission.runtimeResult?.status === "duplicate"
                      ? "Existing queue draft"
                      : "Queue draft created"}
                  </h3>
                  <dl>
                    <div><dt>Queue draft ID</dt><dd><code>{verifiedQueueDraft.id}</code></dd></div>
                    <div><dt>Approved</dt><dd>No</dd></div>
                    {verifiedQueueDraft.status && <div><dt>Queue status</dt><dd>{verifiedQueueDraft.status}</dd></div>}
                    {verifiedQueueDraft.scheduledAt && <div><dt>Scheduled at</dt><dd>{verifiedQueueDraft.scheduledAt}</dd></div>}
                  </dl>
                </section>
              )}

              {selectedMission.runtimeResult &&
                (selectedMission.runtimeResult.status === "succeeded" ||
                  selectedMission.runtimeResult.status === "duplicate") &&
                !verifiedQueueDraft && (
                  <div className="runtime-mission-result runtime-mission-result--warning" role="alert">
                    The runtime response could not be verified as an unapproved queue draft.
                  </div>
                )}

              {selectedMission.runtimeResult?.warnings.length ? (
                <section className="runtime-mission-messages" aria-labelledby="mission-warnings-heading">
                  <h3 id="mission-warnings-heading">Warnings</h3>
                  <ul>{selectedMission.runtimeResult.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                </section>
              ) : null}

              {selectedMission.runtimeResult?.errors.length ? (
                <section className="runtime-mission-messages runtime-mission-messages--error" aria-labelledby="mission-errors-heading">
                  <h3 id="mission-errors-heading">Errors</h3>
                  <ul>
                    {selectedMission.runtimeResult.errors.map((runtimeError) => (
                      <li key={`${runtimeError.code}:${runtimeError.message}`}>
                        <code>{runtimeError.code}</code> {runtimeError.message}
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}

              <section className="runtime-mission-evidence" aria-labelledby="mission-evidence-heading">
                <h3 id="mission-evidence-heading">Evidence summary</h3>
                <dl className="runtime-mission-evidence-summary">
                  <div><dt>Mission ID</dt><dd><code>{selectedMission.evidenceSummary.missionId}</code></dd></div>
                  <div><dt>Trace ID</dt><dd><code>{selectedMission.evidenceSummary.traceId}</code></dd></div>
                  <div><dt>Workspace</dt><dd>{selectedMission.evidenceSummary.workspaceId}</dd></div>
                  <div><dt>Provider</dt><dd>{selectedMission.evidenceSummary.provider}</dd></div>
                  <div><dt>Canonical account</dt><dd><code>{selectedMission.evidenceSummary.canonicalAccountReference}</code></dd></div>
                  <div><dt>Policy</dt><dd>{selectedMission.evidenceSummary.policyDecision.replaceAll("_", " ")}</dd></div>
                  <div><dt>Idempotency</dt><dd>{selectedMission.evidenceSummary.idempotencyOutcome.replaceAll("_", " ")}</dd></div>
                  <div><dt>Queue draft ID</dt><dd>{selectedMission.evidenceSummary.queueDraftId ?? "Not created"}</dd></div>
                  <div><dt>Draft status</dt><dd>{selectedMission.evidenceSummary.persistedDraftStatus ?? "Not created"}</dd></div>
                  <div><dt>Operator approval</dt><dd>{selectedMission.evidenceSummary.operatorApprovalState}</dd></div>
                  <div><dt>Release approval</dt><dd>{selectedMission.evidenceSummary.releaseApprovalState.replaceAll("_", " ")}</dd></div>
                  <div><dt>Publishing</dt><dd>{selectedMission.evidenceSummary.publishingState.replaceAll("_", " ")}</dd></div>
                  <div><dt>Durable state</dt><dd>{selectedMission.evidenceSummary.currentDurableState.replaceAll("_", " ")}</dd></div>
                  <div><dt>Last boundary</dt><dd>{selectedMission.evidenceSummary.lastConfirmedBoundary.replaceAll("_", " ")}</dd></div>
                  <div><dt>Recovery classification</dt><dd>{selectedMission.evidenceSummary.recoveryClassification}</dd></div>
                  <div><dt>Evidence status</dt><dd>{selectedMission.evidenceSummary.evidenceStatus.replaceAll("_", " ")}</dd></div>
                  {selectedMission.evidenceSummary.typedError && (
                    <div className="runtime-mission-evidence-summary__error">
                      <dt>Typed error</dt>
                      <dd><code>{selectedMission.evidenceSummary.typedError.code}</code> {selectedMission.evidenceSummary.typedError.message}</dd>
                    </div>
                  )}
                </dl>
                {selectedMission.runtimeResult?.evidence?.evidence.length ? (
                  <ul>
                    {selectedMission.runtimeResult.evidence.evidence.map((evidence) => (
                      <li key={evidence.id}>
                        <strong>{evidence.label}</strong>
                        <span>{evidence.detail}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>No runtime evidence recorded yet.</p>
                )}
                {selectedMission.runtimeResult?.evidence?.validationResult && (
                  <p>{selectedMission.runtimeResult.evidence.validationResult.summary}</p>
                )}
              </section>

              <p className="runtime-mission-final-safety">
                Publishing remains blocked. AutoPoster still requires separate human release approval.
              </p>
            </div>
          )}
        </section>
      </div>
    </main>
  );
}
