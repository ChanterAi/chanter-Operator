import { createHash } from "node:crypto";

/**
 * Graph child mission ids contain colon-delimited lineage. Percent-encoding a
 * long colon-scoped id can accidentally form a mixed-case token-shaped path
 * segment (`3A...`) that the canonical ledger must reject. Preserve the
 * existing readable URI for ordinary missions and use a deterministic,
 * lowercase SHA-256 reference for graph-scoped child identities.
 */
export function operatorRuntimeResultUri(missionId: string): string {
  const pathIdentity = missionId.startsWith("graph:")
    ? `sha256-${createHash("sha256").update(missionId, "utf8").digest("hex")}`
    : encodeURIComponent(missionId);
  return `operator://runtime-missions/${pathIdentity}/runtime-result`;
}
