import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentType } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WarehousePage } from "@/features/data/warehouse/WarehousePage";
import { AssetsPage } from "@/features/governance/assets/AssetsPage";
import { ReportsPage } from "@/features/governance/reports/ReportsPage";
import { SecurityOverviewPage } from "@/features/security/overview/SecurityOverviewPage";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";

const auth = vi.hoisted(() => ({ id: "fixture_a", read: true }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { id: auth.id }, scopes: auth.read ? ["admin:read"] : [] }) };
});

interface ExportCase {
  name: string;
  Page: ComponentType;
  route: string;
  featureId: string;
  button: string;
  filter: string;
  next: string;
  path: string;
  query: Record<string, string>;
  contentType: string;
  filename: RegExp;
  body: string;
}
const cases: ExportCase[] = [
  {
    name: "scorecard",
    Page: ReportsPage,
    route: "/governance/reports",
    featureId: "governance.reports",
    button: "CSV 다운로드",
    filter: "조회 기간",
    next: "7d",
    path: "/admin/teams/scorecard",
    query: { window: "30d", format: "csv" },
    contentType: "text/csv",
    filename: /^team-scorecard-\d{4}-\d{2}-\d{2}\.csv$/u,
    body: "team,cost\r\n공개 합성 팀,9007199254740993\r\n",
  },
  {
    name: "narrative",
    Page: ReportsPage,
    route: "/governance/reports?tab=narrative",
    featureId: "governance.reports",
    button: "마크다운 다운로드",
    filter: "조회 기간",
    next: "7d",
    path: "/admin/reports/narrative",
    query: { window: "30d", format: "md" },
    contentType: "text/markdown",
    filename: /^ai-gateway-report-\d{4}-\d{2}-\d{2}\.md$/u,
    body: "# 공개 합성 보고서\r\n\r\n  원본 공백과 줄바꿈  \r\n",
  },
  {
    name: "sbom",
    Page: AssetsPage,
    route: "/governance/assets",
    featureId: "governance.assets",
    button: "JSON 내보내기",
    filter: "자산 유형",
    next: "skill",
    path: "/admin/sbom",
    query: {},
    contentType: "application/json",
    filename: /^ai-asset-sbom\.json$/u,
    body: ' {"name":"공개 합성 자산","large":9007199254740993}\n',
  },
  {
    name: "privacy",
    Page: SecurityOverviewPage,
    route: "/security/overview?tab=privacy",
    featureId: "security.overview",
    button: "CSV 내보내기",
    filter: "차원",
    next: "model",
    path: "/admin/privacy-ledger",
    query: { dimension: "team", days: "30", format: "csv" },
    contentType: "text/csv",
    filename: /^privacy-ledger-team\.csv$/u,
    body: "team,detections\r\n공개 합성 팀,2\r\n",
  },
  {
    name: "warehouse",
    Page: WarehousePage,
    route: "/data/warehouse",
    featureId: "data.warehouse",
    button: "CSV 내보내기",
    filter: "분석 차원",
    next: "provider",
    path: "/admin/dw/dashboard/export.csv",
    query: { window: "30d", dimension: "model", order_by: "cost", limit: "100" },
    contentType: "text/csv",
    filename: /^dw-dashboard-model-\d{4}-\d{2}-\d{2}\.csv$/u,
    body: "model,cost\r\n공개 합성 모델,9007199254740993\r\n",
  },
];
const allocate = vi.fn<(blob: Blob) => string>();
const NativeURL = URL;
beforeEach(() => {
  Object.assign(auth, { id: "fixture_a", read: true });
  tokenStore.clearAll();
  allocate.mockReset().mockReturnValue("blob:fixture-export");
  vi.stubGlobal(
    "URL",
    class extends NativeURL {
      static override createObjectURL = allocate;
      static override revokeObjectURL = vi.fn();
    },
  );
  mockApi({
    "GET /admin/teams/scorecard": () => ({ teams: [] }),
    "GET /admin/reports/narrative": () => ({
      sections: [],
      period_start: "2026-10-01",
      period_end: "2026-10-31",
    }),
    "GET /admin/sbom": () => ({ entries: [], by_type: {} }),
    "GET /admin/privacy-ledger": () => ({ rows: [] }),
    "GET /admin/dw/dashboard/overview": () => ({ configured: true }),
    "GET /admin/dw/dashboard/timeseries": () => ({ points: [] }),
    "GET /admin/dw/dashboard/dimensions": () => ({ configured: true, rows: [] }),
    "GET /admin/dw/dashboard/latency": () => ({ by_model: [] }),
    "GET /admin/dw/dashboard/quality": () => ({}),
    "GET /admin/dw/dashboard/routing": () => ({ reasons: [], rewrites: [] }),
    "GET /admin/dw/dashboard/text2sql": () => ({ by_mode: [], failures: [] }),
    "GET /admin/savings": () => ({ scopes: [] }),
    "GET /admin/model-migration": () => ({ recommendations: [] }),
  });
});
afterEach(() => {
  tokenStore.clearAll();
  vi.unstubAllGlobals();
});

