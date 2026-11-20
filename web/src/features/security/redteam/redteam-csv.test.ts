import { probeCsvReviewFixture } from "@/test/probe-csv-review";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  exportProbePrompts,
  importProbePrompts,
  reviewProbePrompts,
  applyReviewedProbePrompts,
} from "./redteam-csv";
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

describe("Reviewed probe CSV transport", () => {
  it("sends exact bytes for review and a separately confirmed PUT with strong If-Match", async () => {
    const review = probeCsvReviewFixture();
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(review), { headers: { "Content-Type": "application/json" } }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            review_applied: true,
            applied_revision: review.revision,
            imported_cases: 1,
            packs_touched: 1,
            skipped: null,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);
    const csv = "\ufeffcase_key,input_template\r\nk,한글\r\n";
    await expect(reviewProbePrompts(csv)).resolves.toMatchObject({ revision: review.revision });
    expect(fetch).toHaveBeenCalledOnce();
    const first = fetch.mock.calls[0];
    expect(first?.[0]).toContain("/admin/redteam/probe-packs/import-review?");
    expect(first?.[1]?.method).toBe("POST");
    expect(first?.[1]?.body).toBe(csv);
    expect(new Headers(first?.[1]?.headers).has("If-Match")).toBe(false);
    await expect(applyReviewedProbePrompts(csv, review.revision)).resolves.toMatchObject({
      review_applied: true,
      skipped: [],
    });
    const second = fetch.mock.calls[1];
    expect(second?.[0]).toBe("/admin/redteam/probe-packs/import");
    expect(second?.[1]?.method).toBe("PUT");
    expect(second?.[1]?.body).toBe(csv);
    expect(new Headers(second?.[1]?.headers).get("If-Match")).toBe('"' + review.revision + '"');
    expect(second?.[1]?.redirect).toBe("error");
    expect(second?.[1]?.cache).toBe("no-store");
  });

  it("binds read pages to the same revision and rejects inconsistent response counts", async () => {
    const review = probeCsvReviewFixture();
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ ...review, total_items: 99 }), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      reviewProbePrompts("case_key,input_template\nk,t\n", 20, review.revision),
    ).rejects.toMatchObject({ kind: "contract" });
    expect(new Headers(fetch.mock.calls[0]?.[1]?.headers).get("If-Match")).toBe('"' + review.revision + '"');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("does not refresh, replay or use legacy POST after reviewed PUT authentication failure", async () => {
    tokenStore.saveTokens({ access_token: "synthetic-probe-session", refresh_token: "synthetic-refresh" });
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            error: { message: "synthetic rejection", type: "invalid_request_error", code: "invalid_api_key" },
          }),
          { status: 401, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      applyReviewedProbePrompts("case_key,input_template\nk,t\n", "a".repeat(64)),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[1]?.method).toBe("PUT");
  });
});
