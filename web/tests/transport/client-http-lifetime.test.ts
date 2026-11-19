import { createServer } from "node:http";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { fileEndpoints } from "@/shared/api/file-endpoints";
import { tokenStore } from "@/shared/auth/token-store";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

afterEach(() => {
  tokenStore.clearAll();
});

describe.each(["JSON", "CSV"] as const)("ApiClient native %s body cancellation", (format) => {
  it.each(["deadline", "caller", "logout"])("closes a real incomplete response on %s", async (reason) => {
    const bodyStarted = deferred();
    let connectionClosed = false;
    let requests = 0;
    let normallyEnded = false;
    const server = createServer((_request, response) => {
      requests += 1;
      response.on("close", () => {
        normallyEnded = response.writableEnded;
        connectionClosed = true;
      });
      response.writeHead(200, {
        "Content-Type": format === "JSON" ? "application/json" : "text/csv",
        "X-Request-ID": "native-body",
      });
      response.write('{"status":');
      // Intentionally never end: native fetch must cancel its body and socket.
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing loopback port");
    const origin = `http://127.0.0.1:${address.port}`;
    const client = new ApiClient({
      fetch: async (input, init) => {
        const response = await fetch(new URL(String(input), origin), init);
        if (format === "JSON") {
          const text = response.text.bind(response);
          vi.spyOn(response, "text").mockImplementation(() => {
            bodyStarted.resolve();
            return text();
          });
        } else {
          if (!response.body) throw new Error("missing native body");
          const getReader = response.body.getReader.bind(response.body);
          vi.spyOn(response.body, "getReader").mockImplementation(() => {
            bodyStarted.resolve();
            return getReader();
          });
        }
        return response;
      },
    });
    const caller = new AbortController();
    const options = { timeoutMs: reason === "deadline" ? 1_000 : 4_000, signal: caller.signal };
    const completion = (
      format === "JSON"
        ? client.request(endpoints.health, options)
        : client.file(fileEndpoints.chargeback, { ...options, query: { format: "csv", month: "2026-10" } })
    ).catch((error: unknown) => error);
    try {
      await Promise.race([bodyStarted.promise, completion.then((error) => Promise.reject(error))]);
      if (reason === "caller") caller.abort();
      if (reason === "logout") tokenStore.clearAll();
      await expect(completion).resolves.toMatchObject({
        kind: reason === "deadline" ? "timeout" : "aborted",
      });
      await vi.waitFor(() => expect(connectionClosed).toBe(true));
      expect(normallyEnded).toBe(false);
      expect(requests).toBe(1);
    } finally {
      caller.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      await completion;
    }
  });
});
