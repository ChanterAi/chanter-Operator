/// <reference types="vitest" />
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";

const OPERATOR_API_ORIGIN = "http://127.0.0.1:3001";
const OPERATOR_UI_ORIGIN = "http://127.0.0.1:5173";
const OPERATOR_PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const MISSION_SUBMIT_PATHS = [
  /^\/api\/runtime-missions$/,
  /^\/api\/runtime-missions\/autoposter\/schedule$/,
];
const MISSION_CONTROL_PATHS = [
  /^\/api\/runtime-missions\/[^/]+\/(?:approve|reconcile|resume|stop)$/,
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
          if (request.method !== "POST") return;
          const pathname = new URL(request.url ?? "/", OPERATOR_UI_ORIGIN).pathname;
          if (request.headers.origin !== OPERATOR_UI_ORIGIN) return;
          const capabilityToken = MISSION_SUBMIT_PATHS.some((pattern) => pattern.test(pathname))
            ? missionSubmitToken
            : MISSION_CONTROL_PATHS.some((pattern) => pattern.test(pathname))
              ? missionControlToken
              : "";
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
