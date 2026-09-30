import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useHealthActions } from "./use-health-actions";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import type * as MutationFeedbackModule from "@/shared/hooks/use-mutation-feedback";
import { mockApi } from "@/test/api";

const access = vi.hoisted(() => ({ write: true, readOnly: false, owner: "gateway.health", missing: false }));
const callbacks = vi.hoisted(() => new Map<string, (value: unknown) => Promise<unknown>>());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({ scopes: ["admin:write", "routing:read", ...(access.write ? ["routing:write"] : [])] }),
  };
});
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
  access.owner = "gateway.health";
  access.missing = false;
  callbacks.clear();
  tokenStore.clearAll();
});
function setup() {
  const api = mockApi({
    "POST /admin/routing/breaker-reset": () => ({}),
    "POST /admin/routing/balancer": () => ({}),
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
  return { api, ...renderHook(() => useHealthActions(), { wrapper: Wrapper }) };
}
describe("두 복구 API 실제 전송 경계", () => {
  for (const [message, endpoint] of [
    ["회로 차단기를 해제하지 못했습니다.", "POST /admin/routing/breaker-reset"],
    ["세션 고정을 해제하지 못했습니다.", "POST /admin/routing/balancer"],
  ] as const) {
    it.each(["readonly", "permission", "owner", "missing", "session"])(
      `${endpoint}의 최신 %s는 캡처된 실제 callback도 차단한다`,
      async (boundary) => {
        const current = setup();
        const captured = callbacks.get(message);
        if (!captured) throw new Error("missing real recovery callback");
        if (boundary === "readonly") access.readOnly = true;
        if (boundary === "permission") access.write = false;
        if (boundary === "owner") access.owner = "gateway.providers";
        if (boundary === "missing") access.missing = true;
        if (boundary === "session") act(() => tokenStore.clearAll());
        current.rerender();
        await expect(Promise.resolve().then(() => captured("exact-provider"))).rejects.toBeDefined();
        expect(current.api.calls).toEqual([]);
        access.readOnly = false;
        access.write = true;
        access.owner = "gateway.health";
        access.missing = false;
        current.rerender();
        expect(current.api.calls).toEqual([]);
        const latest = callbacks.get(message);
        if (!latest) throw new Error("missing current recovery callback");
        await latest("exact-provider");
        expect(current.api.calls).toHaveLength(1);
        expect(current.api.bodies(endpoint)).toEqual([{ provider: "exact-provider" }]);
      },
    );
  }
});
