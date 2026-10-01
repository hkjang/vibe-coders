import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useLayoutEffect, useState, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { useNavigate } from "react-router";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { apiClient } from "@/shared/api/client";
import type { RoutingRule, RoutingRuleInput } from "@/shared/api/domains/routing";
import type { RoutingLearningReport } from "@/shared/api/domains/routing-learning";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { renderScreen } from "@/test/render";
import { RoutingPage } from "./RoutingPage";

type Recommendation = RoutingLearningReport["recommendations"][number];
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
export const learningToasts = () => toasts;

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

export const learningPath = "GET /admin/routing/learning";
export const listPath = "GET /admin/routing-rules";
export const createPath = "POST /admin/routing-rules";
export const zeroCreatedAt = "0001-01-01T00:00:00Z";
export const storedCreatedAt = "2026-10-02T00:00:00Z";
export const successMessage = "라우팅 규칙 생성 요청을 확인했습니다.";
export const impactLabel = "작업 유형과 관계없이 해당 복잡도 범위에 적용됨을 확인했습니다";
export const recommendation: Recommendation = {
  task_type: "coding",
  bucket: "low",
  recommended_model: "public-learned-model",
  success_rate: 0.96,
  avg_cost_krw: 3.2,
  samples: 80,
  top_model: "public-current-model",
  top_success_rate: 0.85,
  differs: true,
  confident: true,
  rationale: "공개 합성 표본의 성공률과 비용",
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

export async function setupLearning(
  overrides: Partial<Recommendation> = {},
  initial: Partial<typeof runtime> = {},
) {
  Object.assign(runtime, initial);
  const selected = { ...recommendation, ...overrides };
  const report: RoutingLearningReport = {
    since: "2026-09-25T00:00:00Z",
    min_samples: 20,
    cells: [],
    recommendations: [selected],
  };
  const records = new Map<string, RoutingRule>();
  const calls: Array<{ key: string; body?: unknown; query?: unknown }> = [];
  const response: {
    learning?: (query: unknown) => unknown;
    read?: () => unknown;
    create?: (created: RoutingRule) => unknown;
  } = {};
  let sequence = 0;
  // Request-first transport only: no permission, ownership, confirmation,
  // bucket, Query-generation or uncertainty guard is implemented by the fixture.
  vi.spyOn(apiClient, "request").mockImplementation(async (endpoint, ...args) => {
    const options = (args[0] ?? {}) as { body?: unknown; query?: unknown; signal?: AbortSignal };
    const key = `${endpoint.method} ${endpoint.path}`;
    calls.push({ key, body: options.body, query: options.query });
    const epoch = tokenStore.getSessionEpoch();
    let raw: unknown;
    if (key === learningPath) {
      raw = await (response.learning ? response.learning(options.query) : report);
    } else if (key === listPath) {
      raw = await (response.read ? response.read() : { rules: [...records.values()] });
    } else if (key === createPath) {
      const created: RoutingRule = {
        ...(options.body as RoutingRuleInput),
        id: `learned_rule_${++sequence}`,
        created_at: zeroCreatedAt,
      };
      // Server commitment and ACK are separate: late/malformed ACK cannot
      // undo a created row. Actual Go's ACK time is zero; stored GET time is not.
      records.set(created.id, { ...created, created_at: storedCreatedAt });
      raw = await (response.create ? response.create(created) : { rule: created });
    } else if (key === "GET /admin/routing/domain-decisions") {
      raw = { decisions: [], signals: {} };
    } else if (key === "GET /admin/routing/domain-review") {
      raw = { items: [] };
    } else if (key === "GET /admin/routing/domain-examples") {
      raw = { examples: [] };
    } else {
      throw new AppError(`Unexpected test request: ${key}`, { kind: "contract" });
    }
    // Existing client epoch/abort behavior is modeled, not live authentication
    // or server rollback. The chosen real endpoint schema parses every reply;
    // this is not a live-auth test or proof of a local fence in isolation from
    // the existing client cancellation boundary.
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
  let navigateTo: (route: string) => void = () => {};
  function Overlay({ children }: { children: ReactNode }) {
    const actual = useContext(FeatureAccessContext);
    if (!actual) throw new Error("Actual FeatureRoute access missing");
    return (
      <FeatureAccessContext.Provider
        value={{ ...actual, featureId: runtime.owner, permitted: runtime.permitted }}
      >
        <output data-testid="learning-access">{`${actual.featureId}:${actual.readOnly}:${runtime.owner}`}</output>
        {children}
      </FeatureAccessContext.Provider>
    );
  }
  function Host() {
    const [, setRevision] = useState(0);
    const navigate = useNavigate();
    useLayoutEffect(() => {
      refresh = () => setRevision((value) => value + 1);
      navigateTo = (route) => {
        void navigate(route);
      };
      return () => {
        refresh = () => {};
        navigateTo = () => {};
      };
    }, [navigate]);
    return (
      <FeatureRoute feature={routingFeature}>
        <Overlay>
          <RoutingPage />
        </Overlay>
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules/learning", path: "/routing/rules/*" });
  // Learning does not mount RulesTab. Observe actual publications without
  // manufacturing a rules Query or depending on its gcTime:0 retention.
  const publishedLists: unknown[] = [];
  view.client.getQueryCache().subscribe((event) => {
    if (
      event.type === "updated" &&
      event.action.type === "success" &&
      event.query.queryKey[0] === "routing" &&
      event.query.queryKey[1] === "rules"
    )
      publishedLists.push(event.query.state.data);
  });
  await screen.findByRole("table", { name: "학습된 모델 추천" });
  expect(screen.getByTestId("learning-access")).toHaveTextContent(
    `routing.rules:${runtime.readOnly}:routing.rules`,
  );
  const actualLearningQuery = () => {
    const matches = view.client
      .getQueryCache()
      .getAll()
      .filter(
        (query) =>
          query.queryKey[0] === "routing" &&
          query.queryKey[1] === "learning" &&
          query.getObserversCount() > 0,
      );
    expect(matches).toHaveLength(1);
    const [query] = matches;
    if (!query) throw new Error("Actual mounted learning Query missing");
    return query;
  };
  const actualListQuery = () => {
    const matches = view.client
      .getQueryCache()
      .getAll()
      .filter((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "rules");
    expect(matches).toHaveLength(1);
    const [query] = matches;
    if (!query) throw new Error("Actual rules Query missing");
    return query;
  };
  await waitFor(() => {
    const query = actualLearningQuery();
    expect(query.state.status).toBe("success");
    expect(query.state.fetchStatus).toBe("idle");
    expect(query.state.data).toMatchObject({ recommendations: [selected] });
  });
  return {
    view,
    calls,
    report,
    records,
    response,
    selected,
    actualLearningQuery,
    actualListQuery,
    publishedLists,
    navigate(route: string) {
      act(() => navigateTo(route));
    },
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
      // Preserve the current DOM target with the current closure. Supplying a
      // minimal click event is not an admission guard; row handlers legitimately
      // use currentTarget to return focus after the dialog closes.
      const target = [...document.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === label || button.textContent?.trim() === label,
      );
      return (event?: unknown) => callback(event ?? { currentTarget: target });
    },
  };
}
export type LearningHarness = Awaited<ReturnType<typeof setupLearning>>;

export async function openRecommendation(current: LearningHarness) {
  const trigger = await screen.findByRole("button", {
    name: `${current.selected.recommended_model} 추천을 규칙으로 적용`,
  });
  expect(trigger).toBeEnabled();
  await current.user.click(trigger);
  const dialog = await screen.findByRole("dialog", { name: "학습 추천으로 규칙 만들기" });
  expect(within(dialog).getByRole("heading", { name: "생성 내용 검토" })).toBeVisible();
  return { trigger, dialog };
}

export async function agree(current: LearningHarness, dialog: HTMLElement) {
  const checkbox = within(dialog).getByRole("checkbox", { name: impactLabel });
  expect(checkbox).not.toBeChecked();
  await current.user.click(checkbox);
  const action = within(dialog).getByRole("button", { name: "규칙 만들기" });
  expect(action).toHaveAttribute("aria-disabled", "false");
  return { action, captured: current.capture("규칙 만들기") };
}

export async function approved(current: LearningHarness) {
  const opened = await openRecommendation(current);
  return { ...opened, ...(await agree(current, opened.dialog)) };
}

export async function createAndSettle(current: LearningHarness, dialog: HTMLElement) {
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

export async function rereview(current: LearningHarness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "생성 내용 다시 검토" }));
  return agree(current, dialog);
}

export async function discard(current: LearningHarness, dialog: HTMLElement) {
  await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
  const confirmation = await screen.findByRole("alertdialog");
  await current.user.click(within(confirmation).getByRole("button", { name: "변경 버리기" }));
  await waitFor(() => expect(dialog).not.toBeInTheDocument());
}

export async function fetchLearningPositive(current: LearningHarness) {
  const query = current.actualLearningQuery();
  const before = current.count(learningPath);
  await act(async () => {
    await query.fetch();
  });
  expect(current.count(learningPath)).toBe(before + 1);
  await waitFor(() => {
    expect(query.state.status).toBe("success");
    expect(query.state.fetchStatus).toBe("idle");
  });
  return query;
}

export function expectNoOtherWrites(current: LearningHarness) {
  expect(current.calls.filter((call) => /^(PATCH|DELETE) /u.test(call.key))).toEqual([]);
}
