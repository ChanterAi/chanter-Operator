/**
 * CHANTER OS — candidate artifact renderer.
 *
 * Turns one accepted synthesis result into the exact bytes a human approves and
 * the fabric later writes. Rendering happens once, before approval, and the
 * resulting digest is what the authority binds — so "what was approved" and
 * "what was written" are the same bytes by construction rather than by
 * agreement between two code paths.
 *
 * Determinism is the requirement that shapes everything here: no clock, no
 * random value, no environment, and no iteration over an unordered collection.
 * Two runs over the same accepted claims produce byte-identical output, which is
 * what makes replay return the same artifact identity.
 *
 * A required section with no synthesized content says so explicitly. Filling it
 * with a plausible sentence would be the one thing this document must never do:
 * every line here has to trace to an accepted claim or to durable identity.
 */
import type { JsonValue } from "chanter-agent-runtime";
import type { AgenticMissionRecord } from "./agenticPlanJournal.js";

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry)) : [];
}

function bullets(entries: readonly string[]): string {
  return entries.length === 0
    ? "_No accepted claim contributed to this section._"
    : entries.map((entry) => `- ${entry}`).join("\n");
}

function acceptanceTable(value: JsonValue | undefined): string {
  if (!Array.isArray(value) || value.length === 0) {
    return "_No acceptance criterion was evaluated._";
  }
  const rows = value.map((entry) => {
    const record = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? (entry as Record<string, JsonValue>)
      : {};
    const passed = record.passed === true ? "PASS" : "NOT EVALUATED / FAIL";
    return `| ${String(record.criterionId ?? "")} | ${passed} | ${String(record.detail ?? "")} |`;
  });
  return ["| Criterion | Result | Detail |", "| --- | --- | --- |", ...rows].join("\n");
}

/** Normalizes a section name so heading text and lookup key cannot drift apart. */
function sectionKey(section: string): string {
  return section.trim().toLowerCase().replace(/\s+/g, "_");
}

export function renderAgenticCandidate(
  mission: AgenticMissionRecord,
  synthesis: Record<string, JsonValue>,
): string {
  const bodyFor = (section: string): string => {
    switch (sectionKey(section)) {
      case "executive_summary":
        return String(synthesis.executiveSummary ?? "");
      case "architecture_findings":
        return bullets(stringList(synthesis.architectureFindings));
      case "risk_findings":
        return bullets(stringList(synthesis.riskFindings));
      case "recommended_actions":
        return bullets(stringList(synthesis.recommendedActions));
      case "evidence_index":
        return bullets(stringList(synthesis.evidenceIndex));
      case "remaining_uncertainty":
        return bullets(stringList(synthesis.remainingUncertainty));
      case "acceptance_evaluation":
        return acceptanceTable(synthesis.acceptanceEvaluation);
      default:
        return "_No synthesized content maps to this required section._";
    }
  };

  const lines: string[] = [
    `# ${mission.intent.outputContract.artifactName}`,
    "",
    `Objective: ${mission.objective}`,
    "",
    "## Identity",
    "",
    `- Mission: ${mission.missionId}`,
    `- Plan: ${mission.planId}`,
    `- Intent hash: ${mission.intentHash}`,
    `- Context bundle: ${mission.contextBundleId}`,
    `- Plan hash: ${mission.planHash}`,
    "",
  ];
  for (const section of mission.intent.outputContract.requiredSections) {
    lines.push(`## ${section}`, "", bodyFor(section), "");
  }
  lines.push(
    "## Source Claims",
    "",
    bullets(stringList(synthesis.sourceClaimIds)),
    "",
  );
  return `${lines.join("\n")}\n`;
}
