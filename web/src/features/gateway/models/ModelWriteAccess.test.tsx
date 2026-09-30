import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { modelGovernanceKeys, useModelGovernanceMutations } from "./use-model-governance";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type * as Feedback from "@/shared/hooks/use-mutation-feedback";
import { mockApi } from "@/test/api";

const current = vi.hoisted(() => ({ write: true, readOnly: false, owner: "gateway.models", missing: false }));
const callbacks = vi.hoisted(() => new Map<string, (value: unknown) => Promise<unknown>>());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", ...(current.write ? ["admin:write"] : [])] }) };
});
vi.mock("@/shared/hooks/use-mutation-feedback", async (load) => {
  const real = await load<typeof Feedback>();
  return {
    useMutationFeedback: (options: Parameters<typeof real.useMutationFeedback>[0]) => {
      callbacks.set(options.errorMessage ?? "", options.mutate);
      return real.useMutationFeedback(options);
    },
  };
});
const operations = [
  [
    "모델 계약을 저장하지 못했습니다.",
    "POST /admin/models/contracts",
    "contracts",
    { id: "mcon_original", name: "고정 계약" },
  ],
  ["모델 계약을 삭제하지 못했습니다.", "DELETE /admin/models/contracts", "contracts", "mcon_original"],
  [
    "지원 종료 정책을 저장하지 못했습니다.",
    "POST /admin/model-deprecations",
    "deprecations",
    { model_glob: "old-*" },
  ],
  [
    "지원 종료 정책을 삭제하지 못했습니다.",
    "DELETE /admin/model-deprecations/moddep_original",
    "deprecations",
    "moddep_original",
  ],
] as const;
function setup() {
  const api = mockApi(
    Object.fromEntries([
      ...operations.map(([, endpoint]) => [endpoint, () => ({})]),
      ["POST /admin/models/contracts/run", () => ({})],
    ]),
  );
  // No useQuery observer is mounted here; keep seeded prerequisites for the
  // captured-callback test instead of GC racing the invalidation await.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  for (const kind of ["contracts", "deprecations"] as const)
    client.setQueryData(modelGovernanceKeys[kind], { [kind]: [] });
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessContext.Provider
          value={
            current.missing
              ? undefined
              : { featureId: current.owner, readOnly: current.readOnly, permitted: true }
          }
        >
          {children}
        </FeatureAccessContext.Provider>
      </QueryClientProvider>
    );
  }
  return { api, client, ...renderHook(() => useModelGovernanceMutations(), { wrapper: Wrapper }) };
}
beforeEach(() => {
  Object.assign(current, { write: true, readOnly: false, owner: "gateway.models", missing: false });
  callbacks.clear();
  tokenStore.clearAll();
});

describe("모델 관리 실제 mutation callback 경계", () => {
  for (const [message, endpoint, kind, value] of operations) {
    it.each(["readonly", "permission", "owner", "missing", "session", "invalidated", "fetching", "error"])(
      `${endpoint}: 캡처된 callback도 최신 %s에서 전송0, 복구후 수동1`,
      async (boundary) => {
        const view = setup();
        const captured = callbacks.get(message);
        if (!captured) throw new Error("missing actual mutation callback");
        if (boundary === "readonly") current.readOnly = true;
        if (boundary === "permission") current.write = false;
        if (boundary === "owner") current.owner = "gateway.chat";
        if (boundary === "missing") current.missing = true;
        if (boundary === "session") act(() => tokenStore.clearAll());
        if (boundary === "invalidated")
          await act(async () => {
            await view.client.invalidateQueries({ queryKey: modelGovernanceKeys[kind], refetchType: "none" });
          });
        if (boundary === "fetching" || boundary === "error")
          act(() =>
            view.client
              .getQueryCache()
              .find({ queryKey: modelGovernanceKeys[kind] })
              ?.setState(
                boundary === "fetching"
                  ? { fetchStatus: "fetching" }
                  : { status: "error", error: new Error("synthetic") },
              ),
          );
        view.rerender();
        await expect(Promise.resolve().then(() => captured(value))).rejects.toBeDefined();
        expect(view.api.calls).toEqual([]);
        Object.assign(current, { write: true, readOnly: false, owner: "gateway.models", missing: false });
        act(() =>
          view.client
            .getQueryCache()
            .find({ queryKey: modelGovernanceKeys[kind] })
            ?.setState({ status: "success", error: null, fetchStatus: "idle", isInvalidated: false }),
        );
        view.rerender();
        expect(view.api.calls).toEqual([]);
        const latest = callbacks.get(message);
        if (!latest) throw new Error("missing latest mutation callback");
        await latest(value);
        expect(view.api.calls).toHaveLength(1);
        expect(view.api.calls[0]?.key).toBe(endpoint);
        if (typeof value === "object") expect(view.api.bodies(endpoint)).toEqual([value]);
        else if (kind === "contracts") expect(view.api.calls[0]?.options.query).toEqual({ id: value });
      },
    );
  }
  it("확인된 빈 목록이 없으면 직접 저장도 허용하지 않는다", async () => {
    const view = setup();
    act(() => view.client.clear());
    const save = callbacks.get(operations[0][0]);
    if (!save) throw new Error("missing save callback");
    await expect(Promise.resolve().then(() => save({ name: "새 계약" }))).rejects.toBeDefined();
    expect(view.api.calls).toEqual([]);
  });
  it("순수 계약 검증은 readonly·목록미확인에서도 기존 admin:write로 허용한다", async () => {
    current.readOnly = true;
    const view = setup();
    act(() => view.client.clear());
    const run = callbacks.get("계약 검증을 실행하지 못했습니다.");
    if (!run) throw new Error("missing run callback");
    await run({ model: "public-model" });
    expect(view.api.calls).toHaveLength(1);
    expect(view.api.bodies("POST /admin/models/contracts/run")).toEqual([{ model: "public-model" }]);
  });
  it.each(["permission", "owner", "missing", "session"])(
    "순수 검증도 이전 %s callback의 권한·세션을 새로 부여하지 않는다",
    async (boundary) => {
      const view = setup();
      const run = callbacks.get("계약 검증을 실행하지 못했습니다.");
      if (!run) throw new Error("missing run callback");
      if (boundary === "permission") current.write = false;
      if (boundary === "owner") current.owner = "gateway.chat";
      if (boundary === "missing") current.missing = true;
      if (boundary === "session") act(() => tokenStore.clearAll());
      view.rerender();
      await expect(Promise.resolve().then(() => run({ model: "public-model" }))).rejects.toBeDefined();
      expect(view.api.calls).toEqual([]);
    },
  );
});
