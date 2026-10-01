import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule, RoutingRuleInput } from "@/shared/api/domains/routing";
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
export const createToasts = () => toasts;

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
export const createPath = "POST /admin/routing-rules";
export const successMessage = "라우팅 규칙 생성 요청을 확인했습니다.";
export const zeroCreatedAt = "0001-01-01T00:00:00Z";
export const storedCreatedAt = "2026-10-02T00:00:00Z";
export const submittedRule: RoutingRuleInput = {
  match_pattern: "public-*",
  target_model: "public-created-model",
  target_provider: "public-provider",
  min_complexity: 10,
  max_complexity: 80,
  priority: 27,
  note: "공개 합성 생성 메모",
  enabled: true,
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

export async function setupCreate() {
  const records = new Map<string, RoutingRule>();
  const calls: Array<{ key: string; body?: unknown }> = [];
  const response: { read?: () => unknown; create?: (created: RoutingRule) => unknown } = {};
  let sequence = 0;
  // Transport attempts precede handling; the fixture never rejects for UI
  // permission, readonly, owner, confirmation, list readiness or uncertainty.
  // Every response goes through the selected real endpoint schema.
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
    } else if (key === createPath) {
      const created: RoutingRule = {
        ...(options.body as RoutingRuleInput),
        id: `route_created_${++sequence}`,
        created_at: zeroCreatedAt,
      };
      // A committed creation survives a held, malformed or rejected ACK.
      // Actual Go returns its pre-store value in the ACK, while SQL fills time.
      records.set(created.id, { ...created, created_at: storedCreatedAt });
      raw = await (response.create ? response.create(created) : { rule: created });
    } else {
      throw new AppError(`Unexpected test request: ${key}`, { kind: "contract" });
    }
    // Model only the existing client's epoch/abort boundary, not live auth or
    // a guarantee that cancelling a client request cancels a server write.
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
        <output data-testid="create-access">{`${actual.featureId}:${actual.readOnly}:${runtime.owner}`}</output>
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
  await screen.findByRole("button", { name: /규칙 추가/u });
  expect(screen.getByTestId("create-access")).toHaveTextContent("routing.rules:false:routing.rules");
  // This positive proves a real mounted query and a working empty-list response;
  // it is not a product prerequisite for creating a new independent rule.
  await waitFor(() => expect(calls.filter((call) => call.key === listPath)).toHaveLength(1));
  await waitFor(() => {
    const query = view.client.getQueryCache().find({
      queryKey: ["routing", "rules", tokenStore.getSessionEpoch(), "routing.rules"],
      exact: true,
    });
    expect(query?.state.status).toBe("success");
  });
  return {
    view,
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
      const callback = captured.get(label);
      if (!callback) throw new Error(`Missing actual callback: ${label}`);
      return callback;
    },
    actualListQuery() {
      const query = view.client.getQueryCache().find<{ rules: RoutingRule[] }>({
        queryKey: ["routing", "rules", tokenStore.getSessionEpoch(), runtime.owner],
        exact: true,
      });
      if (!query) throw new Error("Actual current routing list Query missing");
      return query;
    },
  };
}
export type CreateHarness = Awaited<ReturnType<typeof setupCreate>>;

export async function openAndFill(current: CreateHarness) {
  const trigger = screen.getByRole("button", { name: /규칙 추가/u });
  await current.user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "라우팅 규칙 추가" });
  for (const [label, value] of [
    ["모델 패턴", submittedRule.match_pattern],
    ["대상 모델", submittedRule.target_model],
    ["대상 공급자", submittedRule.target_provider],
    ["최소 복잡도", String(submittedRule.min_complexity)],
    ["최대 복잡도", String(submittedRule.max_complexity)],
    ["우선순위", String(submittedRule.priority)],
    ["메모", submittedRule.note],
  ] as const) {
    const field = within(dialog).getByLabelText(new RegExp(label, "u"));
    await current.user.clear(field);
    await current.user.type(field, value);
  }
  return { dialog, trigger };
}

export async function firstAction(current: CreateHarness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "생성 내용 검토" }));
}

export async function reviewAndAgree(current: CreateHarness, dialog: HTMLElement) {
  await firstAction(current, dialog);
  await within(dialog).findByRole("heading", { name: "생성 내용 검토" });
  await current.user.click(
    within(dialog).getByRole("checkbox", { name: "사용 중으로 생성되는 규칙의 라우팅 영향을 확인했습니다" }),
  );
  const action = within(dialog).getByRole("button", { name: "규칙 만들기" });
  expect(action).toHaveAttribute("aria-disabled", "false");
  return { action, captured: current.capture("규칙 만들기") };
}

export async function createAndSettle(current: CreateHarness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "규칙 만들기" }));
  await manualSettled(dialog);
}

export async function manualSettled(dialog: HTMLElement) {
  await waitFor(() => {
    const refresh = within(dialog).getByRole("button", { name: "목록 다시 조회" });
    expect(refresh).toHaveAttribute("aria-busy", "false");
    expect(refresh).toHaveAttribute("aria-disabled", "false");
  });
}

export async function invoke(callback: (event?: unknown) => unknown) {
  await act(async () => {
    void callback();
    await Promise.resolve();
  });
}

export async function discard(current: CreateHarness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
  const confirmation = await screen.findByRole("alertdialog");
  await current.user.click(within(confirmation).getByRole("button", { name: "변경 버리기" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

export function expectOnlyCreate(current: CreateHarness) {
  expect(current.calls.filter((call) => /^(PATCH|DELETE) /u.test(call.key))).toEqual([]);
}
