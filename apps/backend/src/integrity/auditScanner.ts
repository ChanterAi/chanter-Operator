import { readFileSync } from "node:fs";
import { auditEventTypes, type AuditEventType } from "../types.js";

export interface AuditLineError {
  line: number;
  reason: "parse_error" | "missing_fields" | "invalid_type";
  detail: string;
}

export interface AuditScanReport {
  totalLines: number;
  validEvents: number;
  parseErrors: number;
  missingFieldErrors: number;
  invalidTypeErrors: number;
  lineErrors: AuditLineError[];
  /** Set of task IDs referenced by valid audit events. */
  referencedTaskIds: Set<string>;
  /** Set of step IDs referenced by valid audit events. */
  referencedStepIds: Set<string>;
}

const requiredFields: ReadonlyArray<keyof RawAuditEvent> = [
  "id",
  "event_type",
  "task_id",
  "data",
  "created_at",
];

type RawAuditEvent = {
  id?: unknown;
  event_type?: unknown;
  task_id?: unknown;
  step_id?: unknown;
  data?: unknown;
  created_at?: unknown;
};

/**
 * Read-only scan of the append-only audit JSONL file.
 * Never modifies, rewrites, or deletes audit data.
 */
export function scanAuditLog(auditPath: string): AuditScanReport {
  const report: AuditScanReport = {
    totalLines: 0,
    validEvents: 0,
    parseErrors: 0,
    missingFieldErrors: 0,
    invalidTypeErrors: 0,
    lineErrors: [],
    referencedTaskIds: new Set(),
    referencedStepIds: new Set(),
  };

  let contents: string;
  try {
    contents = readFileSync(auditPath, "utf8");
  } catch {
    // File doesn't exist or can't be read — empty report
    return report;
  }

  const lines = contents.split(/\r?\n/).filter(Boolean);
  report.totalLines = lines.length;

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = lines[i].trim();
    if (!trimmed) continue;

    let event: RawAuditEvent;
    try {
      event = JSON.parse(trimmed) as RawAuditEvent;
    } catch {
      report.parseErrors++;
      report.lineErrors.push({
        line: lineNumber,
        reason: "parse_error",
        detail: "Line is not valid JSON.",
      });
      continue;
    }

    // Check required fields
    const missingFields = requiredFields.filter((f) => {
      const v = (event as Record<string, unknown>)[f];
      return v === undefined || v === null;
    });
    if (missingFields.length > 0) {
      report.missingFieldErrors++;
      report.lineErrors.push({
        line: lineNumber,
        reason: "missing_fields",
        detail: `Missing required fields: ${missingFields.join(", ")}.`,
      });
      continue;
    }

    // Validate event_type
    if (typeof event.event_type !== "string" || !auditEventTypes.includes(event.event_type as AuditEventType)) {
      report.invalidTypeErrors++;
      report.lineErrors.push({
        line: lineNumber,
        reason: "invalid_type",
        detail: `event_type "${String(event.event_type ?? "")}" is not a recognized audit event type.`,
      });
      continue;
    }

    // Validate data is a non-array object
    if (typeof event.data !== "object" || event.data === null || Array.isArray(event.data)) {
      report.missingFieldErrors++;
      report.lineErrors.push({
        line: lineNumber,
        reason: "missing_fields",
        detail: "data must be a non-null object.",
      });
      continue;
    }

    // Record references
    if (typeof event.task_id === "string") {
      report.referencedTaskIds.add(event.task_id);
    }
    if (event.step_id !== undefined && typeof event.step_id === "string") {
      report.referencedStepIds.add(event.step_id);
    }

    report.validEvents++;
  }

  return report;
}
