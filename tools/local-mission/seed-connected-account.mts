#!/usr/bin/env node
// One-time environment bootstrap for the local-mission profile: connects one
// TikTok account in AutoPoster's real Firestore-emulator storage so missions
// have something valid to schedule against.
//
// This is NOT part of the repeatable run-mission.mts command and is not run
// automatically by it. It mirrors what a human operator would otherwise do
// once via AutoPoster's real OAuth "connect account" flow — the OAuth token
// exchange itself can't happen against a real provider for a local throwaway
// account, so this calls the exact same application-layer persistence
// function (`storage.saveTikTokAccount`) that AutoPoster's own OAuth
// callback route (src/routes.js) calls after a successful exchange, using
// the non-transactional branch (no `activationContext` arg) — the same
// helper, not a raw Firestore document write.
//
// Safe to re-run: writes with `{merge: true}` under a fixed accountId.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const operatorRoot = path.resolve(here, "../..");
const autoposterRoot = path.resolve(operatorRoot, "..", "chanter-auto-poster");

function parseArgs(argv: string[]): { accountId: string; userId: string; provider: string } {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const value = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i] : "true";
    args.set(token.slice(2), value!);
  }
  return {
    accountId: args.get("account-id") ?? "acct-local-001",
    userId: args.get("user-id") ?? process.env.AUTOPOSTER_APP_DEFAULT_USER_ID?.trim() ?? "owner",
    provider: args.get("provider") ?? "tiktok",
  };
}

function fail(message: string): never {
  console.error(`[seed-connected-account] FAILED: ${message}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const envFile = path.join(operatorRoot, ".env.local-mission");
  if (!existsSync(envFile)) {
    fail(`Environment profile not found at ${envFile}. Copy .env.local-mission.example to .env.local-mission first.`);
  }
  process.loadEnvFile(envFile);

  const { accountId, userId, provider } = parseArgs(process.argv.slice(2));
  if (provider !== "tiktok") {
    fail(`Only provider "tiktok" is supported by this bootstrap script (got "${provider}").`);
  }
  for (const name of ["FIRESTORE_EMULATOR_HOST", "FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) {
    if (!process.env[name]?.trim()) fail(`Required environment variable ${name} is not set.`);
  }

  const requireFromHere = createRequire(import.meta.url);
  const storagePath = path.join(autoposterRoot, "src", "storage.js");
  if (!existsSync(storagePath)) fail(`AutoPoster storage module not found at ${storagePath}.`);
  const storage = requireFromHere(storagePath);

  console.log(
    `[seed-connected-account] connecting provider=${provider} accountId=${accountId} userId=${userId} ` +
    `against Firestore emulator ${process.env.FIRESTORE_EMULATOR_HOST}`,
  );
  await storage.saveTikTokAccount(
    userId,
    {
      open_id: accountId,
      access_token: "local-test-access-token",
      refresh_token: "local-test-refresh-token",
      scope: "video.publish",
    },
    { username: "local_test_creator", displayName: "Local Test Creator" },
    {},
  );
  console.log("[seed-connected-account] SUCCESS — account connected in the persistent Firestore emulator.");
  process.exit(0);
}

main().catch((error) => fail(error instanceof Error ? error.stack ?? error.message : String(error)));
