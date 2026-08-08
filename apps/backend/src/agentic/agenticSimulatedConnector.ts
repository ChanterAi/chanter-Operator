/**
 * CHANTER OS — simulated operational connector.
 *
 * Stands in for an external operational system while being, in every byte, a
 * local JSON store this fabric owns. It exists so the operational-exception
 * contract can be proven end to end — observe, act once, reconcile an ambiguous
 * outcome, verify independently — without a single real external write.
 *
 * ## It owns its state, and nothing else owns it
 *
 * The mission journal never writes here and this module never writes there. That
 * separation is what makes verification meaningful: the oracle re-reads the
 * connector's own store, so "the record now says X" is a fact about the
 * simulated external system rather than a fact this fabric wrote about itself.
 * A connector that shared the mission database could always be verified by
 * reading back what we had just decided to believe.
 *
 * ## What it will and will not do
 *
 * Exactly one state-changing capability, declared in its manifest. There is no
 * generic "apply this object" entry point, because arbitrary connector action
 * dispatch would make the ActionContract advisory: whatever bounds the contract
 * declared, a caller could step around them by asking for something else.
 *
 * Three refusals are enforced here rather than upstream, because they are facts
 * only the connector can establish at the moment of the write:
 *
 *   - **pre-state mismatch** — the record moved since it was observed, so an
 *     action approved against the old state must not land on the new one;
 *   - **unknown capability or target** — the contract names something this
 *     connector does not have;
 *   - **replay** — an idempotency key already applied returns the *original*
 *     outcome and performs no second write.
 *
 * ## Interruption
 *
 * `applyInterrupt` fires after the store is durably changed and before the
 * outcome is returned. That is the genuinely ambiguous window — the external
 * system has acted and the caller does not know it — and it is the only honest
 * way to prove reconciliation, which must be able to discover an applied action
 * that nothing upstream recorded.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalizeAgenticJson } from "chanter-agent-runtime";
import { OperatorError } from "../services/operatorService.js";
import {
  createObservationHash,
  exceptionFieldsFrom,
  OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  type ExceptionField,
  type ExceptionFieldValue,
} from "./agenticExceptionContract.js";

export const SIMULATED_CONNECTOR_ID = "connector.simulated.ledger.v1" as const;
export const SIMULATED_CONNECTOR_WRITE_CAPABILITY = "record.reconcile" as const;

/**
 * What a connector declares about itself, before anything binds to it.
 *
 * `compensationSupport` is `"none"` and says so explicitly rather than being
 * omitted. A caller must be able to tell "this connector cannot undo an action"
 * apart from "nobody wrote down whether it can", because those imply completely
 * different recovery designs.
 */
export interface ConnectorCapabilityManifest {
  readonly schemaVersion: typeof OPERATIONAL_EXCEPTION_SCHEMA_VERSION;
  readonly connectorId: string;
  /** What kind of system this is. Read by humans, never branched on. */
  readonly systemType: string;
  /**
   * Which world this connector touches.
   *
   * `simulated` means the connector owns a local store standing in for an
   * external system; `real_read_only` means it observes a genuine external
   * system and cannot change it. The distinction is declared rather than
   * inferred because everything downstream — whether a write plan may compile
   * at all — depends on it.
   */
  readonly environment: "simulated" | "real_read_only";
  readonly capabilities: readonly string[];
  readonly readOperations: readonly string[];
  /**
   * Writes this system *has*, whether or not this connector may perform them.
   *
   * Declared separately from `writeCapabilitiesEnabled` on purpose: "this system
   * has no such operation" and "this connector is not permitted to perform it"
   * are different facts, and collapsing them would make a read-only binding look
   * like a system that cannot be changed by anyone.
   */
  readonly writeCapabilitiesDeclared: readonly string[];
  /**
   * Whether this connector may perform any write at all.
   *
   * `false` is enforced structurally, not by a check: a read-only connector
   * exposes no `apply` method, so there is nothing to call. A configured
   * credential does not imply write authority.
   */
  readonly writeCapabilitiesEnabled: boolean;
  /** How the source states its own version, and what a changed one means. */
  readonly revisionSemantics: string;
  /** How freshness is established on a re-read. */
  readonly freshnessSemantics: string;
  readonly writeOperations: readonly string[];
  readonly idempotencySemantics: string;
  readonly reconciliationSupport: string;
  readonly verificationSupport: string;
  readonly compensationSupport: "none";
  /** Fields the one write capability is permitted to change, and no others. */
  readonly writableFields: readonly string[];
  /** Stated so a reader never has to infer it from the implementation. */
  readonly realExternalWrites: false;
}

