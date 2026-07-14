import { spawn } from "node:child_process";
import {
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const operatorRoot = path.resolve(import.meta.dirname, "../..");
const runtimeRoot = path.resolve(operatorRoot, "../chanter-agent-runtime");
const runtimeLink = path.join(operatorRoot, "node_modules", "chanter-agent-runtime");
const originalTarget = realpathSync(runtimeLink);
if (!lstatSync(runtimeLink).isSymbolicLink() || originalTarget !== runtimeRoot) {
  throw new Error(`Refusing to replace unexpected Runtime package link: ${originalTarget}`);
}

const tempRoot = mkdtempSync(path.join(os.tmpdir(), "chanter-clean-source-"));
const tempRuntimeRoot = path.join(tempRoot, "chanter-agent-runtime");
const tempRuntimeDist = path.join(tempRuntimeRoot, "dist");
const freshRuntimeEntry = path.join(tempRuntimeDist, "src", "index.js");

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: operatorRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal}.`));
    });
  });
}

function testFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory()
      ? testFiles(absolute)
      : entry.name.endsWith(".test.js")
        ? [absolute]
        : [];
  });
}

let linkReplaced = false;
let commandError;
try {
  await run(process.execPath, [
    path.join(runtimeRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    path.join(runtimeRoot, "tsconfig.json"),
    "--outDir",
    tempRuntimeDist,
  ]);
  copyFileSync(path.join(runtimeRoot, "package.json"), path.join(tempRuntimeRoot, "package.json"));

  rmSync(runtimeLink, { recursive: true, force: false });
  symlinkSync(tempRuntimeRoot, runtimeLink, "junction");
  linkReplaced = true;

  const args = process.argv.slice(2);
  const cleanEnv = {
    ...process.env,
    CHANTER_CLEAN_SOURCE: "1",
    CHANTER_FRESH_RUNTIME_ENTRY: freshRuntimeEntry,
  };
  if (args[0] === "--runtime-tests") {
    const files = testFiles(path.join(tempRuntimeDist, "tests"));
    await run(process.execPath, ["--test", ...files], cleanEnv);
  } else {
    const separator = args.indexOf("--");
    const command = separator >= 0 ? args[separator + 1] : process.execPath;
    const commandArgs = separator >= 0
      ? args.slice(separator + 2)
      : ["--import", "tsx", path.join(operatorRoot, "tools", "resilience-evidence", "cross-process-replay.mjs")];
    if (!command) throw new Error("A command is required after --.");
    await run(command, commandArgs, cleanEnv);
  }
} catch (error) {
  commandError = error;
} finally {
  if (linkReplaced) {
    const currentTarget = realpathSync(runtimeLink);
    if (currentTarget !== tempRuntimeRoot) {
      throw new Error(`Fresh Runtime link changed unexpectedly: ${currentTarget}`);
    }
    rmSync(runtimeLink, { recursive: true, force: false });
    symlinkSync(runtimeRoot, runtimeLink, "junction");
  }
  rmSync(tempRoot, { recursive: true, force: true });
}

if (realpathSync(runtimeLink) !== runtimeRoot) {
  throw new Error("Original Runtime package link was not restored.");
}
if (commandError) throw commandError;
console.log(JSON.stringify({
  verdict: "PASS",
  runtimeCompiledFromSource: true,
  operatorConsumedFreshRuntime: true,
  isolatedOutputRemoved: true,
  originalRuntimeLinkRestored: true,
}, null, 2));
