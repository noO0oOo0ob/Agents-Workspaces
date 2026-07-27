import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.AGENTS_WORKSPACES_WEB_PORT ?? 4311),
    strictPort: true,
    proxy: {
      "/api": `http://127.0.0.1:${process.env.AGENTS_WORKSPACES_PORT ?? 4310}`,
    },
  },
});