export const SIMULATED_CONNECTOR_MANIFEST: ConnectorCapabilityManifest = Object.freeze({
  schemaVersion: OPERATIONAL_EXCEPTION_SCHEMA_VERSION,
  connectorId: SIMULATED_CONNECTOR_ID,
  systemType: "ledger",
  environment: "simulated",
  capabilities: Object.freeze([SIMULATED_CONNECTOR_WRITE_CAPABILITY]),
  readOperations: Object.freeze(["record.read", "action.read_by_idempotency_key"]),
  writeCapabilitiesDeclared: Object.freeze([SIMULATED_CONNECTOR_WRITE_CAPABILITY]),
  writeCapabilitiesEnabled: true,
  revisionSemantics: "monotonic integer revision the connector bumps on every applied action",
  freshnessSemantics: "content hash over normalized record fields plus the connector's revision",
  writeOperations: Object.freeze([SIMULATED_CONNECTOR_WRITE_CAPABILITY]),
  idempotencySemantics: "idempotency_key_replay_returns_original_outcome",
  reconciliationSupport: "read_by_idempotency_key",
  verificationSupport: "independent_read_after_write",
  compensationSupport: "none",
  writableFields: Object.freeze(["reconciledAmount", "status"]),
  realExternalWrites: false,
}) as ConnectorCapabilityManifest;

export interface ConnectorRecord {
  readonly targetId: string;
  readonly revision: string;
  readonly fields: Readonly<Record<string, ExceptionFieldValue>>;
}

/** One durable application, keyed by the idempotency key that caused it. */
export interface ConnectorAppliedAction {
  readonly idempotencyKey: string;
  readonly targetId: string;
  readonly capability: string;
  readonly writePayloadHash: string;
  readonly preStateHash: string;
  readonly postStateHash: string;
  readonly appliedAt: string;
}

export interface ConnectorApplyResult {
  readonly applied: true;
  /** True when this call performed the write; false when it replayed one. */
  readonly performedWrite: boolean;
  readonly action: ConnectorAppliedAction;
  readonly record: ConnectorRecord;
}

interface ConnectorStoreFile {
  readonly records: Record<string, ConnectorRecord>;
  readonly actions: Record<string, ConnectorAppliedAction>;
}

const EMPTY_STORE: ConnectorStoreFile = { records: {}, actions: {} };

function refuse(code: string, message: string): never {
  throw new OperatorError(message, 409, code);
}

export interface SimulatedConnectorOptions {
  /** Absolute directory this connector's entire state lives in. */
  readonly root: string;
  readonly now: () => string;
  /**
   * Fires after the store is durably changed and before the outcome returns.
   * Throwing here produces the ambiguous window reconciliation must resolve.
   */
  readonly applyInterrupt?: (action: ConnectorAppliedAction) => void;
}

/**
 * What every operational connector must provide, and no more.
 *
 * Reading is the whole mandatory surface. `readAction` and `apply` are optional
 * because a read-only connector has neither — and their *absence* is the
 * guarantee, not a flag set to false. A connector that cannot write is one with
 * no write method to call, which no configuration can change.
 */
export interface OperationalConnector {
  readonly connectorId: string;
  manifest(): ConnectorCapabilityManifest;
  read(targetId: string): ConnectorRecord | null;
  readAction?(idempotencyKey: string): ConnectorAppliedAction | null;
  apply?(request: {
    readonly capability: string;
    readonly targetId: string;
    readonly expectedPreStateHash: string;
    readonly writePayload: readonly ExceptionField[];
    readonly writePayloadHash: string;
    readonly idempotencyKey: string;
  }): ConnectorApplyResult;
}

export interface SimulatedConnector extends OperationalConnector {
  readonly connectorId: string;
  manifest(): ConnectorCapabilityManifest;
  /** Installs fixture state. Never reachable from a worker or a mission. */
  seed(records: readonly ConnectorRecord[]): void;
  read(targetId: string): ConnectorRecord | null;
  /** Reconciliation: was this exact action already applied? */
  readAction(idempotencyKey: string): ConnectorAppliedAction | null;
  apply(request: {
    readonly capability: string;
    readonly targetId: string;
    readonly expectedPreStateHash: string;
    readonly writePayload: readonly ExceptionField[];
    readonly writePayloadHash: string;
    readonly idempotencyKey: string;
  }): ConnectorApplyResult;
  /** Durable counts, for measured evidence. */
  counts(): { readonly reads: number; readonly writes: number; readonly replays: number };
}

/**
 * The connector's own view of a record's identity.
 *
 * Computed with the same domain-separated function the mission side uses for
 * `observationHash`, so "the record the connector holds" and "the state the
 * mission observed" are comparable by value rather than by trust. That shared
 * derivation is what makes the pre-state check enforceable at the boundary
 * instead of being a promise the caller makes about itself.
 */
export function connectorRecordStateHash(record: ConnectorRecord): string {
  return createObservationHash({
    sourceSystemId: SIMULATED_CONNECTOR_ID,
    targetId: record.targetId,
    sourceRevision: record.revision,
    observedFields: exceptionFieldsFrom(record.fields),
  });
}

