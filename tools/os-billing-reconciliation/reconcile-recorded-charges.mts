/**
 * CHANTER OS — reconcile charges that are already recorded.
 *
 * Operational recovery for a real financial gap: money was spent, the charge is
 * durable, and the counterparty's own record was never obtained. This tool asks
 * for it — later, from durable state, against a database that already exists.
 *
 * It was written for a specific run. On 2026-08-07 two billed OpenRouter calls
 * were purchased and correctly recorded (147 and 159 micros, generation ids
 * intact), and both reconciliations reported `unavailable`. Not because anything
 * went wrong with the money, but because the inline lookup fired **three
 * milliseconds** after each charge became durable, and OpenRouter writes its
 * generation record *after* the completion returns. Both got `HTTP 404` for
 * generations that had genuinely been billed. Nothing in the fabric could ask
 * again: a mission replay is refused at `AGENTIC_PROVIDER_ALREADY_INVOKED` long
 * before reconciliation is reachable.
 *
 * ## It cannot spend money
 *
 * Not by policy — structurally. It boots the real Operator and calls exactly one
 * route, `POST /api/os/missions/:id/billing/reconcile`, whose only reachable
 * provider method is `reconcile`. There is no code path from it to an inference
 * request. The provider-usage row count and the summed charge are measured
 * before and after and asserted unchanged, so the guarantee is verified rather
 * than asserted.
 *
 * ## Usage
 *
 *     AGENTIC_FABRIC_OPENROUTER_API_KEY=<key> \
 *       npm run os:reconcile-charges -- --database <path-to-operator.sqlite>
 *
 * `--mission <id>` narrows to one mission; the default reconciles every mission
 * that has an unconfirmed charge. Nothing is written except billing evidence,
 * and the credential is never persisted, printed, or logged.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { fileURLToPath } from "node:url";

const operatorRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const serverEntry = path.join(operatorRoot, "apps", "backend", "src", "server.ts");

const argv = process.argv.slice(2);
function argValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const databasePath = argValue("--database") ?? "";
const missionFilter = argValue("--mission") ?? null;
const outputPath = argValue("--out")
  ?? path.join(operatorRoot, "var", "os-billing-reconciliation", "reconciliation-report.json");
const apiKey = process.env.AGENTIC_FABRIC_OPENROUTER_API_KEY?.trim() ?? "";

if (!databasePath || !existsSync(databasePath)) {
  console.error(`--database must name an existing Operator SQLite file. Received: "${databasePath}"`);
  process.exit(2);
}
if (!apiKey) {
  // Fail closed and say why. Reconciliation without a credential cannot reach
  // the provider, and a run that quietly reports `unavailable` would look like
  // evidence that the charge is unconfirmable rather than unattempted.
  console.error(
    "AGENTIC_FABRIC_OPENROUTER_API_KEY is empty. The provider's own billing record cannot be read "
    + "without it, and no other evidence substitutes for it.",
  );
  process.exit(2);
}

const controlToken = `recon-control-${Math.random().toString(36).slice(2)}`;
const submitToken = `recon-submit-${Math.random().toString(36).slice(2)}`;
const ledgerToken = `recon-ledger-${Math.random().toString(36).slice(2)}`;

interface ChargeRow {
  readonly mission_id: string;
  readonly node_id: string;
  readonly provider_call_key: string;
  readonly provider_name: string;
  readonly model_id: string;
  readonly provider_request_id: string | null;
  readonly monetary_cost_micros: number | null;
  readonly reconciliation_json: string | null;
}

/** Every recorded charge, optionally narrowed to one mission. */
function charges(): ChargeRow[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const sql = `SELECT mission_id, node_id, provider_call_key, provider_name, model_id,
        provider_request_id, monetary_cost_micros, reconciliation_json
      FROM operator_agentic_provider_usage
      WHERE monetary_cost_micros IS NOT NULL${missionFilter ? " AND mission_id = ?" : ""}
      ORDER BY mission_id ASC, node_id ASC`;
    const statement = database.prepare(sql);
    return (missionFilter ? statement.all(missionFilter) : statement.all()) as unknown as ChargeRow[];
  } finally {
    database.close();
  }
}

