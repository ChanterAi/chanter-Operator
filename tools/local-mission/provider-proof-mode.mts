import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";

export const PROVIDER_PROOF_MODE = "provider-proof";
export const PROVIDER_PROOF_MAX_OBSERVATION_PASSES = 3;
export const PROVIDER_PROOF_HUMAN_GATES = [
  "independent_graph_approval",
  "exact_autoposter_provider_approval",
] as const;

export const PROVIDER_PROOF_REQUIRED_ENV_NAMES = [
  "OPERATOR_BASE_URL",
  "OPERATOR_MISSION_SUBMIT_TOKEN",
  "OPERATOR_CONTROL_TOKEN",
  "AUTOPOSTER_BASE_URL",
  "AUTOPOSTER_RUNTIME_TOKEN",
  "AUTOPOSTER_ADMIN_SESSION_COOKIE",
  "FIREBASE_PROJECT_ID",
  "FIREBASE_CLIENT_EMAIL",
  "FIREBASE_PRIVATE_KEY",
  "YOUTUBE_ENABLED",
  "YOUTUBE_PRIVATE_ONLY",
  "YOUTUBE_CLIENT_ID",
  "YOUTUBE_CLIENT_SECRET",
  "TOKEN_ENCRYPTION_KEY",
] as const;

const EMULATOR_ENV_NAMES = [
  "FIRESTORE_EMULATOR_HOST",
  "FIREBASE_AUTH_EMULATOR_HOST",
  "FIREBASE_DATABASE_EMULATOR_HOST",
  "FIREBASE_STORAGE_EMULATOR_HOST",
] as const;

const PROVIDER_ENDPOINT_OVERRIDE_ENV_NAMES = [
  "YOUTUBE_API_BASE_URL",
  "YOUTUBE_UPLOAD_BASE_URL",
  "YOUTUBE_OAUTH_AUTH_URL",
  "YOUTUBE_OAUTH_TOKEN_URL",
] as const;

export interface ProviderProofRepositoryState {
  name: "operator" | "agent-runtime" | "auto-poster" | "mcp-server";
  currentHead: string | null;
  reviewedHead: string | null;
  clean: boolean;
}

export interface ProviderProofMediaFingerprint {
  sha256: string;
  byteSize: number;
  mimeType: "video/mp4";
  fileName: string;
  container: "mp4";
}

export interface ProviderProofPreflightInput {
  mode: string;
  provider: string;
  workspaceId: string;
  accountId: string;
  idempotencyKey: string;
  title: string;
  approvalActor?: string;
  env: NodeJS.ProcessEnv;
  repositories: ProviderProofRepositoryState[];
  approvedMedia: ProviderProofMediaFingerprint;
  observedMedia: ProviderProofMediaFingerprint;
}

export class ProviderProofPreflightError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ProviderProofPreflightError";
  }
}

function reject(code: string, message: string): never {
  throw new ProviderProofPreflightError(code, message);
}

export function validateProviderProofPreflight(input: ProviderProofPreflightInput): void {
  if (input.mode !== PROVIDER_PROOF_MODE) reject("MODE_REQUIRED", "The explicit provider-proof mode flag is required.");
  if (input.approvalActor) reject("AUTOMATED_APPROVAL_FORBIDDEN", "Provider-proof mode cannot use --approve.");
  if (input.provider !== "youtube") reject("YOUTUBE_ONLY", "Provider-proof mode is YouTube-only.");
  if (!input.workspaceId || !input.accountId || !input.idempotencyKey || !input.title) {
    reject("EXACT_IDENTITY_REQUIRED", "Exact workspace, account, idempotency-key, and title values are required.");
  }

  for (const name of EMULATOR_ENV_NAMES) {
    if (input.env[name]?.trim()) reject("EMULATOR_FORBIDDEN", `Provider-proof mode rejects ${name}.`);
  }
  for (const name of PROVIDER_ENDPOINT_OVERRIDE_ENV_NAMES) {
    if (input.env[name]?.trim()) reject("PROVIDER_ENDPOINT_OVERRIDE_FORBIDDEN", `Provider-proof mode rejects ${name}.`);
  }
  const missing = PROVIDER_PROOF_REQUIRED_ENV_NAMES.filter((name) => !input.env[name]?.trim());
  if (missing.length > 0) {
    reject("REQUIRED_ENV_MISSING", `Required environment variable names are missing: ${missing.join(", ")}.`);
  }
  if (input.env.YOUTUBE_ENABLED !== "true") reject("YOUTUBE_DISABLED", "YOUTUBE_ENABLED must equal true.");
  if (input.env.YOUTUBE_PRIVATE_ONLY !== "true") reject("PRIVATE_ONLY_REQUIRED", "YOUTUBE_PRIVATE_ONLY must equal true.");

  const expectedRepositories = new Set(["operator", "agent-runtime", "auto-poster", "mcp-server"]);
  if (input.repositories.length !== expectedRepositories.size) {
    reject("REPOSITORY_SET_MISMATCH", "Exactly the four reviewed canonical repositories are required.");
  }
  for (const repository of input.repositories) {
    if (!expectedRepositories.delete(repository.name)) reject("REPOSITORY_SET_MISMATCH", "Repository identities must be exact and unique.");
    if (!repository.clean) reject("DIRTY_WORKTREE", `${repository.name} must have a clean worktree.`);
    if (!repository.currentHead || !repository.reviewedHead || repository.currentHead !== repository.reviewedHead) {
      reject("REVIEWED_HEAD_MISMATCH", `${repository.name} does not match its exact reviewed HEAD.`);
    }
  }

  const approved = input.approvedMedia;
  const observed = input.observedMedia;
  if (
    Object.keys(approved).sort().join(",") !== "byteSize,container,fileName,mimeType,sha256"
    || !/^[0-9a-f]{64}$/.test(approved.sha256)
    || !Number.isSafeInteger(approved.byteSize)
    || approved.byteSize <= 0
    || approved.mimeType !== "video/mp4"
    || approved.container !== "mp4"
    || !approved.fileName
    || approved.fileName !== path.basename(approved.fileName)
    || !/\.mp4$/i.test(approved.fileName)
  ) {
    reject("APPROVED_MEDIA_INVALID", "The approved media fingerprint is invalid.");
  }
  if (
    observed.sha256 !== approved.sha256
    || observed.byteSize !== approved.byteSize
    || observed.mimeType !== approved.mimeType
    || observed.container !== approved.container
    || observed.fileName !== approved.fileName
  ) {
    reject("MEDIA_FINGERPRINT_MISMATCH", "The exact local media bytes do not match the approved fingerprint.");
  }
}

