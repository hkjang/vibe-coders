import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import { apiFailure, type ApiHandler, mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { AuditTab } from "./AuditTab";

const identity = vi.hoisted(() => ({ id: "a", team: "team-a", raw: true, scopes: ["admin:read"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        user: { id: identity.id, team_id: identity.team },
        scopes: identity.scopes,
        rawPromptView: identity.raw,
      }),
  };
});
const csv =
  "created_at,kind,actor,action,detail_before,detail_after\n2026-11-17,admin_audit,운영자,설정 변경,,공개 값\n";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup(overrides: Record<string, ApiHandler> = {}) {
  const pending = deferred<string>();
  const api = mockApi({
    "GET /admin/audit-logs": () => ({ audit_logs: [] }),
    "GET /admin/audit/auth-events": () => ({ events: [] }),
    "GET /admin/audit-logs.csv": () => pending.promise,
    ...overrides,
  });
  // The original component bypasses the API client. Keep this transport in the
  // before-fix reproduction; the fixed component must use the typed endpoint.
  const fetch = vi.fn(
    async () => new Response(await pending.promise, { headers: { "Content-Type": "text/csv" } }),
  );
  vi.stubGlobal("fetch", fetch);
  const clicks = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  vi.stubGlobal(
    "URL",
    class extends URL {
      static override createObjectURL = vi.fn((blob: Blob) => {
        expect(blob.type).toBe("text/csv;charset=utf-8");
        return "blob:public-audit";
      });
      static override revokeObjectURL = vi.fn();
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <FeatureAccessHarness featureId="system.settings">
          <AuditTab />
        </FeatureAccessHarness>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, refresh: () => view.rerender(tree()), pending, clicks, api, fetch, client };
}
beforeEach(() => Object.assign(identity, { id: "a", team: "team-a", raw: true, scopes: ["admin:read"] }));

it("화면을 닫은 뒤 도착한 CSV 응답은 다운로드하지 않는다", async () => {
  const c = setup();
  await userEvent.click(await screen.findByRole("button", { name: "감사 로그 CSV 다운로드" }));
  await waitFor(() =>
    expect(c.fetch.mock.calls.length + c.api.bodies("GET /admin/audit-logs.csv").length).toBe(1),
  );
  c.unmount();
  await act(async () => {
    c.pending.resolve(csv);
  });
  expect(c.clicks).not.toHaveBeenCalled();
});

for (const change of ["계정", "팀", "원문 권한", "조회 권한", "세션"] as const)
  it(`${change} 변경 뒤 이전 CSV 응답은 다운로드하지 않는다`, async () => {
    const c = setup();
    await userEvent.click(await screen.findByRole("button", { name: "감사 로그 CSV 다운로드" }));
    const call = c.api.spy.mock.calls.find(([endpoint]) => endpoint.path === "/admin/audit-logs.csv");
    expect(call?.[1]?.signal?.aborted).toBe(false);
    act(() => {
      if (change === "계정") identity.id = "b";
      if (change === "팀") identity.team = "team-b";
      if (change === "원문 권한") identity.raw = false;
      if (change === "조회 권한") identity.scopes = [];
      if (change === "세션") tokenStore.clearAll();
    });
    c.refresh();
    await act(async () => {
      c.pending.resolve(csv);
    });
    expect(call?.[1]?.signal?.aborted).toBe(true);
    expect(c.clicks).not.toHaveBeenCalled();
    expect(screen.queryByText("CSV 다운로드 시작")).not.toBeInTheDocument();
  });

it("준비 중 중복 요청을 막고 취소 후 새 요청의 완료만 다운로드한다", async () => {
  const first = deferred<string>(),
    second = deferred<string>();
  let reads = 0;
  const c = setup({ "GET /admin/audit-logs.csv": () => (++reads === 1 ? first.promise : second.promise) });
  const button = await screen.findByRole("button", { name: "감사 로그 CSV 다운로드" });
  await userEvent.dblClick(button);
  expect(reads).toBe(1);
  expect(button).toBeDisabled();
  expect(screen.getByText(/각각 최대 5,000건/u)).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "다운로드 취소" }));
  await waitFor(() => expect(button).toHaveFocus());
  await userEvent.click(button);
  expect(reads).toBe(2);
  await act(async () => {
    first.resolve(csv);
  });
  expect(c.clicks).not.toHaveBeenCalled();
  expect(button).toBeDisabled();
  await act(async () => {
    second.resolve(csv);
  });
  expect(c.clicks).toHaveBeenCalledOnce();
  expect(button).toBeEnabled();
  expect(c.fetch).not.toHaveBeenCalled();
  expect(
    c.api.calls.filter((c) => c.key === "GET /admin/audit-logs.csv").map((c) => c.options.query),
  ).toEqual([{ limit: 5000 }, { limit: 5000 }]);
});

it.each([401, 403, 503])("CSV %s 오류는 안전한 안내·요청 ID와 명시적인 재시도를 제공한다", async (status) => {
  let fail = true;
  const c = setup({
    "GET /admin/audit-logs.csv": () => {
      if (fail) throw apiFailure("private-server-detail", status, "public-csv-request");
      return csv;
    },
  });
  await userEvent.click(await screen.findByRole("button", { name: "감사 로그 CSV 다운로드" }));
  expect(await screen.findByText("요청 ID: public-csv-request")).toBeVisible();
  expect(screen.queryByText("private-server-detail")).not.toBeInTheDocument();
  expect(c.api.bodies("GET /admin/audit-logs.csv")).toHaveLength(1);
  expect(c.clicks).not.toHaveBeenCalled();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await waitFor(() => expect(c.clicks).toHaveBeenCalledOnce());
  expect(screen.queryByText("요청 ID: public-csv-request")).not.toBeInTheDocument();
});

it.each(["", "\uFEFF"])("서버 BOM %j에도 한글 CSV에 BOM을 한 번만 넣는다", async (bom) => {
  const c = setup({ "GET /admin/audit-logs.csv": () => bom + csv });
  await userEvent.click(await screen.findByRole("button", { name: "감사 로그 CSV 다운로드" }));
  await waitFor(() => expect(c.clicks).toHaveBeenCalledOnce());
  const blob = vi.mocked(URL.createObjectURL).mock.calls[0]?.[0] as Blob;
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(blob);
  });
  expect(Array.from(new Uint8Array(bytes).slice(0, 3))).toEqual([239, 187, 191]);
  expect(new TextDecoder().decode(bytes)).toBe(csv);
});

it("최종 조회 거부는 기록 캐시를 폐기하고 진행 중 다운로드를 취소한다", async () => {
  let denied = false;
  const c = setup({
    "GET /admin/audit-logs": () => {
      if (denied) throw apiFailure("거부", 403);
      return {
        audit_logs: [
          {
            id: "public-log",
            admin_id: "이전 운영자",
            action: "public.action",
            created_at: "2026-11-17T00:00:00Z",
          },
        ],
      };
    },
  });
  expect(await screen.findByText("이전 운영자")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "감사 로그 CSV 다운로드" }));
  denied = true;
  await act(() => c.client.invalidateQueries({ queryKey: ["system", "audit"] }));
  expect(await screen.findByText("감사 기록 조회 권한 확인 필요")).toBeVisible();
  await act(async () => {
    c.pending.resolve(csv);
  });
  expect(c.clicks).not.toHaveBeenCalled();
  expect(screen.queryByText("이전 운영자")).not.toBeInTheDocument();
  expect(c.client.getQueriesData({ queryKey: ["system", "audit"] })).toEqual([]);
});
