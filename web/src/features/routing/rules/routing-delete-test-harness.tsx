import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { renderScreen } from "@/test/render";
import { RoutingPage } from "./RoutingPage";

const runtime = vi.hoisted(() => ({
  scopes: ["routing:read", "routing:write"],
  readOnly: false,
  owner: "routing.rules",
  permitted: true,
  userId: "operator-a",
  teamId: "team-a",
  role: "admin",
  roles: ["admin"],
  mode: "authenticated" as "authenticated" | "legacy" | "open",
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => new Map<string, (event?: unknown) => unknown>());
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
export const deleteToasts = () => toasts;

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        scopes: runtime.scopes,
        user: { id: runtime.userId, team_id: runtime.teamId, role: runtime.role, roles: runtime.roles },
      });
      return {
        ...auth,
        mode: runtime.mode,
        credentialPrefixes: runtime.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "routing.rules"
            ? { ...feature, status: "preview" as const, readOnly: runtime.readOnly }
            : feature,
        ),
      };
    },
  };
});
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/shared/components/ui/Button", async (importOriginal) => {
  const actual = await importOriginal<typeof ButtonModule>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      const label = props["aria-label"] ?? (typeof props.children === "string" ? props.children : undefined);
      if (label && props.onClick) captured.set(label, props.onClick as (event?: unknown) => unknown);
      return <actual.Button {...props} />;
    },
  };
});

export const listPath = "GET /admin/routing-rules";
export const initialDeleteRule: RoutingRule = {
  id: "route_delete_a",
  enabled: true,
  priority: 10,
  match_pattern: "gpt-*",
  min_complexity: 0,
  max_complexity: 40,
  target_model: "public-model-a",
  target_provider: "public-provider",
  note: "공개 합성 메모",
  created_at: "2026-10-01T00:00:00Z",
};