export async function fingerprintMp4(filePath: string): Promise<ProviderProofMediaFingerprint> {
  const details = await stat(filePath);
  if (!details.isFile() || details.size < 24) reject("MEDIA_FILE_INVALID", "The provider-proof media path must contain a complete MP4 file.");
  const handle = await open(filePath, "r");
  const buffer = Buffer.alloc(Math.min(details.size, 1024 * 1024));
  try {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const view = buffer.subarray(0, bytesRead);
    const ftypSize = view.length >= 8 ? view.readUInt32BE(0) : 0;
    const ftypType = view.length >= 8 ? view.toString("ascii", 4, 8) : "";
    const brands = new Set(["isom", "iso2", "iso3", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "dash", "M4V ", "MSNV"]);
    let recognized = false;
    if (ftypType === "ftyp" && ftypSize >= 16 && ftypSize <= view.length && ftypSize <= details.size) {
      for (let offset = 8; offset + 4 <= ftypSize; offset += 4) {
        if (offset !== 12 && brands.has(view.toString("ascii", offset, offset + 4))) recognized = true;
      }
    }
    const nextBoxSize = recognized && view.length >= ftypSize + 8 ? view.readUInt32BE(ftypSize) : 0;
    const nextBoxType = recognized && view.length >= ftypSize + 8 ? view.toString("ascii", ftypSize + 4, ftypSize + 8) : "";
    if (!recognized || nextBoxSize < 8 || ftypSize + nextBoxSize > details.size || !/^[\x20-\x7e]{4}$/.test(nextBoxType)) {
      reject("MEDIA_CONTAINER_INVALID", "The provider-proof media bytes are not a valid recognized MP4 container.");
    }
  } finally {
    await handle.close();
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return {
    sha256: hash.digest("hex"),
    byteSize: details.size,
    mimeType: "video/mp4",
    fileName: path.basename(filePath),
    container: "mp4",
  };
}

export async function runProviderProofHumanGates(input: {
  waitForIndependentGraphApproval: () => Promise<void>;
  verifyExactUnapprovedQueue: () => Promise<void>;
  waitForSeparateAutoPosterApproval: () => Promise<void>;
}): Promise<void> {
  await input.waitForIndependentGraphApproval();
  await input.verifyExactUnapprovedQueue();
  await input.waitForSeparateAutoPosterApproval();
}

export function providerProofExactExecutionPath(queueId: string): string {
  const exactQueueId = String(queueId || "");
  if (!exactQueueId || exactQueueId !== exactQueueId.trim()) reject("QUEUE_ID_INVALID", "An exact queue ID is required.");
  return `/posts/${encodeURIComponent(exactQueueId)}/prepare`;
}

export function assertProviderProofExecutionPath(pathname: string, queueId: string): void {
  if (pathname !== providerProofExactExecutionPath(queueId)) {
    reject("GLOBAL_OR_WRONG_EXECUTION_PATH", "Provider-proof execution must target only the exact queue ID.");
  }
}
