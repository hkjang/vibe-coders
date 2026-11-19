import { afterEach, describe, expect, it, vi } from "vitest";
import { exportProbePrompts, importProbePrompts } from "./redteam-csv";
import { downloadApiFile } from "@/shared/api/download-file";
import { tokenStore } from "@/shared/auth/token-store";
vi.mock("@/shared/api/download-file", () => ({ downloadApiFile: vi.fn() }));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  tokenStore.clearAll();
});

describe("Probe CSV registered transport", () => {
  it("preserves the server BOM, CRLF and Unicode bytes in an authenticated download", async () => {
    const bytes = new TextEncoder().encode("\ufeffcase_key,input_template\r\npublic,한글\r\n");
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () => new Response(bytes, { headers: { "Content-Type": "text/csv; charset=utf-8" } }),
    );
    vi.stubGlobal("fetch", fetch);
    tokenStore.saveTokens({ access_token: "synthetic-csv-access", refresh_token: "synthetic-refresh" });
    await exportProbePrompts();
    expect(fetch.mock.calls[0]?.[0]).toBe("/admin/redteam/probe-packs/export?format=csv");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Vibe-Route")).toBe("security.redteam");
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer synthetic-csv-access",
    );
    expect(downloadApiFile).toHaveBeenCalledOnce();
    const call = vi.mocked(downloadApiFile).mock.calls[0];
    if (!call) throw new Error("missing file download");
    const [name, file] = call;
    expect(name).toBe("redteam-probe-prompts.csv");
    expect(Array.from(new Uint8Array(file.bytes))).toEqual(Array.from(bytes));
  });

  it("sends imported CSV unchanged with the shared API route metadata", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ imported_cases: 1, packs_touched: 1, skipped: [] }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const csv = "\ufeffcase_key,input_template\npublic,=literal\n";
    await expect(importProbePrompts(csv)).resolves.toMatchObject({ imported_cases: 1 });
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(csv);
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("X-Vibe-Route")).toBe("security.redteam");
  });
});
