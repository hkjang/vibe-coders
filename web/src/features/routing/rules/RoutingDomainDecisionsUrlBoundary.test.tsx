import { act, waitFor } from "@testing-library/react";
import { useSearchParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { renderScreen } from "@/test/render";
import { DomainDecisionsSection } from "./DomainDecisionsSection";

const auth = vi.hoisted(() => ({
  version: 0,
  prefixes: ["vc_sk_", "vc_sa_"],
  listeners: new Set<() => void>(),
}));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { useSyncExternalStore } = await import("react");
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      // Update every auth consumer, including RouteQueryGuard above the feature.
      // A feature-only rerender would not model a real AuthProvider update.
      useSyncExternalStore(
        (listener) => {
          auth.listeners.add(listener);
          return () => auth.listeners.delete(listener);
        },
        () => auth.version,
      );
      return {
        ...testAuth({ scopes: ["routing:read"], rawPromptView: true }),
        credentialPrefixes: auth.prefixes,
      };
    },
  };
});

beforeEach(() => {
  auth.version = 0;
  auth.prefixes = ["vc_sk_", "vc_sa_"];
  tokenStore.clearAll();
});

describe("도메인 결정 URL — 공유 인증 변경 경계", () => {
  it.each(["request_id", "route"])(
    "새 자격 증명 접두사가 기존 %s 주소를 민감정보로 만들면 새 GET과 캐시에서 먼저 제거한다",
    async (parameter) => {
      const value = `public_new_prefix_${"SYNTHETIC_ONLY_".repeat(4)}`;
      const calls: Array<Record<string, string>> = [];
      const transport = new ApiClient({
        fetch: async (input, init) => {
          const url = new URL(String(input), "https://synthetic.invalid");
          if (init?.method !== "GET" || url.pathname !== "/admin/routing/domain-decisions") {
            throw new Error("Unexpected synthetic decision transport");
          }
          calls.push(Object.fromEntries(url.searchParams));
          return new Response(JSON.stringify({ decisions: [], signals: {} }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        },
      });
      vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
        transport.request(endpoint, ...args),
      );
      const feature = migrationRegistry.find((item) => item.featureId === "routing.rules");
      if (!feature) throw new Error("Routing feature missing");
      const routingFeature = feature;
      function Feature() {
        const [params] = useSearchParams();
        return (
          <FeatureRoute feature={routingFeature}>
            <DomainDecisionsSection window="7d" route={params.get("route") ?? ""} />
          </FeatureRoute>
        );
      }
      const view = renderScreen(<Feature />, {
        route: `/routing/rules/learning?${parameter}=${encodeURIComponent(value)}`,
        path: "/routing/rules/*",
      });
      const queries = () => view.client.getQueryCache().getAll();
      await waitFor(() => expect(queries().some((query) => query.state.status === "success")).toBe(true));
      expect(calls[0]?.[parameter]).toBe(value);
      const before = calls.length;

      act(() => {
        auth.prefixes = ["vc_sk_", "vc_sa_", "public_new_prefix_"];
        auth.version += 1;
        auth.listeners.forEach((listener) => listener());
      });
      await waitFor(() => expect(calls.length).toBeGreaterThan(before));
      expect(calls.slice(before).some((query) => JSON.stringify(query).includes(value))).toBe(false);
      expect(queries().some((query) => JSON.stringify(query.queryKey).includes(value))).toBe(false);
      expect(document.body.textContent?.includes(value)).toBe(false);
    },
  );
});
