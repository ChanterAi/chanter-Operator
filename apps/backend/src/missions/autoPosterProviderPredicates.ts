import type { AutoPosterPostStatusView } from "chanter-agent-runtime";

export interface AutoPosterProviderProofContext {
  graphId?: string;
  childMissionId?: string;
  workspaceId?: string;
  userId?: string;
  expectedTitle?: string;
}

const COMPLETED_PRIVATE_UPLOAD_SUCCESS_STATUSES = new Set(["processed"]);
const COMPLETED_PRIVATE_PROCESSING_SUCCESS_STATUSES = new Set(["succeeded"]);

function normalizeProviderStatus(status: string): string {
  return status.trim().toLowerCase();
}

function hasCoherentCompletedPrivateStatuses(
  receipt: { uploadStatus: string; processingStatus: string },
  verification: { uploadStatus: string; processingStatus: string },
): boolean {
  const receiptUploadStatus = normalizeProviderStatus(receipt.uploadStatus);
  const receiptProcessingStatus = normalizeProviderStatus(receipt.processingStatus);
  return COMPLETED_PRIVATE_UPLOAD_SUCCESS_STATUSES.has(receiptUploadStatus)
    && COMPLETED_PRIVATE_PROCESSING_SUCCESS_STATUSES.has(receiptProcessingStatus)
    && normalizeProviderStatus(verification.uploadStatus) === receiptUploadStatus
    && normalizeProviderStatus(verification.processingStatus) === receiptProcessingStatus;
}

function approvedMediaMatchesOperation(post: AutoPosterPostStatusView): boolean {
  const operation = post.providerOperation;
  const approved = operation?.approvedMedia;
  return Boolean(
    operation
    && operation.providerProofMode
    && approved
    && operation.approvedMediaSha256 === approved.sha256
    && operation.mediaSha256 === approved.sha256
    && operation.mediaByteSize === approved.byteSize
    && operation.mediaMimeType === approved.mimeType
    && operation.mediaContainer === approved.container
    && approved.mimeType === "video/mp4"
    && approved.container === "mp4"
  );
}

export function isExactPrivateProviderProof(
  post: AutoPosterPostStatusView,
  context: AutoPosterProviderProofContext = {},
): boolean {
  const operation = post.providerOperation;
  const receipt = operation?.providerStatusReceipt;
  const verification = post.providerVerification;
  if (!operation || !receipt || !verification || !approvedMediaMatchesOperation(post)) return false;
  if (!hasCoherentCompletedPrivateStatuses(receipt, verification)) return false;
  const expectedTitle = context.expectedTitle ?? receipt.expectedTitle;
  return Boolean(
    post.provider === "youtube"
    && post.status === "posted"
    && post.providerStatus === "uploaded_private"
    && post.publishId
    && operation.operationState === "completed_private"
    && operation.queueId === post.id
    && operation.workspaceId === post.workspaceId
    && operation.accountId === post.accountId
    && operation.connectedAccountId === post.connectedAccountId
    && (!context.graphId || operation.graphId === context.graphId)
    && (!context.childMissionId || operation.runtimeMissionId === context.childMissionId)
    && (!context.workspaceId || operation.workspaceId === context.workspaceId)
    && (!context.userId || operation.userId === context.userId)
    && operation.externalVideoId === post.publishId
    && operation.acceptedByteOffset === operation.mediaByteSize
    && operation.reconciliationAttemptCount >= 0
    && operation.reconciliationAttemptCount <= 3
    && operation.reconciliationAttemptBudget === 3
    && operation.lastOperationErrorCode === null
    && receipt.queueId === post.id
    && receipt.providerOperationId === operation.providerOperationId
    && receipt.providerAttemptId === operation.providerAttemptId
    && receipt.userId === operation.userId
    && receipt.workspaceId === operation.workspaceId
    && receipt.runtimeMissionId === operation.runtimeMissionId
    && receipt.graphId === operation.graphId
    && receipt.configuredAccountId === post.accountId
    && receipt.connectedAccountId === post.connectedAccountId
    && receipt.verifiedChannelId === post.accountId
    && receipt.authenticatedChannelId === receipt.verifiedChannelId
    && receipt.externalVideoId === post.publishId
    && receipt.expectedTitle === expectedTitle
    && receipt.exactTitleMatch
    && receipt.artifactExists
    && receipt.privacyStatus === "private"
    && receipt.mediaSha256 === operation.mediaSha256
    && receipt.providerProofMode
    && JSON.stringify(receipt.approvedMedia) === JSON.stringify(operation.approvedMedia)
    && verification.externalVideoId === post.publishId
    && verification.channelId === post.accountId
    && verification.title === expectedTitle
    && verification.privacyStatus === "private"
    && verification.uploadMethod === "resumable"
    && operation.providerStatusReceiptSha256 !== null
    && operation.mutationSummary.providerSessionInitiationCount === 1
    && operation.mutationSummary.mediaUploadAttemptCount >= 1
    && operation.mutationSummary.confirmedVideoArtifactCount === 1
    && operation.mutationSummary.existingResourceUpdateCount === 0
    && operation.mutationSummary.deleteCount === 0
  );
}

export function isStrictZeroProviderMutation(post: AutoPosterPostStatusView): boolean {
  const operation = post.providerOperation;
  return Boolean(
    operation
    && post.status === "failed"
    && operation.operationState === "terminal_failure"
    && operation.sessionCreatedAt === null
    && operation.uploadStartedAt === null
    && operation.uploadCompletedAt === null
    && operation.acceptedByteOffset === 0
    && operation.externalVideoId === null
    && operation.providerResponseSha256 === null
    && operation.providerStatusReceiptSha256 === null
    && operation.providerStatusReceipt === null
    && operation.reconciliationAttemptCount === 0
    && operation.lastReconciledAt === null
    && operation.reconciliationLease === null
    && Object.values(operation.mutationSummary).every((count) => count === 0)
    && post.publishId === ""
    && post.providerVerification === null
    && post.postedAt === null
    && post.lockedAt === null
    && !post.history.some((entry) => [
      "provider_session_created",
      "provider_upload_attempted",
      "provider_response_received",
      "provider_receipt_recorded",
      "provider_reconciliation_attempted",
    ].includes(entry.event))
  );
}

export function hasProviderProofContradiction(post: AutoPosterPostStatusView): boolean {
  const operation = post.providerOperation;
  if (!operation) return post.provider === "youtube" && post.status === "posted";
  return operation.operationState === "contradictory_public"
    || (operation.operationState === "completed_private" && !isExactPrivateProviderProof(post))
    || (operation.operationState !== "completed_private" && Boolean(post.publishId || post.providerVerification));
}
