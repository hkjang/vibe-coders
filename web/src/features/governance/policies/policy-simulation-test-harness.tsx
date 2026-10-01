import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState, type MouseEvent } from "react";
import { beforeEach, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { AppError } from "@/shared/api/error";
import type { PolicySimulation, PolicySuggestion } from "@/shared/api/domains/governance";
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
  credentialPrefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({ click: undefined as ButtonModule.ButtonProps["onClick"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.principal } });
      return {
        ...auth,
        credentialPrefixes: runtime.credentialPrefixes,
        features: auth.features.map((feature) =>
          feature.featureId === "governance.policies"
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
// Keep the real Button DOM; capture only the rendered handler. Direct callback
// assertions are not physical browser click or actual Go authorization proof.
vi.mock("@/shared/components/ui/Button", async (importOriginal) => {
  const original = await importOriginal<typeof ButtonModule>();
  return {
    ...original,
    Button: (props: ButtonModule.ButtonProps) => {
      if (props["aria-label"]?.endsWith(" 섀도우 영향 확인")) captured.click = props.onClick;
      return <original.Button {...props} />;
    },
  };
});
export const simulationPath = "POST /admin/policies/simulate";
export const suggestion: PolicySuggestion = {
  id: "psug_public_a",
  title: "공개 모델 승인 검토",
  severity: "warning",
  rationale: "공개 합성 비용 변동",
  conditions: { model: "public-model" },
  actions: { require_approval: true },
};
export const simulationResult: PolicySimulation = {
  evaluated: 4,
  blocked: 1,
  require_approval: 1,
  allowed: 2,
  block_rate: 0.25,
  since: "2026-09-24T00:00:00Z",
  shadow: {
    affected_keys: 1,
    affected_teams: 1,
    false_positive_candidates: 1,
    false_positive_rate: 1,
    blocked_cost_krw: 100,
  },
};
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
  runtime.mode = "writable";
  runtime.principal = "usr_public_a";
  runtime.owner = "governance.policies";
  runtime.scopes = ["security:read", "admin:read", "admin:write"];
  runtime.credentialPrefixes = ["vc_sk_", "vc_sa_"];
  captured.click = undefined;
  tokenStore.clearAll();
});
export async function setupSimulation(mode = "writable") {
  runtime.mode = mode;
  const response: {
    rows: PolicySuggestion[];
    simulate: () => PolicySimulation | Promise<PolicySimulation>;
  } = { rows: [structuredClone(suggestion)], simulate: () => simulationResult };
  const api = mockApi({
    "GET /admin/policy-advisor/suggestions": () => ({ suggestions: response.rows }),
    "GET /admin/policies/canary-status": () => ({ policies: [] }),
    "GET /admin/policies": () => ({ policies: [] }),
    [simulationPath]: async () => {
      const epoch = tokenStore.getSessionEpoch();
      try {
        const result = await response.simulate();
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        return result;
      } catch (cause) {
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        throw cause;
      }
    },
  });
  let refresh: () => void = () => undefined;
  function Probe() {
    const context = useContext(FeatureAccessContext);
    return (
      <output data-testid="simulation-access">{`${context?.featureId}:${String(context?.readOnly)}`}</output>
    );
  }
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((value) => value + 1);
    }, []);
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
  await screen.findByText(suggestion.title ?? "");
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    button: () => screen.getByRole("button", { name: / 섀도우 영향 확인$/u }),
    capture() {
      const click = captured.click;
      if (!click) throw new Error("missing simulation handler");
      const button = screen.getByRole("button", { name: / 섀도우 영향 확인$/u });
      return () => click({ currentTarget: button } as MouseEvent<HTMLButtonElement>);
    },
    update(change: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, change);
        refresh();
      });
    },
  };
}
