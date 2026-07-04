import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { auditEventTypes, type AuditEvent, type AuditEventType } from "../types.js";

export class AuditStorageError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AuditStorageError";
  }
}

export class AuditLogger {
  constructor(private readonly auditPath: string) {
    try {
      mkdirSync(path.dirname(auditPath), { recursive: true });
    } catch (cause) {
      throw new AuditStorageError("Audit storage could not be initialized.", { cause });
    }
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

    try {
      const descriptor = openSync(this.auditPath, "a", 0o600);
      try {
        writeFileSync(descriptor, `${JSON.stringify(event)}\n`, { encoding: "utf8" });
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
    } catch (cause) {
      throw new AuditStorageError("Audit event could not be durably recorded.", { cause });
    }
    return event;
  }

  readRecent(limit = 50, taskId?: string): AuditEvent[] {
    if (!existsSync(this.auditPath)) {
      return [];
    }

    let contents: string;
    try {
      contents = readFileSync(this.auditPath, "utf8");
    } catch (cause) {
      throw new AuditStorageError("Audit history could not be read.", { cause });
    }

    const events = contents
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line, index) => {
        try {
          const event = JSON.parse(line) as Partial<AuditEvent>;
          if (
            typeof event.id !== "string" ||
            typeof event.task_id !== "string" ||
            typeof event.created_at !== "string" ||
            typeof event.event_type !== "string" ||
            !auditEventTypes.includes(event.event_type as AuditEventType) ||
            !event.data ||
            typeof event.data !== "object" ||
            Array.isArray(event.data)
          ) {
            throw new Error("Invalid audit event shape.");
          }
          return event as AuditEvent;
        } catch (cause) {
          throw new AuditStorageError(`Audit history contains an invalid record at line ${index + 1}.`, {
            cause,
          });
        }
      });

    return events
      .filter((event) => !taskId || event.task_id === taskId)
      .slice(-Math.max(1, Math.min(limit, 200)))
      .reverse();
  }
}
