import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useState, type MouseEvent } from "react";
import { beforeEach, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import type { Policy } from "@/shared/api/domains/governance";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { mockApi, type MockedRequestOptions } from "@/test/api";
import { renderScreen } from "@/test/render";
import { PolicyEngineSection } from "./PolicyEngineSection";

const runtime = vi.hoisted(() => ({
  mode: "writable",
  owner: "governance.policies",
  principal: "public_a",
  scopes: ["security:read", "admin:read", "admin:write"],
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({
  save: undefined as ButtonModule.ButtonProps["onClick"],
  open: undefined as ButtonModule.ButtonProps["onClick"],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.principal } });
      return {
        ...auth,
        credentialPrefixes: runtime.prefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "governance.policies"
            ? {
                ...feature,
                readOnly: runtime.mode === "read_only",
                status: runtime.mode === "preview_read_only" ? "preview_read_only" : "preview",
              }
            : feature,
        ),
      };
    },
  };
});
// Actual buttons remain. Direct captured callbacks are unit-only boundary evidence.
vi.mock("@/shared/components/ui/Button", async (original) => {
  const module = await original<typeof ButtonModule>();
  return {
    ...module,
    Button: (props: ButtonModule.ButtonProps) => {
      if (props.children === "검토한 내용 저장") captured.save = props.onClick;
      if (props.children === "초안 편집") captured.open = props.onClick;
      return <module.Button {...props} />;
    },
  };
});
export const policy: Policy = {
  id: "pol_public_draft",
  name: "공개 초안",
  description: "공개 설명",
  enabled: false,
  priority: 100,
  rollout_percent: 37,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-01T00:00:00Z",
  rules: [
    {
      id: "rule_public_one",
      policy_id: "pol_public_draft",
      name: "첫 규칙",
      enabled: true,
      priority: 100,
      conditions: { model: "public-model", future: { nested: [1, "원문", { enabled: false }] } },
      actions: { block: true },
    },
    {
      id: "rule_public_two",
      policy_id: "pol_public_draft",
      name: "둘째 규칙",
      enabled: false,
      priority: -5,
      conditions: { contains_secret: true },
      actions: { secret_action: "mask" },
    },
  ],
};
export const savePath = "POST /admin/policies";
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  Object.assign(runtime, {
    mode: "writable",
    owner: "governance.policies",
    principal: "public_a",
    scopes: ["security:read", "admin:read", "admin:write"],
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  captured.save = undefined;
  captured.open = undefined;
  tokenStore.clearAll();
});
export async function setupEditor(initial: Policy = structuredClone(policy)) {
  const response: { rows: Policy[]; list: () => unknown; save: (options: MockedRequestOptions) => unknown } =
    {
      rows: [initial],
      list: () => ({ policies: structuredClone(response.rows) }),
      save: (options) => {
        const body = options.body as Policy;
        const stored = {
          ...structuredClone(body),
          rules: body.rules?.map((rule, index) => ({ ...rule, id: rule.id ?? `public_created_${index}` })),
        };
        response.rows = [stored];
        return { policy: stored };
      },
    };
  const api = mockApi({
    "GET /admin/policies": () => response.list(),
    "GET /admin/policies/regression/cases": () => ({ cases: [] }),
    [savePath]: async (options) => {
      const epoch = tokenStore.getSessionEpoch();
      const result = await response.save(options);
      if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
      return result;
    },
  });
  let refresh = () => {};
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((value) => value + 1);
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
  await screen.findByRole("table", { name: "AI 정책 목록" });
  await screen.findByRole("button", { name: / (?:사용|중지)$/u });
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    open: () => screen.getByRole("button", { name: / 초안 편집$/u }),
    dialog: () => screen.getByRole("dialog", { name: "비활성 정책 편집" }),
    save: () => screen.getByRole("button", { name: "검토한 내용 저장" }),
    update(change: Partial<typeof runtime>) {
      Object.assign(runtime, change);
      act(() => refresh());
    },
    captureSave() {
      const click = captured.save;
      if (!click) throw new Error("missing save callback");
      const node = screen.getByRole("button", { name: "검토한 내용 저장" });
      return () => click({ currentTarget: node } as MouseEvent<HTMLButtonElement>);
    },
    captureOpen() {
      const click = captured.open;
      if (!click) throw new Error("missing open callback");
      const node = screen.getByRole("button", { name: / 초안 편집$/u, hidden: true });
      return () => click({ currentTarget: node } as MouseEvent<HTMLButtonElement>);
    },
    async editName(value = "바꾼 초안") {
      await this.user.clear(within(this.dialog()).getByRole("textbox", { name: "정책 이름" }));
      await this.user.type(within(this.dialog()).getByRole("textbox", { name: "정책 이름" }), value);
      await this.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    },
  };
}
