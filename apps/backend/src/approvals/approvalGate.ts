import type { ActionType } from "../types.js";

const safeActions = new Set<ActionType>(["analysis", "read_file"]);

export function requiresApproval(actionType: ActionType): boolean {
  return !safeActions.has(actionType);
}

