import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { createAppQueryClient } from "@/app/providers/query-client";
import { migrationRegistry } from "@/config/migration-registry";
import { ApiClient, apiClient } from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ConfirmModule from "@/shared/components/ui/ConfirmDialog";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { PoliciesPage } from "./PoliciesPage";

const runtime = vi.hoisted(() => ({
  writable: true,
  readOnly: false,
  callbacks: new Map<string, (reason: string) => unknown>(),
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({
        scopes: ["admin:read", "security:read", ...(runtime.writable ? ["admin:write"] : [])],
      });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "governance.policies" ? { ...feature, readOnly: runtime.readOnly } : feature,
        ),
      };
    },
  };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (importActual) => {
  const actual = await importActual<typeof ConfirmModule>();
  return {
    ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => {
      if (props.open) runtime.callbacks.set(props.title, props.onConfirm);
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

const name = "PUBLIC control policy";
const reason = "PUBLIC operator reason";
const definitions = {
  stop: { trigger: "모든 /v1 호출 즉시 차단", title: "게이트웨이를 긴급 정지할까요?", confirm: "즉시 차단" },
  resume: { trigger: "정상 운영 재개", title: "정상 운영을 재개할까요?", confirm: "운영 재개" },
  activate: { trigger: `${name} 사용`, title: "정책을 사용할까요?", confirm: "사용" },
  deactivate: { trigger: `${name} 중지`, title: "정책을 중지할까요?", confirm: "중지" },
} as const;
type Action = keyof typeof definitions;
const clients: QueryClient[] = [];
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function setup(action: Action) {
  const attempts: { path: string; body: unknown }[] = [];
  const unexpected: string[] = [];
  let fail = false;
  let kill = { disabled: action === "resume", reason: "PUBLIC existing reason" };
  let policy = {
    id: "public-policy",
    name,
    description: "PUBLIC description",
    enabled: action === "deactivate",
    priority: 12,
    rollout_percent: 37,
    rules: [
      {
        id: "public-rule",
        name: "PUBLIC rule",
        enabled: true,
        priority: 23,
        conditions: { contains_secret: true },
        actions: { block: true },
      },
    ],
  };
  const initialPolicy = structuredClone(policy);
  const transport = new ApiClient({
    getAccessToken: () => "",
    getRefreshToken: () => "",
    getLegacyToken: () => "",
    fetch: vi.fn(async (input, init) => {
      const path = new URL(String(input), "http://synthetic.invalid").pathname;
      const method = init?.method ?? "GET";
      if (method === "POST") {
        const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        attempts.push({ path, body });
        if (fail) return json({ error: { message: "PUBLIC synthetic failure" } }, 500);
        if (path === "/admin/kill-switch") {
          kill = { ...kill, ...(body as typeof kill) };
          return json(kill);
        }
        if (path === "/admin/policies") {
          policy = { ...policy, ...(body as typeof policy) };
          return json({ policy }, 201);
        }
      }
      const reads: Record<string, unknown> = {
        "/admin/kill-switch": kill,
        "/admin/policies": { policies: [policy] },
        "/admin/incidents": { incidents: [], min_events: 5 },
        "/admin/policies/regression/cases": { cases: [] },
        "/admin/security/secrets": { secret_events: [], count: 0 },
        "/admin/approvals": { approvals: [], count: 0 },
        "/admin/policies/decisions": { policy_decisions: [], count: 0 },
        "/admin/alerts": { rules: [], events: [] },
        "/admin/cost": { enabled: false, threshold_krw: 500 },
      };
      if (method === "GET" && Object.hasOwn(reads, path)) return json(reads[path]);
      unexpected.push(`${method} ${path}`);
      throw new Error("Unexpected synthetic request");
    }),
  });
  vi.spyOn(apiClient, "request").mockImplementation((endpoint, ...args) =>
    transport.request(endpoint, ...args),
  );
  const client = createAppQueryClient();
  clients.push(client);
  const feature = migrationRegistry.find((item) => item.featureId === "governance.policies");
  if (!feature) throw new Error("Governance feature required");
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/governance/policies"]}>
        <UnsavedChangesProvider>
          <FeatureRoute feature={feature}>
            <PoliciesPage />
          </FeatureRoute>
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByRole("button", { name: definitions[action].trigger });
  await waitFor(() => expect(client.isFetching()).toBe(0));
  return {
    attempts,
    unexpected,
    initialPolicy,
    setFailure: (value: boolean) => {
      fail = value;
    },
    changeAccess: async (mode: "feature" | "scope", allowed: boolean) => {
      if (mode === "feature") runtime.readOnly = !allowed;
      else runtime.writable = allowed;
      await act(async () => view.rerender(tree()));
    },
    unmount: view.unmount,
  };
}
async function open(action: Action) {
  const user = userEvent.setup();
  const selected = definitions[action];
  await user.click(screen.getByRole("button", { name: selected.trigger }));
  const dialog = await screen.findByRole("dialog", { name: selected.title });
  if (action === "stop" || action === "resume") {
    expect(within(dialog).getByRole("button", { name: selected.confirm })).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/변경 사유/), `  ${reason}  `);
  }
  const callback = runtime.callbacks.get(selected.title);
  if (!callback) throw new Error("Real confirmation callback required");
  return { user, dialog, callback, confirm: within(dialog).getByRole("button", { name: selected.confirm }) };
}
beforeEach(() => {
  runtime.writable = true;
  runtime.readOnly = false;
  runtime.callbacks.clear();
  tokenStore.clearAll();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("External transport forbidden");
    }),
  );
});
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  tokenStore.clearAll();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(["resume", "deactivate"] as const)("sends one exact explicitly confirmed %s body", async (action) => {
  const current = await setup(action);
  const opened = await open(action);
  await opened.user.click(opened.confirm);
  await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
  expect(current.attempts).toEqual(
    action === "resume"
      ? [{ path: "/admin/kill-switch", body: { disabled: false, reason } }]
      : [{ path: "/admin/policies", body: { ...current.initialPolicy, enabled: false } }],
  );
  expect(current.unexpected).toEqual([]);
});

