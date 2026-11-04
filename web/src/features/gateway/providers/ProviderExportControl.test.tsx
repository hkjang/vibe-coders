import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import * as downloads from "@/shared/utils/csv";
import * as exporter from "./provider-csv";
import { ProviderExportControl } from "./ProviderExportControl";

const runtime = vi.hoisted(() => ({
  id: "public-a",
  team: "public-team",
  scopes: ["admin:read"],
  prefixes: ["vc_sk_"],
  permitted: true,
  readonly: false,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
      credentialPrefixes: runtime.prefixes,
    }),
  };
});
const snapshot = {
  providers: {
    providers: [
      {
        name: "공개 공급자",
        provider_ref: "prv_" + "x".repeat(43),
        base_url: "https://public.example.invalid",
        api_key_configured: true,
        timeout_ms: 1000,
        enabled: true,
        model_patterns: "*",
        failover_group: "public",
        priority: 1,
        created_at: "2026-01-01T00:00:00Z",
      },
    ],
  },
  slo: { slos: [], evaluations: [], since: "2026-10-14T00:00:00Z" },
  routing: undefined,
};
function deferred() {
  let resolve!: (value: typeof snapshot) => void;
  const promise = new Promise<typeof snapshot>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function setup() {
  let filters: exporter.ProviderExportFilters = { query: "", status: "all", range: "24h" };
  let blocked = false;
  const tree = () => (
    <FeatureAccessContext.Provider
      value={{
        featureId: "gateway.providers",
        permitted: runtime.permitted,
        readOnly: runtime.readonly,
        status: runtime.readonly ? "preview_read_only" : "preview",
      }}
    >
      <ProviderExportControl filters={filters} blocked={blocked} />
    </FeatureAccessContext.Provider>
  );
  const view = render(tree());
  const read = vi.spyOn(exporter, "loadProviderExport").mockResolvedValue(snapshot);
  const download = vi.spyOn(downloads, "downloadCsv").mockImplementation(() => undefined);
  return {
    ...view,
    read,
    download,
    user: userEvent.setup(),
    button: () => screen.getByRole("button", { name: "CSV 내보내기" }),
    update: (next?: Partial<exporter.ProviderExportFilters>, deny = false) => {
      filters = { ...filters, ...next };
      blocked = deny;
      view.rerender(tree());
    },
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    id: "public-a",
    team: "public-team",
    scopes: ["admin:read"],
    prefixes: ["vc_sk_"],
    permitted: true,
    readonly: false,
  });
  tokenStore.clearAll();
});
describe("공급자 내보내기 수명", () => {
  it("읽기 전용에서도 최신 목록만 다운로드하며 중복 클릭을 합친다", async () => {
    runtime.readonly = true;
    const c = setup();
    const pending = deferred();
    c.read.mockReturnValue(pending.promise);
    const button = c.button();
    button.focus();
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    expect(c.read).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(c.download).not.toHaveBeenCalled();
    await act(async () => pending.resolve(snapshot));
    expect(c.download).toHaveBeenCalledTimes(1);
    expect(button).toHaveFocus();
    expect(button).not.toHaveAttribute("aria-disabled");
    expect(c.download.mock.calls[0]?.[0]).toBe("공급자-목록.csv");
    expect(screen.getByRole("status")).toHaveTextContent("1개 공급자");
    expect(c.read.mock.calls[0]?.[1]).toBe(false);
  });
  it.each(["id", "team", "scopes", "prefixes", "permitted", "filter", "session", "unmount"] as const)(
    "%s 변경 후 늦은 응답은 파일을 만들지 않는다",
    async (kind) => {
      const c = setup();
      const pending = deferred();
      c.read.mockReturnValue(pending.promise);
      await c.user.click(c.button());
      const signal = c.read.mock.calls[0]?.[2];
      if (kind === "session") act(() => tokenStore.clearAll());
      else if (kind === "unmount") c.unmount();
      else if (kind === "filter") c.update({ status: "disabled" });
      else {
        if (kind === "id" || kind === "team") runtime[kind] = "public-b";
        if (kind === "scopes") runtime.scopes = [];
        if (kind === "prefixes") runtime.prefixes = ["corp_"];
        if (kind === "permitted") runtime.permitted = false;
        c.update();
        if (kind === "id") {
          runtime.id = "public-a";
          c.update();
        }
      }
      expect(signal?.aborted).toBe(true);
      await act(async () => pending.resolve(snapshot));
      expect(c.download).not.toHaveBeenCalled();
    },
  );
  it("권한과 유효한 필터가 없으면 읽기 요청도 보내지 않는다", async () => {
    runtime.scopes = [];
    const c = setup();
    expect(c.button()).toBeDisabled();
    await c.user.click(c.button());
    runtime.scopes = ["admin:read"];
    c.update(undefined, true);
    expect(c.button()).toBeDisabled();
    expect(c.read).not.toHaveBeenCalled();
  });
  it("실패는 원문 없이 요청 ID를 안내하고 수동으로만 다시 시도한다", async () => {
    const c = setup();
    c.read.mockRejectedValueOnce(
      new AppError("never-show-private-body", {
        kind: "http",
        status: 503,
        requestId: "public-export-request",
      }),
    );
    await c.user.click(c.button());
    expect(await screen.findByRole("alert")).toHaveTextContent("public-export-request");
    expect(screen.getByRole("alert")).not.toHaveTextContent("never-show-private-body");
    expect(c.read).toHaveBeenCalledTimes(1);
    expect(c.download).not.toHaveBeenCalled();
    await c.user.click(c.button());
    await waitFor(() => expect(c.download).toHaveBeenCalledTimes(1));
  });
  it("빈 결과는 파일 없이 설명하고 라우팅 권한은 현재 값으로 전달한다", async () => {
    runtime.scopes = ["admin:read", "routing:read"];
    const c = setup();
    c.read.mockResolvedValue({ ...snapshot, providers: { providers: [] } });
    await c.user.click(c.button());
    expect(await screen.findByRole("status")).toHaveTextContent("파일을 만들지 않았습니다");
    expect(c.read.mock.calls[0]?.[1]).toBe(true);
    expect(c.download).not.toHaveBeenCalled();
  });
});