function verdictOf(row: ChargeRow): string {
  try {
    return String((JSON.parse(row.reconciliation_json ?? "{}") as { verdict?: unknown }).verdict ?? "none");
  } catch {
    return "unparseable";
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function startOperator(port: number): Promise<{ child: ChildProcess; baseUrl: string }> {
  const child = spawn(process.execPath, ["--import", "tsx", serverEntry], {
    cwd: operatorRoot,
    env: {
      ...process.env,
      OPERATOR_DATABASE_PATH: databasePath,
      OPERATOR_PORT: String(port),
      OPERATOR_MISSION_SUBMIT_TOKEN: submitToken,
      OPERATOR_CONTROL_TOKEN: controlToken,
      OPERATOR_LEDGER_INGEST_TOKEN: ledgerToken,
      AGENTIC_FABRIC_OPENROUTER_API_KEY: apiKey,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: false,
  });
  const logs: string[] = [];
  child.stdout?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  child.stderr?.on("data", (chunk: Buffer) => logs.push(chunk.toString("utf8")));
  let exited = false;
  child.once("exit", () => (exited = true));

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`Operator exited before becoming healthy.\n${logs.join("")}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return { child, baseUrl };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`Operator did not become healthy in time.\n${logs.join("")}`);
}

const before = charges();
const missionIds = [...new Set(before.map((row) => row.mission_id))];
console.log("CHANTER OS — provider-owned billing reconciliation");
console.log(`  database: ${databasePath}`);
console.log(`  recorded charges: ${before.length} across ${missionIds.length} mission(s)`);
for (const row of before) {
  console.log(
    `    ${row.mission_id} ${row.node_id} ${String(row.provider_request_id)}`
    + ` ${String(row.monetary_cost_micros)}µ verdict=${verdictOf(row)}`,
  );
}
if (before.length === 0) {
  console.log("Nothing to reconcile: this database records no charge.");
  process.exit(0);
}

// The forensic state of a run that spent real money is copied before anything
// touches it. This tool only ever adds billing evidence, but the pre-existing
// `unavailable` verdicts are themselves the evidence of *why* this tool had to
// exist, and overwriting the only copy of that would destroy the record of the
// defect while fixing it.
const backupPath = `${databasePath}.pre-reconciliation.bak`;
if (!existsSync(backupPath)) {
  copyFileSync(databasePath, backupPath);
  console.log(`  forensic backup: ${backupPath}`);
} else {
  console.log(`  forensic backup already present: ${backupPath}`);
}

let operator: { child: ChildProcess; baseUrl: string } | null = null;
const results: Record<string, unknown>[] = [];
let verdict = "FAIL";
let failure: string | null = null;

try {
  operator = await startOperator(await freePort());

  const baseUrl = operator.baseUrl;
  for (const missionId of missionIds) {
    const reconciled: Response = await fetch(
      `${baseUrl}/api/os/missions/os:governed_agentic_mission:${missionId}/billing/reconcile`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${controlToken}` },
        body: "{}",
      },
    );
    const body = (await reconciled.json()) as Record<string, unknown>;
    assert.equal(reconciled.status, 200, `Reconciliation failed for ${missionId}: ${JSON.stringify(body)}`);
    results.push({ missionId, ...body });
  }

  const after = charges();

  // The guarantee, measured rather than asserted: reconciliation is a read.
  assert.equal(after.length, before.length, "Reconciliation must not create a provider call.");
  const beforeMicros = before.reduce((total, row) => total + Number(row.monetary_cost_micros ?? 0), 0);
  const afterMicros = after.reduce((total, row) => total + Number(row.monetary_cost_micros ?? 0), 0);
  assert.equal(afterMicros, beforeMicros, "Reconciliation must not change what was spent.");

  console.log("");
  console.log("Provider-owned billing evidence:");
  for (const row of after) {
    const reconciliation = JSON.parse(row.reconciliation_json ?? "{}") as Record<string, unknown>;
    console.log(
      `  ${row.mission_id} ${row.node_id} ${String(row.provider_request_id)}`
      + ` chanter=${String(row.monetary_cost_micros)}µ`
      + ` provider=${String(reconciliation.externalAmountMicros ?? "null")}µ`
      + ` delta=${String(reconciliation.deltaMicros ?? "null")}µ`
      + ` verdict=${String(reconciliation.verdict)}`
      + ` lookups=${String(reconciliation.attempts ?? "?")}`,
    );
    if (reconciliation.verdict !== "matched") {
      console.log(`      detail: ${String(reconciliation.detail ?? "none")}`);
    }
  }
  console.log("");
  console.log(`  provider calls: ${before.length} -> ${after.length}`);
  console.log(`  total charge:   ${beforeMicros}µ -> ${afterMicros}µ`);
  console.log("  additional inference calls during reconciliation: 0");

  const confirmed = after.filter((row) => verdictOf(row) === "matched").length;
  verdict = confirmed === after.length ? "PASS" : "PARTIAL";
  console.log("");
  console.log(`${verdict}  (${confirmed}/${after.length} charges confirmed by the provider's own record)`);
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  console.error(`Failure: ${failure}`);
} finally {
  if (operator) {
    operator.child.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  mkdirSync(path.dirname(outputPath), { recursive: true });
  const after = charges();
  writeFileSync(
    outputPath,
    `${JSON.stringify({
      verdict,
      failure,
      databasePath,
      completedAt: new Date().toISOString(),
      additionalInferenceCalls: after.length - before.length,
      charges: after.map((row) => ({
        missionId: row.mission_id,
        nodeId: row.node_id,
        providerName: row.provider_name,
        modelId: row.model_id,
        providerGenerationId: row.provider_request_id,
        chanterRecordedCostMicros: row.monetary_cost_micros,
        reconciliation: JSON.parse(row.reconciliation_json ?? "null"),
      })),
      summaries: results,
    }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Report: ${outputPath}`);
  process.exitCode = verdict === "PASS" ? 0 : 1;
}