beforeEach(() => {
  Object.assign(runtime, {
    scopes: ["routing:read", "routing:write"],
    readOnly: false,
    owner: "routing.rules",
    permitted: true,
    userId: "operator-a",
    teamId: "team-a",
    role: "admin",
    roles: ["admin"],
    mode: "authenticated",
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  captured.clear();
  toasts.success.mockClear();
  toasts.error.mockClear();
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function setupDelete(overrides: Partial<RoutingRule> = {}) {
  const rule = { ...initialDeleteRule, ...overrides };
  const records = new Map([[rule.id, { ...rule }]]);
  const deletePath = `DELETE /admin/routing-rules/${encodeURIComponent(rule.id)}`;
  const calls: Array<{ key: string; body?: unknown }> = [];
  const response: { read?: () => unknown; remove?: () => unknown } = {};
  // Attempts are recorded before processing. No fixture permission, owner,
  // readonly, baseline, confirmation or uncertainty guard replaces the UI.
  // Actual endpoint schemas parse every response. Epoch/abort imitate the
  // existing shared client, not live authentication or server cancellation.
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const options = (args[0] ?? {}) as { body?: unknown; signal?: AbortSignal };
    const key = `${endpoint.method} ${endpoint.path}`;
    calls.push({ key, body: options.body });
    const epoch = tokenStore.getSessionEpoch();
    let raw: unknown;
    if (key === listPath) {
      raw = await (response.read
        ? response.read()
        : { rules: [...records.values()].map((row) => ({ ...row })) });
    } else if (key === deletePath) {
      // The real DELETE permits an absent row. A committed deletion is not
      // rolled back by a held, malformed or rejected response.
      records.delete(rule.id);
      raw = await (response.remove ? response.remove() : { id: rule.id, status: "deleted" });
    } else {
      throw new AppError(`Unexpected test request: ${key}`, { kind: "contract" });
    }
    if (epoch !== tokenStore.getSessionEpoch() || options.signal?.aborted)
      throw new AppError("취소된 조회", { kind: "aborted" });
    const parsed = endpoint.schema.safeParse(raw);
    if (!parsed.success) throw new AppError("응답 형식을 확인하지 못했습니다.", { kind: "contract" });
    return parsed.data as never;
  });
  const feature = migrationRegistry.find((item) => item.featureId === "routing.rules");
  if (!feature) throw new Error("Actual routing.rules registry entry missing");
  const routingFeature = feature;
  let refresh = () => {};
  function Overlay({ children }: { children: ReactNode }) {
    const actual = useContext(FeatureAccessContext);
    if (!actual) throw new Error("Actual FeatureRoute access missing");
    return (
      <FeatureAccessContext.Provider
        value={{ ...actual, featureId: runtime.owner, permitted: runtime.permitted }}
      >
        <output data-testid="delete-access">{`${actual.featureId}:${actual.readOnly}:${runtime.owner}`}</output>
        {children}
      </FeatureAccessContext.Provider>
    );
  }
  function Host() {
    const [, setRevision] = useState(0);
    useLayoutEffect(() => {
      refresh = () => setRevision((value) => value + 1);
      return () => {
        refresh = () => {};
      };
    }, []);
    return (
      <FeatureRoute feature={routingFeature}>
        <Overlay>
          <RoutingPage />
        </Overlay>
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules", path: "/routing/rules/*" });
  await screen.findByRole("button", { name: / 규칙 삭제$/u });
  expect(screen.getByTestId("delete-access")).toHaveTextContent("routing.rules:false:routing.rules");
  return {
    view,
    rule,
    records,
    calls,
    response,
    deletePath,
    user: userEvent.setup(),
    count(key: string) {
      return calls.filter((call) => call.key === key).length;
    },
    update(values: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, values);
        refresh();
      });
    },
    capture(label: string) {
      const callback = captured.get(label);
      if (!callback) throw new Error(`Missing actual callback: ${label}`);
      return callback;
    },
    actualListQuery() {
      const queries = view.client
        .getQueryCache()
        .findAll()
        .filter((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "rules");
      expect(queries).toHaveLength(1);
      const query = queries[0];
      if (!query) throw new Error("Actual RulesTab query missing");
      return query;
    },
  };
}
export type DeleteHarness = Awaited<ReturnType<typeof setupDelete>>;

export async function openDelete(current: DeleteHarness) {
  const trigger = screen.getByRole("button", { name: / 규칙 삭제$/u });
  await current.user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "라우팅 규칙 삭제" });
  const queries = current.view.client
    .getQueryCache()
    .findAll()
    .filter((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "delete-review");
  // The baseline has no own query. With the reviewed UI, wait for its actual
  // initial transport to settle (success OR error) before entering confirmation.
  if (queries.length) {
    expect(queries).toHaveLength(1);
    await waitFor(() => expect(queries[0]?.state.fetchStatus).toBe("idle"));
  }
  return { dialog, trigger };
}
// Baseline ConfirmDialog and the reviewed UI reach the same actual final
// deletion callback. Missing future selectors are not the baseline failure.
export async function acknowledgeIfPresent(current: DeleteHarness, dialog: HTMLElement) {
  const input = within(dialog).queryByRole("textbox", { name: "삭제 확인 문구" });
  if (input) await current.user.type(input, "규칙 삭제");
  const active = within(dialog).queryByRole("checkbox", {
    name: "사용 중인 규칙의 라우팅 영향을 확인했습니다",
  });
  if (active && !(active as HTMLInputElement).checked) await current.user.click(active);
}
export async function confirmDelete(current: DeleteHarness, dialog: HTMLElement) {
  const action =
    within(dialog).queryByRole("button", { name: "규칙 삭제" }) ??
    within(dialog).getByRole("button", { name: "삭제" });
  await current.user.click(action);
}
export function expectOnlyDelete(current: DeleteHarness) {
  expect(current.calls.filter((call) => /^(POST|PATCH) /u.test(call.key))).toEqual([]);
}
