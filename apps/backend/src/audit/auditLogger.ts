import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AuditEvent, AuditEventType } from "../types.js";

export class AuditLogger {
  constructor(private readonly auditPath: string) {
    mkdirSync(path.dirname(auditPath), { recursive: true });
  }

  append(
    event_type: AuditEventType,
    task_id: string,
    step_id?: string,
    data: Record<string, unknown> = {},
  ): AuditEvent {
    const event: AuditEvent = {
      id: randomUUID(),
      event_type,
      task_id,
      ...(step_id ? { step_id } : {}),
      data,
      created_at: new Date().toISOString(),
    };

    appendFileSync(this.auditPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      flag: "a",
    });
    return event;
  }

  readRecent(limit = 50, taskId?: string): AuditEvent[] {
    if (!existsSync(this.auditPath)) {
      return [];
    }

    const events = readFileSync(this.auditPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as AuditEvent);

    return events
      .filter((event) => !taskId || event.task_id === taskId)
      .slice(-Math.max(1, Math.min(limit, 200)))
      .reverse();
  }
}

