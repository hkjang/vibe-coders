import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useLayoutEffect, useState, type ComponentProps } from "react";
import { beforeEach, afterEach, expect, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient, type ApiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { renderScreen } from "@/test/render";
import { RoutingPage } from "./RoutingPage";

const authState = vi.hoisted(() => ({
  scopes: ["routing:read", "routing:write"],
  readOnly: false,
  raw: true,
  user: "public-user",
  team: "public-team",
  role: "admin",
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const callbacks = vi.hoisted(() => new Map<string, (event?: unknown) => unknown>());
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
export const domainToasts = () => toasts;
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        scopes: authState.scopes,
        rawPromptView: authState.raw,
        role: authState.role,
        user: { id: authState.user, team_id: authState.team },
      });
      return {
        ...auth,
        credentialPrefixes: authState.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "routing.rules"
            ? { ...feature, status: "preview" as const, readOnly: authState.readOnly }
            : feature,
        ),
      };
    },
  };
});
vi.mock("@/shared/components/ui/Button", async (original) => {
  const actual = await original<typeof ButtonModule>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      const label = props["aria-label"] ?? (typeof props.children === "string" ? props.children : undefined);
      if (label && props.onClick) callbacks.set(label, props.onClick as (event?: unknown) => unknown);
      return <actual.Button {...props} />;
    },
  };
});
export const reviewRow = {
  id: "rv_1",
  decision_id: "public-decision",
  current_route: "public-recorded",
  suggested_route: "public-suggested",
  reason: "공개 합성 검토 사유",
  status: "pending",
  query_text: "PUBLIC-PROMPT-CANARY-NOT-FOR-CACHE",
  created_at: "2026-10-08T00:00:00Z",
  reviewed_at: "",
};
export const reviewPath = "GET /admin/routing/domain-review";
beforeEach(() => {
  Object.assign(authState, {
    scopes: ["routing:read", "routing:write"],
    readOnly: false,
    raw: true,
    user: "public-user",
    team: "public-team",
    role: "admin",
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  callbacks.clear();
  toasts.success.mockClear();
  toasts.error.mockClear();
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
export async function setupDomainReview(status = "pending") {
  const rows = [{ ...reviewRow, status }];
  const calls: Array<{ key: string; body?: unknown; query?: unknown }> = [];
  const response: {
    review?: () => unknown;
    action?: () => unknown;
    postClient?: ApiClient;
    reviewClient?: ApiClient;
  } = {};
  // Observe attempts first. The synthetic transport does NOT implement UI scope,
  // stale-query, row-status, confirmation or uncertainty guards for the product.
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const options = (args[0] ?? {}) as { query?: { status?: string }; body?: unknown; signal?: AbortSignal };
    const key = `${endpoint.method} ${endpoint.path}`;
    calls.push({ key, body: options.body, query: options.query });
    if (key === reviewPath && response.reviewClient) return response.reviewClient.request(endpoint, ...args);
    const epoch = tokenStore.getSessionEpoch();
    let raw: unknown;
    if (key === reviewPath)
      raw = await (response.review
        ? response.review()
        : {
            items: rows
              .filter((row) => row.status === (options.query?.status ?? "pending"))
              .map((row) => ({ ...row })),
          });
    else if (endpoint.method === "POST" && endpoint.path.startsWith("/admin/routing/domain-review/")) {
      if (response.postClient) return response.postClient.request(endpoint, ...args);
      const [id, action] = decodeURIComponent(
        endpoint.path.slice("/admin/routing/domain-review/".length),
      ).split("/");
      const row = rows.find((row) => row.id === id),
        next = action === "approve" ? "approved" : "rejected";
      if (row) {
        row.status = next;
        row.reviewed_at = "2026-10-08T01:00:00Z";
      }
      raw = await (response.action ? response.action() : { id, status: next });
    } else if (key.endsWith("/learning"))
      raw = { since: "2026-10-01T00:00:00Z", min_samples: 20, cells: [], recommendations: [] };
    else if (key.endsWith("/domain-decisions")) raw = { decisions: [], signals: {} };
    else if (key.endsWith("/domain-examples")) raw = { examples: [] };
    else throw new Error(`Unexpected synthetic request: ${key}`);
    if (options.signal?.aborted || tokenStore.getSessionEpoch() !== epoch)
      throw new AppError("종료된 합성 요청", { kind: "aborted" });
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) throw new AppError("응답 계약을 확인할 수 없습니다.", { kind: "contract" });
    return parsed.data as never;
  });
  let renderAuth = () => {};
  const feature = migrationRegistry.find((feature) => feature.featureId === "routing.rules");
  if (!feature) throw new Error("Routing feature missing");
  const routingFeature = feature;
  function Host() {
    const [, setVersion] = useState(0);
    useLayoutEffect(() => {
      renderAuth = () => setVersion((v) => v + 1);
    }, []);
    return (
      <FeatureRoute feature={routingFeature}>
        <RoutingPage />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, {
    route: `/routing/rules/learning?status=${status}`,
    path: "/routing/rules/*",
  });
  const actualQuery = () => {
    const matches = view.client
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.getObserversCount() > 0 &&
          query.queryKey[0] === "routing" &&
          query.queryKey[1] === "domain" &&
          query.queryKey[2] === "review",
      );
    expect(matches).toHaveLength(1);
    const match = matches[0];
    if (!match) throw new Error("Observed review query missing");
    return match;
  };
  await waitFor(() => {
    expect(actualQuery().state.status).toBe("success");
    expect(actualQuery().state.fetchStatus).toBe("idle");
  });
  const user = userEvent.setup();
  return {
    view,
    user,
    calls,
    rows,
    response,
    actualQuery,
    writes: () => calls.filter((call) => call.key.startsWith("POST /admin/routing/domain-review/")),
    update(patch: Partial<typeof authState>) {
      act(() => {
        Object.assign(authState, patch);
        renderAuth();
      });
    },
    capture(label: string) {
      const callback = callbacks.get(label);
      if (!callback) throw new Error(`Callback missing: ${label}`);
      return () => callback();
    },
    async open(action: "approve" | "reject" = "approve", agree = true) {
      const korean = action === "approve" ? "승인" : "거절";
      const trigger = screen.getByRole("button", { name: `rv_1 검토 ${korean}` });
      await user.click(trigger);
      const dialog = await screen.findByRole("dialog");
      const consent = within(dialog).queryByRole("checkbox", {
        name: "이 작업은 검토 상태만 기록함을 확인했습니다",
      });
      if (consent && agree) await user.click(consent);
      const label = consent ? `${korean} 상태 기록` : korean;
      return {
        trigger,
        dialog,
        label,
        confirm: within(dialog).getByRole("button", { name: label }),
      };
    },
  };
}
