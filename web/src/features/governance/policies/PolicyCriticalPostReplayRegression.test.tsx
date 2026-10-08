import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { createAppQueryClient } from "@/app/providers/query-client";
import { migrationRegistry } from "@/config/migration-registry";
import { PoliciesPage } from "@/features/governance/policies/PoliciesPage";
import type * as ClientModule from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

const runtime = vi.hoisted(() => ({
  legacy: false,
  fetch: vi.fn<typeof globalThis.fetch>(),
}));

// Synthetic observed authentication only. FeatureRoute, actual page/dialog callers,
// ApiClient, tokenStore and production QueryClient are real. No Go/JWT or IdP runs.
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => ({
      ...testAuth({ scopes: ["admin:read", "admin:write", "security:read"] }),
      authenticationMode: runtime.legacy ? "legacy_token" : "session",
    }),
  };
});
vi.mock("@/shared/api/client", async (importActual) => {
  const actual = await importActual<typeof ClientModule>();
  return {
    ...actual,
    apiClient: new actual.ApiClient({ fetch: (...args) => runtime.fetch(...args) }),
  };
});

const initialAccess = "PUBLIC-critical-initial-access";
const nextAccess = "PUBLIC-critical-next-access";
const initialRefresh = "PUBLIC-critical-initial-refresh";
const nextRefresh = "PUBLIC-critical-next-refresh";
const legacyToken = "PUBLIC-critical-legacy-token";
const reason = "PUBLIC operator-approved reason";
const policy = {
  id: "public-replay-policy",
  name: "PUBLIC replay policy",
  description: "PUBLIC complete policy body",
  enabled: false,
  priority: 10,
  rollout_percent: 25,
  rules: [
    {
      id: "public-replay-rule",
      name: "PUBLIC rule",
      enabled: true,
      priority: 100,
      conditions: { contains_secret: true },
      actions: { block: true },
    },
  ],
};
const actions = {
  kill: {
    trigger: "모든 /v1 호출 즉시 차단",
    title: "게이트웨이를 긴급 정지할까요?",
    confirm: "즉시 차단",
    path: "/admin/kill-switch",
    body: { disabled: true, reason },
  },
  policy: {
    trigger: `${policy.name} 사용`,
    title: "정책을 사용할까요?",
    confirm: "사용",
    path: "/admin/policies",
    body: { ...policy, enabled: true },
  },
} as const;
type Action = keyof typeof actions;
type Mode = "approved" | "refresh-401" | "replaced-access-401" | "legacy-401";
interface Attempt {
  method: string;
  path: string;
  body: unknown;
  credentialGeneration: "initial" | "next" | "legacy" | "none" | "unexpected";
}
const clients: QueryClient[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function setup(action: Action, mode: Mode) {
  runtime.legacy = mode === "legacy-401";
  if (runtime.legacy) tokenStore.setLegacyToken(legacyToken);
  else tokenStore.saveTokens({ access_token: initialAccess, refresh_token: initialRefresh });
  const epoch = tokenStore.getSessionEpoch();
  const attempts: Attempt[] = [];
  const unexpected: string[] = [];
  const writes = () =>
    attempts.filter((attempt) => attempt.method === "POST" && attempt.path === actions[action].path);
  const refreshes = () => attempts.filter((attempt) => attempt.path === "/auth/refresh");
  let committed = false;
  runtime.fetch.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "http://synthetic.invalid").pathname;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const headers = new Headers(init?.headers);
    const auth = headers.get("Authorization");
    const credentialGeneration =
      auth === `Bearer ${initialAccess}`
        ? "initial"
        : auth === `Bearer ${nextAccess}`
          ? "next"
          : auth === `Bearer ${legacyToken}`
            ? "legacy"
            : auth === null
              ? "none"
              : "unexpected";
    // Count admission before response selection; the fixture does not implement
    // authorization, guard readonly or prevent a second critical POST.
    attempts.push({ method, path, body, credentialGeneration });
    if (method === "POST" && path === actions[action].path) {
      expect(headers.get("X-Vibe-Route")).toBe("governance.policies");
      expect(headers.get("X-Vibe-UI")).toBe("app");
      if (mode !== "approved" && writes().length === 1) {
        if (mode === "replaced-access-401") {
          // Another successful refresh rotated only credentials while this first
          // request was in flight. This does not replace browser session ownership.
          tokenStore.refreshTokens({ access_token: nextAccess, refresh_token: nextRefresh });
        }
        return json({ error: { message: "PUBLIC synthetic expired authorization" } }, 401);
      }
      committed = true;
      return action === "kill"
        ? json({ disabled: true, reason })
        : json({ policy: { ...policy, enabled: true } }, 201);
    }
    if (method === "POST" && path === "/auth/refresh") {
      expect(body).toEqual({ refresh_token: initialRefresh });
      expect(credentialGeneration).toBe("none");
      return json({
        access_token: nextAccess,
        refresh_token: nextRefresh,
        token_type: "Bearer",
        expires_in: 900,
        refresh_expires_in: 3600,
      });
    }
    const bodies: Record<string, unknown> = {
      "/admin/kill-switch": { disabled: action === "kill" && committed, reason: committed ? reason : "" },
      "/admin/policies": { policies: [{ ...policy, enabled: action === "policy" && committed }] },
      "/admin/incidents": { incidents: [], min_events: 5 },
      "/admin/policies/regression/cases": { cases: [] },
      "/admin/security/secrets": { secret_events: [], count: 0 },
      "/admin/approvals": { approvals: [], count: 0 },
      "/admin/policies/decisions": { policy_decisions: [], count: 0 },
      "/admin/alerts": { rules: [], events: [] },
      "/admin/cost": { enabled: false, threshold_krw: 500 },
    };
    if (method === "GET" && Object.hasOwn(bodies, path)) return json(bodies[path]);
    unexpected.push(`${method} ${path}`);
    throw new Error("Unregistered synthetic critical transport");
  });
  const feature = migrationRegistry.find((item) => item.featureId === "governance.policies");
  if (!feature) throw new Error("Existing governance feature required");
  const client = createAppQueryClient();
  clients.push(client);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/governance/policies"]}>
        <UnsavedChangesProvider>
          <FeatureRoute feature={feature}>
            <PoliciesPage />
          </FeatureRoute>
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  await screen.findByRole("button", { name: actions.policy.trigger });
  await waitFor(() => {
    expect(client.getQueryState(["governance", "kill-switch"])?.status).toBe("success");
    expect(client.isFetching()).toBe(0);
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: actions[action].trigger }));
  const dialog = await screen.findByRole("dialog", { name: actions[action].title });
  if (action === "kill") await user.type(within(dialog).getByLabelText(/변경 사유/u), reason);
  await user.click(within(dialog).getByRole("button", { name: actions[action].confirm }));
  // Wait for the actual mutation to settle in either result. Do not assume the
  // desired rejection, a new UI control, or an exact arbitrary time budget.
  await waitFor(() => {
    const mutations = client.getMutationCache().getAll();
    expect(mutations).toHaveLength(1);
    expect(mutations[0]?.state.status).toMatch(/^(success|error)$/u);
    expect(client.isFetching()).toBe(0);
  });
  expect(unexpected).toEqual([]);
  expect(tokenStore.getSessionEpoch()).toBe(epoch);
  expect(writes().map((entry) => entry.body)).toEqual(writes().map(() => actions[action].body));
  expect(writes()[0]?.credentialGeneration).toBe(runtime.legacy ? "legacy" : "initial");
  return { writes, refreshes, attempts, dialog };
}

