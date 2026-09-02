import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/app/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  define: {
    __UI_VERSION__: JSON.stringify(process.env.VITE_UI_VERSION ?? "dev"),
  },
  build: {
    outDir: "dist",
    assetsDir: "assets",
    sourcemap: false,
    reportCompressedSize: true,
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/admin": "http://127.0.0.1:8080",
      "/auth": "http://127.0.0.1:8080",
      "/me": "http://127.0.0.1:8080",
      "/team": "http://127.0.0.1:8080",
      "/health": "http://127.0.0.1:8080",
      "/ready": "http://127.0.0.1:8080",
      "/openapi.json": "http://127.0.0.1:8080",
    },
  },
});
