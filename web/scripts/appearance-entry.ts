import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Plugin } from "vite";

const sourcePath = fileURLToPath(new URL("../src/app/bootstrap/appearance.js", import.meta.url));

/** A same-origin, hashed, parser-blocking asset; never inline code or a CDN. */
export function appearanceEntry(): Plugin {
  const source = readFileSync(sourcePath, "utf8");
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const fileName = `assets/appearance-${digest}.js`;
  let base = "/app/";
  let development = false;
  return {
    name: "vibe-appearance-entry",
    configResolved(config) {
      base = config.base;
      development = config.command === "serve";
    },
    buildStart() {
      this.addWatchFile(sourcePath);
      if (!development)
        this.emitFile({
          type: "asset",
          name: "appearance.js",
          fileName,
          originalFileName: "src/app/bootstrap/appearance.js",
          source,
        });
    },
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        if (request.url?.split("?")[0] !== `${base}${fileName}`) return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          return response.end();
        }
        response.setHeader("Content-Type", "text/javascript; charset=utf-8");
        response.setHeader("Cache-Control", "no-cache");
        response.end(request.method === "HEAD" ? undefined : source);
      });
    },
    transformIndexHtml: {
      order: "post",
      handler() {
        return [{ tag: "script", attrs: { src: `${base}${fileName}` }, injectTo: "head" }];
      },
    },
  };
}
