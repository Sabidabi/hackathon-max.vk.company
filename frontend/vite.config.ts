import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

declare const process: { env: Record<string, string | undefined> };

// `vite` and `vite preview` proxy the API to a local backend; the live end-to-end smoke
// (`tests/live.e2e.cjs`) points it at its own uvicorn through VITE_API_PROXY.
const apiTarget = process.env.VITE_API_PROXY || "http://localhost:8000";
const proxy = { "/api": apiTarget, "/webhooks": apiTarget };

export default defineConfig({
  plugins: [react()],
  server: { host: "0.0.0.0", port: 5173, proxy },
  preview: { proxy },
});
