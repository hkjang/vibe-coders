import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState, type MouseEvent } from "react";
import { useNavigate } from "react-router";
import { beforeEach, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import type { PolicySuggestion } from "@/shared/api/domains/governance";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type * as ButtonModule from "@/shared/components/ui/Button";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { PolicyAdvisorTab } from "./PolicyAdvisorTab";

const runtime = vi.hoisted(() => ({
  mode: "writable",
  principal: "usr_public_a",
  owner: "governance.policies",
  scopes: ["security:read", "admin:read", "admin:write"],
  prefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({
  confirm: undefined as ButtonModule.ButtonProps["onClick"],
  open: undefined as ButtonModule.ButtonProps["onClick"],
  close: undefined as ButtonModule.ButtonProps["onClick"],
  review: undefined as ButtonModule.ButtonProps["onClick"],
  refresh: undefined as ButtonModule.ButtonProps["onClick"],
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
// Real DOM/buttons/FeatureRoute; captured callbacks are separate unit evidence,
// not browser disabled bypass or actual server permission proof.
vi.mock("@/shared/components/ui/Button", async (original) => {
  const module = await original<typeof ButtonModule>();
  return {
    ...module,
    Button: (props: ButtonModule.ButtonProps) => {
      if (props["aria-label"]?.match(/(?:draft 정책 생성|초안 생성)$/u)) captured.open = props.onClick;
      if (
        typeof props.children === "string" &&
        ["draft 생성", "초안 생성", "다시 초안 생성"].includes(props.children)
      )
        captured.confirm = props.onClick;
      if (props.children === "취소") captured.close = props.onClick;
      if (props.children === "원래 규칙 다시 확인") captured.review = props.onClick;
      if (props.children === "목록 다시 조회") captured.refresh = props.onClick;
      return <module.Button {...props} />;
    },
  };
});
export const applyPath = "POST /admin/policy-advisor/apply";
export const advice: PolicySuggestion = {
  id: "suggestion_public_a",
  title: "공개 모델 승인",
  conditions: { model: "public-model" },
  actions: { require_approval: true },
};
export const acknowledgement = { policy_id: "pol_public_created", enabled: false };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  Object.assign(runtime, {
    mode: "writable",
    principal: "usr_public_a",
    owner: "governance.policies",
    scopes: ["security:read", "admin:read", "admin:write"],
    prefixes: ["vc_sk_", "vc_sa_"],
  });
  captured.confirm = undefined;
  captured.open = undefined;
  captured.close = undefined;
  captured.review = undefined;
  captured.refresh = undefined;
  tokenStore.clearAll();
});
export async function setupDraft(mode = "writable") {
  runtime.mode = mode;
  const response: {
    rows: PolicySuggestion[];
    suggestions: () => unknown;
    apply: () => unknown;
    policies: () => unknown;
  } = {
    rows: [structuredClone(advice)],
    suggestions: () => ({ suggestions: response.rows }),
    apply: () => acknowledgement,
    policies: () => ({ policies: [] }),
  };
  const api = mockApi({
    "GET /admin/policy-advisor/suggestions": () => response.suggestions(),
    "GET /admin/policies/canary-status": () => ({ policies: [] }),
    "GET /admin/policies": () => response.policies(),
    "POST /admin/policies/simulate": () => ({ evaluated: 0 }),
    [applyPath]: async () => {
      // Preserve the already-existing shared API epoch defense, not UI permission checks.
      const epoch = tokenStore.getSessionEpoch();
      try {
        const result = await response.apply();
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        return result;
      } catch (cause) {
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        throw cause;
      }
    },
  });
  let refresh: () => void = () => undefined;
  let navigate: (path: string) => void = () => undefined;
  function Probe() {
    const context = useContext(FeatureAccessContext);
    return <output data-testid="draft-access">{`${context?.featureId}:${String(context?.readOnly)}`}</output>;
  }
  function Host() {
    const go = useNavigate();
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((value) => value + 1);
      navigate = go;
    }, [go]);
    const feature = migrationRegistry.find((row) => row.featureId === runtime.owner);
    if (!feature) throw new Error("missing feature");
    return (
      <FeatureRoute feature={feature}>
        <Probe />
        <PolicyAdvisorTab canWrite={runtime.scopes.includes("admin:write")} />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/governance/policies?tab=advisor" });
  await screen.findByText(advice.title ?? "");
  const button = () => screen.getByRole("button", { name: /(?:draft 정책 생성|초안 생성)$/u });
  const dialog = () => screen.getByRole("dialog");
  const confirm = () =>
    within(dialog()).getByRole("button", { name: /^(?:draft 생성|초안 생성|다시 초안 생성)$/u });
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    button,
    dialog,
    confirm,
    changeWindow(window: string) {
      act(() => navigate(`/governance/policies?tab=advisor&advisor_window=${window}`));
    },
    capture(which: keyof typeof captured = "confirm") {
      const click = captured[which];
      if (!click) throw new Error(`missing ${which}`);
      const node = which === "confirm" ? confirm() : button();
      return () => click({ currentTarget: node } as MouseEvent<HTMLButtonElement>);
    },
    update(change: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, change);
        refresh();
      });
    },
  };
}