beforeEach(() => {
  runtime.legacy = false;
  runtime.fetch.mockReset();
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
  vi.unstubAllGlobals();
});

describe.each(["kill", "policy"] as const)("%s critical POST401 no implicit replay", (action) => {
  it("positive: one explicit approved confirmation sends exactly one complete intended body", async () => {
    const fixture = await setup(action, "approved");
    expect(fixture.writes()).toHaveLength(1);
    expect(fixture.refreshes()).toHaveLength(0);
    await waitFor(() => expect(fixture.dialog).not.toBeInTheDocument());
  });

  it.each(["refresh-401", "replaced-access-401"] as const)(
    "%s: authorization failure must not replay a side-effecting POST without a new confirmation",
    async (mode) => {
      const fixture = await setup(action, mode);
      // All objects contain public synthetic labels only. Preserve the actual
      // attempted generation/body sequence in the first failing JSON report.
      expect.soft(fixture.writes()).toHaveLength(1);
      expect.soft(fixture.refreshes()).toHaveLength(0);
      expect.soft(screen.queryByRole("dialog", { name: actions[action].title })).toBeInTheDocument();
    },
  );

  it("positive: legacy token401 without a refresh token already stays one attempted POST", async () => {
    const fixture = await setup(action, "legacy-401");
    expect(fixture.writes()).toHaveLength(1);
    expect(fixture.refreshes()).toHaveLength(0);
    expect(fixture.dialog).toBeInTheDocument();
    expect(within(fixture.dialog).getByRole("alert")).toBeVisible();
    if (action === "kill") expect(within(fixture.dialog).getByLabelText(/변경 사유/u)).toHaveValue(reason);
  });
});