export function createSimulatedConnector(options: SimulatedConnectorOptions): SimulatedConnector {
  const storePath = path.join(options.root, "connector-state.json");
  let reads = 0;
  let writes = 0;
  let replays = 0;

  function load(): ConnectorStoreFile {
    if (!existsSync(storePath)) return EMPTY_STORE;
    try {
      const parsed = JSON.parse(readFileSync(storePath, "utf8")) as Partial<ConnectorStoreFile>;
      return {
        records: parsed.records ?? {},
        actions: parsed.actions ?? {},
      };
    } catch {
      // A corrupt connector store is a refusal, never an empty one. Treating it
      // as empty would make a damaged external system look like a system with
      // nothing in it, and the mission would happily "reconcile" a record that
      // may still exist.
      refuse("CONNECTOR_STATE_UNREADABLE", "The connector's durable state could not be read.");
    }
  }

  function save(store: ConnectorStoreFile): void {
    mkdirSync(options.root, { recursive: true });
    // Temp-write then rename, so a crash mid-write never leaves the simulated
    // external system in a half-applied state a reader could observe.
    const temporary = path.join(options.root, `.connector-state.${process.pid}.tmp`);
    writeFileSync(temporary, `${canonicalizeAgenticJson(store as never)}\n`, "utf8");
    renameSync(temporary, storePath);
  }

  return {
    connectorId: SIMULATED_CONNECTOR_ID,

    manifest: () => SIMULATED_CONNECTOR_MANIFEST,

    seed(records) {
      const store = load();
      const next: Record<string, ConnectorRecord> = { ...store.records };
      for (const record of records) next[record.targetId] = record;
      save({ records: next, actions: store.actions });
    },

    read(targetId) {
      reads += 1;
      return load().records[targetId] ?? null;
    },

    readAction(idempotencyKey) {
      reads += 1;
      return load().actions[idempotencyKey] ?? null;
    },

    apply(request) {
      const store = load();

      if (request.capability !== SIMULATED_CONNECTOR_WRITE_CAPABILITY) {
        refuse(
          "CONNECTOR_CAPABILITY_UNKNOWN",
          `Connector ${SIMULATED_CONNECTOR_ID} declares no capability "${request.capability}".`,
        );
      }

      // Replay first, before any check that could have changed since the
      // original application. An action that already happened must return its
      // original outcome even if the record has moved on since — otherwise a
      // restart would turn a completed action into a pre-state mismatch and
      // invite a duplicate.
      const existing = store.actions[request.idempotencyKey];
      if (existing) {
        replays += 1;
        const current = store.records[existing.targetId];
        if (!current) {
          refuse("CONNECTOR_TARGET_MISSING", `Connector record ${existing.targetId} no longer exists.`);
        }
        return { applied: true, performedWrite: false, action: existing, record: current };
      }

      const record = store.records[request.targetId];
      if (!record) {
        refuse("CONNECTOR_TARGET_MISSING", `Connector holds no record ${request.targetId}.`);
      }

      const preStateHash = connectorRecordStateHash(record);
      if (preStateHash !== request.expectedPreStateHash) {
        // The record moved between observation and action. Refusing here is what
        // makes an approval bound to a stale observation unusable rather than
        // dangerous.
        refuse(
          "CONNECTOR_PRE_STATE_MISMATCH",
          `Connector record ${request.targetId} is not in the state this action was approved against.`,
        );
      }

      const unwritable = request.writePayload
        .map((entry) => entry.field)
        .filter((field) => !SIMULATED_CONNECTOR_MANIFEST.writableFields.includes(field));
      if (unwritable.length > 0) {
        refuse(
          "CONNECTOR_FIELD_NOT_WRITABLE",
          `Connector capability ${request.capability} may not write ${unwritable.sort().join(", ")}.`,
        );
      }

      const fields: Record<string, ExceptionFieldValue> = { ...record.fields };
      for (const entry of request.writePayload) fields[entry.field] = entry.value;
      const updated: ConnectorRecord = {
        targetId: record.targetId,
        // The connector bumps its own revision. Nothing upstream may choose it,
        // because a source system's version marker is the source's to state.
        revision: `r${Number.parseInt(record.revision.replace(/^r/, ""), 10) + 1}`,
        fields,
      };
      const action: ConnectorAppliedAction = {
        idempotencyKey: request.idempotencyKey,
        targetId: record.targetId,
        capability: request.capability,
        writePayloadHash: request.writePayloadHash,
        preStateHash,
        postStateHash: connectorRecordStateHash(updated),
        appliedAt: options.now(),
      };

      // Durable before anything can observe the outcome, and before the
      // interrupt: the whole point of the ambiguous window is that the external
      // system really did change.
      save({
        records: { ...store.records, [updated.targetId]: updated },
        actions: { ...store.actions, [action.idempotencyKey]: action },
      });
      writes += 1;
      options.applyInterrupt?.(action);

      return { applied: true, performedWrite: true, action, record: updated };
    },

    counts: () => ({ reads, writes, replays }),
  };
}