function mount(item: ExportCase) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const { Page } = item;
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[item.route]}>
        <FeatureAccessContext
          value={{ featureId: item.featureId, permitted: true, readOnly: true, status: "preview" }}
        >
          <Page />
        </FeatureAccessContext>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()) };
}

function expectRequest(item: ExportCase, input: RequestInfo | URL, init?: RequestInit) {
  const url = new NativeURL(String(input), "http://localhost");
  expect(url.pathname).toBe(item.path);
  expect(Object.fromEntries(url.searchParams)).toEqual(item.query);
  expect(init).toMatchObject({ credentials: "same-origin", redirect: "error" });
  expect(new Headers(init?.headers).get("X-Vibe-UI")).toBe("app");
}

for (const item of cases) {
  describe(`${item.name} screen file ownership`, () => {
    it.each(["filters", "account", "read permission", "unmount"])(
      "cancels an incomplete body after %s changes",
      async (boundary) => {
        const cancel = vi.fn();
        const pulled = vi.fn();
        let requestSignal: AbortSignal | null | undefined;
        const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
          requestSignal = init?.signal;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(item.body.slice(0, 4)));
              },
              pull: pulled,
              cancel,
            }),
            { headers: { "Content-Type": `${item.contentType}; charset=utf-8` } },
          );
        });
        vi.stubGlobal("fetch", fetch);
        const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
        const view = mount(item);
        await waitFor(() => expect(screen.getByRole("button", { name: item.button })).toBeEnabled());
        await userEvent.click(screen.getByRole("button", { name: item.button }));
        await waitFor(() => expect(pulled).toHaveBeenCalled());
        const call = fetch.mock.calls[0];
        if (!call) throw new Error("missing file request");
        expectRequest(item, ...call);
        if (boundary === "filters")
          await userEvent.selectOptions(screen.getByRole("combobox", { name: item.filter }), item.next);
        else if (boundary === "unmount") view.unmount();
        else {
          if (boundary === "account") auth.id = "fixture_b";
          else auth.read = false;
          view.refresh();
        }
        await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
        await act(async () => {});
        expect(requestSignal?.aborted).toBe(true);
        expect(fetch).toHaveBeenCalledOnce();
        expect(allocate).not.toHaveBeenCalled();
        expect(click).not.toHaveBeenCalled();
        expect(notifications.success).not.toHaveBeenCalled();
        expect(notifications.error).not.toHaveBeenCalled();
      },
    );

    it("downloads the exact response bytes with the existing query and filename", async () => {
      const fetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => {
        return new Response(item.body, { headers: { "Content-Type": `${item.contentType}; charset=utf-8` } });
      });
      vi.stubGlobal("fetch", fetch);
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
        this: HTMLAnchorElement,
      ) {
        expect(this.download).toMatch(item.filename);
        expect(this.isConnected).toBe(true);
      });
      mount(item);
      await waitFor(() => expect(screen.getByRole("button", { name: item.button })).toBeEnabled());
      await userEvent.click(screen.getByRole("button", { name: item.button }));
      await waitFor(() => expect(click).toHaveBeenCalledOnce());
      expect(fetch).toHaveBeenCalledOnce();
      const call = fetch.mock.calls[0];
      if (!call) throw new Error("missing file request");
      expectRequest(item, ...call);
      const blob = allocate.mock.calls[0]?.[0];
      if (!blob) throw new Error("missing downloaded file");
      expect(blob.type).toBe(`${item.contentType}; charset=utf-8`);
      const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = reject;
        reader.readAsArrayBuffer(blob);
      });
      expect(Array.from(new Uint8Array(bytes))).toEqual(Array.from(new TextEncoder().encode(item.body)));
      expect(document.querySelector("a[download]")).toBeNull();
      expect(notifications.error).not.toHaveBeenCalled();
    });
  });
}
