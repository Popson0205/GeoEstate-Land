/// <reference types="vitest" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In development the API runs on :8011 (uvicorn, API_PREFIX=/api) and is reached through /api, as in production.
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/api": "http://localhost:8011" } },   // run the API with API_PREFIX=/api
  test: { environment: "jsdom", globals: false },
});
