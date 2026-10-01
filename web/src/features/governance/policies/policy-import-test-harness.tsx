import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type MouseEvent } from "react";
import { afterEach, beforeEach, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import type { PolicyImportBody } from "@/shared/api/domains/policy-import";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { mockApi, type MockedRequestOptions } from "@/test/api";
import { renderScreen } from "@/test/render";
import { PolicyEngineSection } from "./PolicyEngineSection";

const runtime = vi.hoisted(() => ({
  authMode: "authenticated" as "authenticated" | "legacy" | "open",
  readOnly: false,
  owner: "governance.policies",
  principal: "public_a",
  scopes: ["security:read", "admin:read", "admin:write"],
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => new Map<string, ButtonModule.ButtonProps["onClick"]>());
afterEach(() => vi.unstubAllGlobals());
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.principal } });
      return {
        ...auth,
        mode: runtime.authMode,
        credentialPrefixes: runtime.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "governance.policies"
            ? { ...feature, serverAvailable: true, readOnly: runtime.readOnly }
            : feature,
        ),
      };
    },
  };
});
vi.mock("@/shared/components/ui/Button", async (original) => {
  const module = await original<typeof ButtonModule>();
  return {
    ...module,
    Button: (props: ButtonModule.ButtonProps) => {
      if (typeof props.children === "string") captured.set(props.children, props.onClick);
      return <module.Button {...props} />;
    },
  };
});
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
export const importPath = "POST /admin/policies/import";
export const publicPolicy = {
  id: "public_policy",
  name: "이전 공개 정책",
  enabled: false,
  priority: 100,
  rollout_percent: 100,
  description: "이전 설명",
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  rules: [
    {
      id: "public_rule",
      policy_id: "public_policy",
      name: "이전 규칙",
      enabled: true,
      priority: 100,
      conditions: { model: "public" },
      actions: { block: true },
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    },
  ],
};
export const importBody: PolicyImportBody = {
  policies: [{ id: "public_policy", name: "파일의 공개 정책", enabled: false, rules: null }],
};
export function acknowledgement(body: PolicyImportBody, dry: boolean) {
  return {
    dry_run: dry,
    created: 0,
    updated: body.policies.length,
    plan: body.policies.map((row) => ({
      id: row.id,
      name: row.name,
      action: "update",
      rules: row.rules?.length ?? 0,
    })),
  };
}
beforeEach(() => {
  Object.assign(runtime, {
    authMode: "authenticated",
    readOnly: false,
    owner: "governance.policies",
    principal: "public_a",
    scopes: ["security:read", "admin:read", "admin:write"],
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  tokenStore.clearAll();
  captured.clear();
});
export async function setupImport() {
  const response = {
    rows: [structuredClone(publicPolicy)],
    get row() {
      const row = this.rows[0];
      if (!row) throw new Error("missing synthetic row");
      return row;
    },
    list: (): unknown => ({ policies: structuredClone(response.rows) }),
    export: (): unknown => ({
      version: 1,
      count: response.rows.length,
      policies: structuredClone(response.rows),
    }),
    post: (options: MockedRequestOptions): unknown =>
      acknowledgement(
        options.body as PolicyImportBody,
        (options.query as { dry_run?: string } | undefined)?.dry_run === "1",
      ),
  };
  const api = mockApi({
    "GET /admin/policies": () => response.list(),
    "GET /admin/policies/regression/cases": () => ({ cases: [] }),
    [importPath]: async (options) => {
      const epoch = tokenStore.getSessionEpoch();
      const result = await response.post(options);
      // Existing shared-client epoch behavior only; no permission/payload enforcement.
      if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
      return result;
    },
  });
  const exports: Array<{ signal: AbortSignal | null | undefined }> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    if (input !== "/admin/policies/export" || options?.method !== "GET")
      throw new Error("Unexpected synthetic transport path");
    exports.push({ signal: options.signal }); // Record before processing, no UI guard emulation.
    const value = await response.export();
    return value instanceof Response
      ? value
      : new Response(typeof value === "string" ? value : JSON.stringify(value), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
  });
  let rerender = () => {};
  function Host() {
    const [, setVersion] = useState(0);
    useEffect(() => {
      rerender = () => setVersion((value) => value + 1);
    }, []);
    const feature = migrationRegistry.find((row) => row.featureId === runtime.owner);
    if (!feature) throw new Error("missing feature");
    return (
      <FeatureRoute feature={feature}>
        <PolicyEngineSection canWrite={runtime.scopes.includes("admin:write")} />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/governance/policies" });
  const user = userEvent.setup();
  await screen.findByRole("table", { name: "AI 정책 목록" });
  const dialog = () => screen.getByRole("dialog", { name: "정책 가져오기" });
  return {
    api,
    exports,
    response,
    view,
    user,
    dialog,
    update(change: Partial<typeof runtime>) {
      Object.assign(runtime, change);
      act(() => rerender());
    },
    async open() {
      await user.click(screen.getByRole("button", { name: "정책 가져오기" }));
      return dialog();
    },
    async file(body: PolicyImportBody = importBody, name = "public.json") {
      await user.upload(
        within(dialog()).getByLabelText("정책 JSON 파일"),
        new File([JSON.stringify(body)], name, { type: "application/json" }),
      );
      await screen.findByText(/로컬 형식 확인 완료/);
    },
    async plan() {
      await user.click(within(dialog()).getByRole("button", { name: "서버 계획 확인" }));
      await screen.findByRole("heading", { name: "서버 계획과 변경 내용" });
    },
    async confirm() {
      await user.type(screen.getByRole("textbox", { name: "확인 문구" }), "정책 가져오기");
    },
    async idle() {
      await waitFor(() => {
        if (screen.queryByText(/^(정책을 적용|파일을 확인|정책 기준을 확인) 중입니다\.$/u))
          throw new Error("still pending");
      });
    },
    posts() {
      return api.calls.filter((call) => call.key === importPath);
    },
    capture(label: string) {
      const click = captured.get(label);
      if (!click) throw new Error("missing callback");
      const node = screen.getByRole("button", { name: label });
      // Captured callbacks are controlled unit evidence, not physical browser clicks.
      return () => click({ currentTarget: node } as MouseEvent<HTMLButtonElement>);
    },
  };
}
