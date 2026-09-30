import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useProviderAdmin } from "./use-provider-admin";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type * as MutationFeedbackModule from "@/shared/hooks/use-mutation-feedback";
import { mockApi } from "@/test/api";

const access = vi.hoisted(() => ({
  write: true,
  readOnly: false,
  owner: "gateway.providers",
  missing: false,
}));
const callbacks = vi.hoisted(() => new Map<string, (value: unknown) => Promise<unknown>>());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", ...(access.write ? ["admin:write"] : [])] }) };
});
// Invoke the actual pre-request callback, not a disabled DOM button.
vi.mock("@/shared/hooks/use-mutation-feedback", async (load) => {
  const real = await load<typeof MutationFeedbackModule>();
  return {
    useMutationFeedback: (options: Parameters<typeof real.useMutationFeedback>[0]) => {
      callbacks.set(options.errorMessage ?? "", options.mutate);
      return real.useMutationFeedback(options);
    },
  };
});
beforeEach(() => {
  access.write = true;
  access.readOnly = false;
  access.owner = "gateway.providers";
  access.missing = false;
  callbacks.clear();
  tokenStore.clearAll();
});
function setup() {
  const api = mockApi({
    "POST /admin/providers": () => ({}),
    "DELETE /admin/providers/exact-provider": () => ({}),
    "POST /admin/providers/slo": () => ({}),
    "DELETE /admin/providers/slo": () => ({}),
  });
  const client = new QueryClient();
  function Wrapper({ children }: PropsWithChildren) {
    return (
      <QueryClientProvider client={client}>
        <FeatureAccessContext.Provider
          value={
            access.missing
              ? undefined
              : { featureId: access.owner, permitted: true, readOnly: access.readOnly }
          }
        >
          {children}
        </FeatureAccessContext.Provider>
      </QueryClientProvider>
    );
  }
  return { api, ...renderHook(() => useProviderAdmin(), { wrapper: Wrapper }) };
}
const operations = [
  [
    "공급자 설정을 저장하지 못했습니다.",
    "POST /admin/providers",
    { name: "exact-provider", base_url: "https://public.example.invalid/v1" },
  ],
  ["공급자를 삭제하지 못했습니다.", "DELETE /admin/providers/exact-provider", "exact-provider"],
  [
    "공급자 서비스 목표를 저장하지 못했습니다.",
    "POST /admin/providers/slo",
    {
      provider: "exact-provider",
      availability_target: 0.99,
      p95_latency_target_ms: 2000,
      error_rate_target: 0.02,
      fallback_rate_target: 0.1,
      enabled: true,
    },
  ],
  ["공급자 서비스 목표를 삭제하지 못했습니다.", "DELETE /admin/providers/slo", "exact-provider"],
] as const;
describe("공급자 네 API 실제 전송 경계", () => {
  for (const [message, endpoint, value] of operations) {
    it.each(["readonly", "permission", "owner", "missing", "session"])(
      `${endpoint}의 캡처된 callback은 최신 %s를 확인한다`,
      async (boundary) => {
        const current = setup();
        const captured = callbacks.get(message);
        if (!captured) throw new Error("missing real mutation callback");
        if (boundary === "readonly") access.readOnly = true;
        if (boundary === "permission") access.write = false;
        if (boundary === "owner") access.owner = "gateway.health";
        if (boundary === "missing") access.missing = true;
        if (boundary === "session") act(() => tokenStore.clearAll());
        current.rerender();
        await expect(Promise.resolve().then(() => captured(value))).rejects.toBeDefined();
        expect(current.api.calls).toEqual([]);
        access.readOnly = false;
        access.write = true;
        access.owner = "gateway.providers";
        access.missing = false;
        current.rerender();
        expect(current.api.calls).toEqual([]);
        const latest = callbacks.get(message);
        if (!latest) throw new Error("missing current mutation callback");
        await latest(value);
        expect(current.api.calls).toHaveLength(1);
        expect(current.api.calls[0]?.key).toBe(endpoint);
        if (endpoint === "DELETE /admin/providers/slo")
          expect(current.api.calls[0]?.options.query).toEqual({ provider: "exact-provider" });
      },
    );
  }
  it("context가 처음부터 없으면 네 public mutateAsync도 모두 전송하지 않는다", async () => {
    access.missing = true;
    const current = setup();
    await act(async () => {
      await expect(
        current.result.current.save.mutateAsync({ name: "name", base_url: "https://public.example.invalid" }),
      ).rejects.toBeDefined();
      await expect(current.result.current.remove.mutateAsync("exact-provider")).rejects.toBeDefined();
      await expect(
        current.result.current.saveSlo.mutateAsync({
          provider: "exact-provider",
          availability_target: 0.99,
          p95_latency_target_ms: 2000,
          error_rate_target: 0.02,
          fallback_rate_target: 0.1,
          enabled: true,
        }),
      ).rejects.toBeDefined();
      await expect(current.result.current.removeSlo.mutateAsync("exact-provider")).rejects.toBeDefined();
    });
    expect(current.api.calls).toEqual([]);
  });
});
