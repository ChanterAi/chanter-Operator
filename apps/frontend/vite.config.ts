/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

// The Operator backend origin the dev/preview proxy forwards `/api` to.
// Defaults to the standard local port; override with OPERATOR_API_ORIGIN (or a
// bare OPERATOR_PORT) to drive the UI against another running Operator instance
// — e.g. the connected local-mission host on :3101.
const OPERATOR_API_ORIGIN =
  process.env.OPERATOR_API_ORIGIN?.trim() ||
  (process.env.OPERATOR_PORT?.trim() ? `http://127.0.0.1:${process.env.OPERATOR_PORT.trim()}` : "") ||
  "http://127.0.0.1:3001";
const OPERATOR_UI_ORIGIN = "http://127.0.0.1:5173";
const OPERATOR_PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
// POST submission routes: injected with the mission-submit capability. The
// Phase 2D–2F mission-graph submission routes join the legacy runtime-mission
// routes here — submission can never approve.
const MISSION_SUBMIT_PATHS = [
  /^\/api\/runtime-missions$/,
  /^\/api\/runtime-missions\/autoposter\/schedule$/,
  /^\/api\/mission-graphs$/,
  /^\/api\/mission-graphs\/autoposter-schedule$/,
];
// POST control routes: injected with the independent mission-control
// capability (approve/resume/cancel/refresh/evidence/observation actions).
const MISSION_CONTROL_POST_PATHS = [
  /^\/api\/runtime-missions\/[^/]+\/(?:approve|reconcile|resume|stop)$/,
  /^\/api\/mission-graphs\/[^/]+\/(?:approve|resume|cancel)$/,
  /^\/api\/mission-graphs\/[^/]+\/autoposter-results\/refresh$/,
  /^\/api\/mission-graphs\/[^/]+\/evidence$/,
  /^\/api\/autoposter-observations\/run$/,
  /^\/api\/autoposter-observations\/escalations\/[^/]+\/(?:acknowledge|resolve)$/,
];
// GET reads that the backend classifies as internal control capability: the
// entire autonomous-observation surface (jobs and escalations, list + detail)
// is control-gated, so its projection reads carry the control token too.
const MISSION_CONTROL_GET_PATHS = [
  /^\/api\/autoposter-observations\/jobs(?:\/[^/]+)?$/,
  /^\/api\/autoposter-observations\/escalations(?:\/[^/]+)?$/,
];

function operatorApiProxy(
  missionSubmitToken: string,
  missionControlToken: string,
): Record<string, ProxyOptions> {
  return {
    "/api": {
      target: OPERATOR_API_ORIGIN,
      configure(proxy) {
        proxy.on("proxyReq", (proxyRequest, request) => {
          const method = request.method ?? "GET";
          if (method !== "POST" && method !== "GET") return;
          // Only inject for requests the browser itself marks as originating
          // from the Operator UI. Both signals are set by the browser and
          // cannot be forged from page scripts; GET fetches omit Origin, so
          // Sec-Fetch-Site carries the same-origin proof for the read routes.
          const sameOrigin =
            request.headers.origin === OPERATOR_UI_ORIGIN ||
            request.headers["sec-fetch-site"] === "same-origin";
          if (!sameOrigin) return;
          const pathname = new URL(request.url ?? "/", OPERATOR_UI_ORIGIN).pathname;
          let capabilityToken = "";
          if (method === "POST") {
            capabilityToken = MISSION_SUBMIT_PATHS.some((pattern) => pattern.test(pathname))
              ? missionSubmitToken
              : MISSION_CONTROL_POST_PATHS.some((pattern) => pattern.test(pathname))
                ? missionControlToken
                : "";
          } else {
            capabilityToken = MISSION_CONTROL_GET_PATHS.some((pattern) => pattern.test(pathname))
              ? missionControlToken
              : "";
          }
          if (!capabilityToken) return;
          proxyRequest.setHeader("Authorization", `Bearer ${capabilityToken}`);
        });
      },
    },
  };
}

export default defineConfig(({ mode }) => {
  const rootEnvironment = loadEnv(mode, OPERATOR_PROJECT_ROOT, "");
  const missionSubmitToken = Object.prototype.hasOwnProperty.call(
    process.env,
    "OPERATOR_MISSION_SUBMIT_TOKEN",
  )
    ? process.env.OPERATOR_MISSION_SUBMIT_TOKEN?.trim() ?? ""
    : rootEnvironment.OPERATOR_MISSION_SUBMIT_TOKEN?.trim() ?? "";
  const missionControlToken = Object.prototype.hasOwnProperty.call(
    process.env,
    "OPERATOR_CONTROL_TOKEN",
  )
    ? process.env.OPERATOR_CONTROL_TOKEN?.trim() ?? ""
    : rootEnvironment.OPERATOR_CONTROL_TOKEN?.trim() ?? "";

  return {
    plugins: [react()],
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: ["./src/test/setup.ts"],
      include: ["src/test/**/*.test.tsx"],
      css: false,
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: operatorApiProxy(missionSubmitToken, missionControlToken),
    },
    preview: {
      host: "127.0.0.1",
      port: 5173,
      strictPort: true,
      proxy: operatorApiProxy(missionSubmitToken, missionControlToken),
    },
  };
});
