import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { createAppQueryClient } from "@/app/providers/query-client";
import { migrationRegistry } from "@/config/migration-registry";
import { PoliciesPage } from "@/features/governance/policies/PoliciesPage";
import type * as ClientModule from "@/shared/api/client";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ConfirmDialogModule from "@/shared/components/ui/ConfirmDialog";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

const runtime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write", "security:read"],
  readOnly: false,
  status: "preview" as "preview" | "preview_read_only",
  fetch: vi.fn<typeof globalThis.fetch>(),
  confirmations: new Map<string, (reason: string) => Promise<unknown> | unknown>(),
}));

// Auth is a synthetic observed bootstrap; FeatureRoute, context, page, API client,
// query defaults, mutations and dialogs are real. This is not a Go/JWT test.
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "governance.policies"
            ? { ...feature, readOnly: runtime.readOnly, status: runtime.status }
            : feature,
        ),
      };
    },
  };
});

vi.mock("@/shared/api/client", async (importActual) => {
  const actual = await importActual<typeof ClientModule>();
  return {
    ...actual,
    apiClient: new actual.ApiClient({ fetch: (...args) => runtime.fetch(...args) }),
  };
});

// Observe the actual caller's callback while rendering the unchanged real dialog.
// Invoking it bypasses native disabled-button behavior, not the product callback.
vi.mock("@/shared/components/ui/ConfirmDialog", async (importActual) => {
  const actual = await importActual<typeof ConfirmDialogModule>();
  return {
    ConfirmDialog: (props: Parameters<typeof actual.ConfirmDialog>[0]) => {
      if (props.open) runtime.confirmations.set(props.title, props.onConfirm);
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

const writes = ["admin:read", "admin:write", "security:read"];
const reads = ["admin:read", "security:read"];
const reason = "PUBLIC critical baseline reason";
const policyName = "PUBLIC inactive policy";
const definitions = {
  kill: {
    trigger: "모든 /v1 호출 즉시 차단",
    title: "게이트웨이를 긴급 정지할까요?",
    confirm: "즉시 차단",
    path: "/admin/kill-switch",
  },
  policy: {
    trigger: `${policyName} 사용`,
    title: "정책을 사용할까요?",
    confirm: "사용",
    path: "/admin/policies",
  },
} as const;
type Action = keyof typeof definitions;
interface Attempt {
  method: string;
  path: string;
  body: unknown;
}
const clients: QueryClient[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

function AccessProbe(): React.JSX.Element {
  const access = useContext(FeatureAccessContext);
  return <output data-testid="effective-access">{JSON.stringify(access)}</output>;
}

async function setup() {
  const attempts: Attempt[] = [];
  const unexpected: string[] = [];
  let kill = { disabled: false, reason: "", updated_at: "2026-10-01T00:00:00Z", updated_by: "PUBLIC" };
  let policy = {
    id: "public-policy",
    name: policyName,
    description: "PUBLIC baseline description",
    enabled: false,
    priority: 10,
    rollout_percent: 25,
    rules: [
      {
        id: "public-rule",
        policy_id: "public-policy",
        name: "PUBLIC rule",
        enabled: true,
        priority: 100,
        conditions: { contains_secret: true },
        actions: { block: true },
      },
    ],
  };
  runtime.fetch.mockImplementation(async (input, init) => {
    const path = new URL(String(input), "http://synthetic.invalid").pathname;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    // Record every attempt before handling it. No mock authorization/read-only guard.
    attempts.push({ method, path, body });
    if (method === "POST" && path === "/admin/kill-switch") {
      kill = { ...kill, ...(body as { disabled: boolean; reason: string }) };
      return json(kill);
    }
    if (method === "POST" && path === "/admin/policies") {
      policy = { ...policy, ...(body as typeof policy) };
      return json({ policy });
    }
    const bodies: Record<string, unknown> = {
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
    if (method === "GET" && Object.hasOwn(bodies, path)) return json(bodies[path]);
    unexpected.push(`${method} ${path}`);
    throw new Error(`Unregistered synthetic HTTP: ${method} ${path}`);
  });
  const client = createAppQueryClient();
  clients.push(client);
  const feature = migrationRegistry.find((item) => item.featureId === "governance.policies");
  if (!feature) throw new Error("Existing governance feature is required");
  const tree = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/governance/policies"]}>
        <UnsavedChangesProvider>
          <FeatureRoute feature={feature}>
            <AccessProbe />
            <PoliciesPage />
          </FeatureRoute>
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>
  );
  const view = render(tree());
  await screen.findByRole("button", { name: definitions.policy.trigger });
  await waitFor(() => {
    expect(client.getQueryState(["governance", "kill-switch"])?.status).toBe("success");
    expect(client.isFetching()).toBe(0);
  });
  expect(unexpected).toEqual([]);
  const posts = () => attempts.filter((entry) => entry.method === "POST");
  return {
    posts,
    unexpected,
    rerender: () => view.rerender(tree()),
    dispose: () => {
      view.unmount();
      client.clear();
    },
  };
}

async function open(action: Action) {
  const definition = definitions[action];
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: definition.trigger }));
  const dialog = await screen.findByRole("dialog", { name: definition.title });
  if (action === "kill") await user.type(within(dialog).getByLabelText(/변경 사유/u), reason);
  const callback = runtime.confirmations.get(definition.title);
  expect(callback).toBeTypeOf("function");
  if (!callback) throw new Error("Existing confirmation callback is required");
  return {
    user,
    dialog,
    callback,
    confirm: within(dialog).getByRole("button", { name: definition.confirm }),
  };
}

async function invoke(callback: (reason: string) => unknown) {
  await act(async () => {
    try {
      await callback(reason);
    } catch {
      // A product permission/retirement rejection is allowed; transport count decides safety.
    }
  });
}

beforeEach(() => {
  runtime.scopes = [...writes];
  runtime.readOnly = false;
  runtime.status = "preview";
  runtime.confirmations.clear();
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

describe("Critical policy mutation boundaries through the actual PoliciesPage caller", () => {
  it("positive: writable preview sends exactly one intended Kill Switch and policy activation body", async () => {
    const fixture = await setup();
    expect(screen.getByTestId("effective-access")).toHaveTextContent('"readOnly":false');
    for (const action of ["kill", "policy"] as const) {
      const opened = await open(action);
      await opened.user.click(opened.confirm);
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: definitions[action].title })).not.toBeInTheDocument(),
      );
    }
    expect(fixture.posts()).toHaveLength(2);
    expect(fixture.posts()[0]).toEqual({
      method: "POST",
      path: "/admin/kill-switch",
      body: { disabled: true, reason },
    });
    expect(fixture.posts()[1]).toMatchObject({
      method: "POST",
      path: "/admin/policies",
      body: { id: "public-policy", enabled: true, rollout_percent: 25 },
    });
    expect(fixture.unexpected).toEqual([]);
  });

  it("positive: initial admin:write absence disables both actual caller triggers and sends nothing", async () => {
    runtime.scopes = [...reads];
    const fixture = await setup();
    const user = userEvent.setup();
    for (const action of ["kill", "policy"] as const) {
      const button = screen.getByRole("button", { name: definitions[action].trigger });
      expect(button).toBeDisabled();
      await user.click(button);
      expect(screen.queryByRole("dialog", { name: definitions[action].title })).not.toBeInTheDocument();
    }
    expect(fixture.posts()).toEqual([]);
  });

  it.each(["readOnly", "preview_read_only"] as const)(
    "initial %s forbids both mutations even with admin:write",
    async (mode) => {
      runtime.readOnly = mode === "readOnly";
      runtime.status = mode === "preview_read_only" ? "preview_read_only" : "preview";
      const fixture = await setup();
      expect(screen.getByTestId("effective-access")).toHaveTextContent('"readOnly":true');
      for (const action of ["kill", "policy"] as const) {
        const button = screen.getByRole("button", { name: definitions[action].trigger });
        expect.soft(button).toBeDisabled();
        // If the baseline wrongly exposes an enabled control, exercise its real UI path.
        if (!button.hasAttribute("disabled")) {
          const opened = await open(action);
          await opened.user.click(opened.confirm);
          await waitFor(() =>
            expect(screen.queryByRole("dialog", { name: definitions[action].title })).not.toBeInTheDocument(),
          );
        }
      }
      expect.soft(fixture.posts()).toEqual([]);
      expect(fixture.unexpected).toEqual([]);
    },
  );

  it.each(["feature-readonly", "write-scope"] as const)(
    "open confirmation preserves intent but blocks direct callbacks after %s revocation",
    async (mode) => {
      for (const action of ["kill", "policy"] as const) {
        runtime.scopes = [...writes];
        runtime.readOnly = false;
        const fixture = await setup();
        const opened = await open(action);
        const epoch = tokenStore.getSessionEpoch();
        if (mode === "feature-readonly") runtime.readOnly = true;
        else runtime.scopes = [...reads];
        fixture.rerender();
        expect(tokenStore.getSessionEpoch()).toBe(epoch);
        expect(screen.getByRole("dialog", { name: definitions[action].title })).toBeInTheDocument();
        if (action === "kill") expect(within(opened.dialog).getByLabelText(/변경 사유/u)).toHaveValue(reason);
        expect.soft(opened.confirm).toBeDisabled();
        // This is the real callback captured before revocation, not a disabled DOM click.
        await invoke(opened.callback);
        expect.soft(fixture.posts()).toEqual([]);
        expect(fixture.unexpected).toEqual([]);
        const beforeRestore = fixture.posts().length;
        runtime.scopes = [...writes];
        runtime.readOnly = false;
        await act(async () => fixture.rerender());
        expect(fixture.posts()).toHaveLength(beforeRestore);
        fixture.dispose();
      }
    },
  );
});
