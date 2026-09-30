import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState, type ComponentProps } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { z } from "zod";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { RoutingPage } from "@/features/routing/rules/RoutingPage";
import { routingRulesQueryKey } from "@/features/routing/rules/routing-shared";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ConfirmDialogModule from "@/shared/components/ui/ConfirmDialog";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

export type AccessMode = "writable" | "read_only" | "preview_read_only";
const runtime = vi.hoisted(() => ({
  mode: "writable",
  scopes: ["routing:read", "routing:write"],
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({
  confirm: undefined as ((reason: string) => unknown) | undefined,
}));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
export const getToggleToasts = () => toasts;

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes });
      return {
        ...auth,
        credentialPrefixes: runtime.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "routing.rules"
            ? {
                ...feature,
                status: runtime.mode === "preview_read_only" ? "preview_read_only" : "preview",
                readOnly: runtime.mode === "read_only",
              }
            : feature,
        ),
      };
    },
  };
});
vi.mock("sonner", () => ({ toast: toasts }));
vi.mock("@/shared/components/ui/ConfirmDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfirmDialogModule>();
  return {
    ...actual,
    ConfirmDialog: (props: ComponentProps<typeof actual.ConfirmDialog>) => {
      if (props.open && ["라우팅 규칙 중지", "라우팅 규칙 사용"].includes(props.title)) {
        captured.confirm = props.onConfirm;
      }
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

export const patchPath = "PATCH /admin/routing-rules/route_public_a";
export const initialRule: RoutingRule = {
  id: "route_public_a",
  enabled: true,
  priority: 10,
  match_pattern: "gpt-*",
  min_complexity: 0,
  max_complexity: 40,
  target_model: "public-model-a",
  target_provider: "public-provider",
  note: "공개 합성 규칙",
  created_at: "2026-09-30T00:00:00Z",
};
const toggleBody = z.object({ enabled: z.boolean() }).strict();

beforeEach(() => {
  runtime.mode = "writable";
  runtime.scopes = ["routing:read", "routing:write"];
  runtime.prefixes = ["vc_sk_", "vc_sa_"];
  captured.confirm = undefined;
  toasts.success.mockClear();
  toasts.error.mockClear();
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());

export async function setupToggle(enabled = true, write = true, overrides: Partial<RoutingRule> = {}) {
  runtime.scopes = write ? ["routing:read", "routing:write"] : ["routing:read"];
  const rule = { ...initialRule, ...overrides, enabled };
  const records = new Map([[rule.id, { ...rule }]]);
  const currentPatchPath = `PATCH /admin/routing-rules/${encodeURIComponent(rule.id)}`;
  const response: { read?: () => unknown; patch?: (rule: RoutingRule) => unknown } = {};
  // React callback/request evidence only. The fixture intentionally does not
  // enforce feature readonly or scopes, and is not a Go RBAC/CAS/audit proof.
  const api = mockApi({
    "GET /admin/routing-rules": () =>
      response.read ? response.read() : { rules: [...records.values()].map((rule) => ({ ...rule })) },
    [currentPatchPath]: ({ body }) => {
      const values = toggleBody.parse(body);
      const current = records.get(rule.id);
      if (!current) throw new AppError("규칙을 찾을 수 없습니다.", { kind: "http", status: 404 });
      const saved = { ...current, ...values };
      records.set(saved.id, saved);
      return response.patch ? response.patch(saved) : { rule: { ...saved } };
    },
  });
  const feature = migrationRegistry.find((candidate) => candidate.featureId === "routing.rules");
  if (!feature) throw new Error("missing actual routing.rules registry entry");
  const routingFeature = feature;
  const queryKey = [...routingRulesQueryKey, tokenStore.getSessionEpoch(), "routing.rules"] as const;
  let refresh: () => void = () => undefined;
  function AccessProbe() {
    const access = useContext(FeatureAccessContext);
    return (
      <output data-testid="routing-toggle-access">{`${access?.featureId}:${String(access?.readOnly)}`}</output>
    );
  }
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((revision) => revision + 1);
      return () => {
        refresh = () => undefined;
      };
    }, []);
    return (
      <FeatureRoute feature={routingFeature}>
        <AccessProbe />
        <RoutingPage />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules", path: "/routing/rules/*" });
  await screen.findAllByRole("cell", { name: rule.target_model });
  const panel = document.querySelector<HTMLElement>(".routing-panel-stack");
  if (!panel) throw new Error("missing actual RulesTab panel");
  expect(screen.getByTestId("routing-toggle-access")).toHaveTextContent("routing.rules:false");
  return {
    api,
    rule,
    patchPath: currentPatchPath,
    records,
    response,
    view,
    panel,
    queryKey,
    user: userEvent.setup(),
    update(mode: AccessMode, canWrite = true) {
      act(() => {
        runtime.mode = mode;
        runtime.scopes = canWrite ? ["routing:read", "routing:write"] : ["routing:read"];
        refresh();
      });
      expect(screen.getByTestId("routing-toggle-access")).toHaveTextContent(
        `routing.rules:${String(mode !== "writable")}`,
      );
    },
    scopes(scopes: string[]) {
      act(() => {
        runtime.scopes = scopes;
        refresh();
      });
    },
    prefixes(prefixes: string[]) {
      act(() => {
        runtime.prefixes = prefixes;
        refresh();
      });
    },
    async refetch() {
      await act(async () => {
        await view.client.refetchQueries({ queryKey, exact: true });
      });
    },
  };
}

export async function openToggle(current: Awaited<ReturnType<typeof setupToggle>>, enabled = true) {
  const trigger = screen.getByRole("button", {
    name: `${current.rule.match_pattern || "*"} → ${current.rule.target_model} 규칙 ${enabled ? "중지" : "사용"}`,
  });
  await current.user.click(trigger);
  const dialog = screen.getByRole("dialog", { name: `라우팅 규칙 ${enabled ? "중지" : "사용"}` });
  const confirm = captured.confirm;
  if (!confirm) throw new Error("missing rendered actual onConfirm callback");
  expect(within(dialog).getByRole("button", { name: enabled ? "중지" : "사용" })).toBeEnabled();
  return { dialog, trigger, confirm };
}
