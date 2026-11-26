/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// npm sets npm_package_version from package.json when it runs the build/dev script.
const version = (globalThis as { process?: { env?: Record<string, string | undefined> } })
  .process?.env?.npm_package_version ?? "0.0.0";

// In development the API runs on :8011 (uvicorn, API_PREFIX=/api) and is reached through /api, as in production.
export default defineConfig({
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: { proxy: { "/api": "http://localhost:8011" } },   // run the API with API_PREFIX=/api
  test: { environment: "jsdom", globals: false },
});
