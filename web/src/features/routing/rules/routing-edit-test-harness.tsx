import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { RoutingPage } from "./RoutingPage";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({
  scopes: ["routing:read", "routing:write"],
  readOnly: false,
  owner: "routing.rules",
  permitted: true,
  userId: "operator-a",
  mode: "authenticated" as "authenticated" | "legacy" | "open",
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({
  buttons: new Map<string, (event?: unknown) => unknown>(),
}));
const editToasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
export const getEditToasts = () => editToasts;

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.userId } });
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
vi.mock("sonner", () => ({ toast: editToasts }));
vi.mock("@/shared/components/ui/Button", async (importOriginal) => {
  const actual = await importOriginal<typeof ButtonModule>();
  return {
    ...actual,
    Button: (props: ComponentProps<typeof actual.Button>) => {
      if (typeof props.children === "string" && props.onClick) {
        captured.buttons.set(props.children, props.onClick as (event?: unknown) => unknown);
      }
      return <actual.Button {...props} />;
    },
  };
});

export const listPath = "GET /admin/routing-rules";
export const patchPath = "PATCH /admin/routing-rules/route_edit_a";
export const initialEditRule: RoutingRule = {
  id: "route_edit_a",
  enabled: true,
  priority: 10,
  match_pattern: "gpt-*",
  min_complexity: 0,
  max_complexity: 40,
  target_model: "public-model-a",
  target_provider: "public-provider",
  note: "공개 합성 메모",
  created_at: "2026-09-30T00:00:00Z",
};

beforeEach(() => {
  Object.assign(runtime, {
    scopes: ["routing:read", "routing:write"],
    readOnly: false,
    owner: "routing.rules",
    permitted: true,
    userId: "operator-a",
    mode: "authenticated",
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  captured.buttons.clear();
  editToasts.success.mockClear();
  editToasts.error.mockClear();
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function setupEdit(overrides: Partial<RoutingRule> = {}) {
  const rule = { ...initialEditRule, ...overrides };
  const records = new Map([[rule.id, { ...rule }]]);
  const calls: Array<{ key: string; body?: unknown }> = [];
  const response: {
    read?: () => unknown;
    patch?: (saved: RoutingRule) => unknown;
  } = {};
  // Transport-only fixture: records an attempt BEFORE any processing. It does
  // not implement UI permission, readonly, owner, review, baseline or ACK rules.
  // The actual endpoint schema is parsed (including the new strict operation).
  // Epoch checks mirror the existing shared client, not a new UI security proof.
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const options = (args[0] ?? {}) as { body?: unknown };
    const key = `${endpoint.method} ${endpoint.path}`;
    calls.push({ key, body: options.body });
    const epoch = tokenStore.getSessionEpoch();
    let raw: unknown;
    if (key === listPath) {
      raw = await (response.read
        ? response.read()
        : { rules: [...records.values()].map((row) => ({ ...row })) });
    } else if (key === patchPath) {
      const current = records.get(rule.id);
      if (!current) throw new AppError("합성 대상 없음", { kind: "http", status: 404 });
      const saved = { ...current, ...(options.body as object) };
      records.set(rule.id, saved);
      raw = await (response.patch ? response.patch(saved) : { rule: { ...saved } });
    } else {
      throw new AppError(`Unexpected test request: ${key}`, { kind: "contract" });
    }
    if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("세션 변경", { kind: "aborted" });
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
        <output data-testid="edit-access">{`${actual.featureId}:${actual.readOnly}:${runtime.owner}`}</output>
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
  await screen.findByRole("button", { name: "gpt-* → public-model-a 규칙 수정" });
  expect(screen.getByTestId("edit-access")).toHaveTextContent("routing.rules:false:routing.rules");
  return {
    view,
    rule,
    records,
    calls,
    response,
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
      const callback = captured.buttons.get(label);
      if (!callback) throw new Error(`No actual rendered callback: ${label}`);
      return callback;
    },
    actualListQuery() {
      const found = view.client
        .getQueryCache()
        .findAll()
        .filter(
          (query) =>
            query.queryKey[0] === "routing" &&
            query.queryKey[1] === "rules" &&
            query.state.data &&
            typeof query.state.data === "object" &&
            "rules" in query.state.data,
        );
      expect(found).toHaveLength(1);
      const query = found[0];
      if (!query) throw new Error("Actual RulesTab query missing");
      return query;
    },
  };
}
export type EditHarness = Awaited<ReturnType<typeof setupEdit>>;

export async function openEdit(current: EditHarness) {
  const trigger = screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 수정" });
  await current.user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "라우팅 규칙 수정" });
  await waitFor(() => expect(within(dialog).getByRole("textbox", { name: "대상 모델" })).toBeEnabled());
  return { dialog, trigger };
}
export async function changeModel(current: EditHarness, dialog: HTMLElement) {
  const input = within(dialog).getByRole("textbox", { name: "대상 모델" });
  await current.user.clear(input);
  await current.user.type(input, "public-model-b");
}
// The baseline has a direct save, the proposed UI has review then save. This
// helper reaches the SAME final action in both, so lifecycle REDs are not merely
// missing-review-selector failures. Review-presence has its own explicit test.
export async function reviewIfPresent(current: EditHarness, dialog: HTMLElement) {
  const review = within(dialog).queryByRole("button", { name: "변경 내용 검토" });
  if (review) await current.user.click(review);
}
export async function saveEdit(current: EditHarness, dialog: HTMLElement) {
  const save = within(dialog).queryByRole("button", { name: "규칙 저장" });
  if (save) await current.user.click(save);
}
export function expectNoReplacement(current: EditHarness) {
  expect(current.calls.filter((call) => /^(POST|DELETE) /u.test(call.key))).toEqual([]);
}