for (const mode of ["feature", "scope"] as const) {
  it.each(["stop", "resume", "activate", "deactivate"] as const)(
    `keeps intent through ${mode} revoke/restore and requires explicit %s confirmation`,
    async (action) => {
      const current = await setup(action);
      const opened = await open(action);
      await current.changeAccess(mode, false);
      expect(opened.confirm).toBeDisabled();
      expect(opened.dialog).toHaveTextContent("직접 확인하기 전에는 전송하지 않습니다.");
      await act(async () => {
        await expect(opened.callback(reason)).rejects.toMatchObject({ kind: "permission" });
      });
      expect(current.attempts).toEqual([]);
      await current.changeAccess(mode, true);
      expect(opened.confirm).toBeEnabled();
      expect(current.attempts).toEqual([]);
      if (action === "stop" || action === "resume")
        expect(within(opened.dialog).getByLabelText(/변경 사유/)).toHaveValue(`  ${reason}  `);
      await opened.user.click(opened.confirm);
      await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
      expect(current.attempts).toHaveLength(1);
      expect(current.unexpected).toEqual([]);
    },
  );
}

for (const retirement of ["epoch", "unmount"] as const) {
  it.each(["resume", "deactivate"] as const)(
    `rejects a captured %s callback after ${retirement}`,
    async (action) => {
      const current = await setup(action);
      const opened = await open(action);
      await act(async () => {
        if (retirement === "epoch") tokenStore.clearAll();
        else current.unmount();
      });
      await act(async () => {
        await expect(opened.callback(reason)).rejects.toMatchObject({ kind: "aborted" });
      });
      expect(current.attempts).toEqual([]);
    },
  );
}

it.each(["resume", "deactivate"] as const)("preserves ordinary500 manual retry for %s", async (action) => {
  const current = await setup(action);
  const opened = await open(action);
  current.setFailure(true);
  await opened.user.click(opened.confirm);
  await within(opened.dialog).findByRole("alert");
  expect(current.attempts).toHaveLength(1);
  expect(opened.confirm).toBeEnabled();
  current.setFailure(false);
  expect(current.attempts).toHaveLength(1);
  await opened.user.click(opened.confirm);
  await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
  expect(current.attempts).toHaveLength(2);
});

it("does not broaden the parent canWrite restriction into untouched quick-create siblings", async () => {
  const current = await setup("stop");
  await current.changeAccess("feature", false);
  expect(screen.getByRole("button", { name: definitions.stop.trigger })).toBeDisabled();
  expect(screen.getByRole("button", { name: definitions.activate.trigger })).toBeDisabled();
  // These pre-existing callers are intentionally outside this two-action milestone.
  for (const label of ["정책 추가", "시나리오 추가", "규칙 추가"])
    expect(screen.getByRole("button", { name: label })).toBeEnabled();
  expect(current.attempts).toEqual([]);
});
