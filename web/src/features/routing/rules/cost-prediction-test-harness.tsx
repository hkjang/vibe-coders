import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  isValidElement,
  useContext,
  useEffect,
  useState,
  type ChangeEvent,
  type ComponentProps,
  type MouseEvent,
} from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { AppError } from "@/shared/api/error";
import type { RoutingCostEstimate } from "@/shared/api/domains/routing";
import { tokenStore } from "@/shared/auth/token-store";
import type { ButtonProps } from "@/shared/components/ui/Button";
import type * as InputModule from "@/shared/components/ui/Input";
import type * as SectionCardModule from "@/shared/components/ui/SectionCard";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { RoutingPage } from "./RoutingPage";

export type CostMode = "writable" | "read_only" | "preview_read_only";
const runtime = vi.hoisted(() => ({
  mode: "writable",
  scopes: ["routing:read", "admin:read", "admin:write"],
  owner: "routing.rules",
  userId: "cost-user-a",
  credentialPrefixes: ["vc_sk_", "vc_sa_"],
}));
const captured = vi.hoisted(() => ({
  click: undefined as ButtonProps["onClick"],
  inputs: new Map<string, InputModule.InputProps["onChange"]>(),
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.userId } });
      return {
        ...auth,
        credentialPrefixes: runtime.credentialPrefixes,
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
// Preserve real DOM. Captured event handlers are actual rendered callbacks,
// not physical clicks, native submits or proof that browsers admit Infinity.
vi.mock("@/shared/components/ui/SectionCard", async (importOriginal) => {
  const actual = await importOriginal<typeof SectionCardModule>();
  return {
    ...actual,
    SectionCard: (props: ComponentProps<typeof actual.SectionCard>) => {
      if (props.title === "비용 예측 가드" && isValidElement<ButtonProps>(props.actions))
        captured.click = props.actions.props.onClick;
      return <actual.SectionCard {...props} />;
    },
  };
});
vi.mock("@/shared/components/ui/Input", async (importOriginal) => {
  const actual = await importOriginal<typeof InputModule>();
  return {
    ...actual,
    Input: (props: InputModule.InputProps) => {
      if (props.id) captured.inputs.set(props.id, props.onChange);
      return <actual.Input {...props} />;
    },
  };
});

export const costPath = "POST /admin/cost/predict";
export const estimateResult: RoutingCostEstimate = {
  model: "public-cost-model",
  input_tokens: 1000,
  output_tokens: 600,
  cost_krw: 12.5,
  latency_ms: 40,
  priced: true,
  basis: "history",
};
beforeEach(() => {
  runtime.mode = "writable";
  runtime.scopes = ["routing:read", "admin:read", "admin:write"];
  runtime.owner = "routing.rules";
  runtime.userId = "cost-user-a";
  runtime.credentialPrefixes = ["vc_sk_", "vc_sa_"];
  captured.click = undefined;
  captured.inputs.clear();
  tokenStore.clearAll();
});
afterEach(() => vi.restoreAllMocks());
export function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<Value>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
export function costValue(label: string): HTMLElement {
  const card = screen.getByRole("heading", { name: "비용 예측 가드" }).closest("section");
  const term = [...(card?.querySelectorAll("dt") ?? [])].find((node) => node.textContent === label);
  if (!(term?.nextElementSibling instanceof HTMLElement)) throw new Error(`missing cost label ${label}`);
  return term.nextElementSibling;
}
export async function setupCost(mode: CostMode = "writable") {
  runtime.mode = mode;
  const response: { predict?: (body: unknown) => unknown; guard?: () => unknown } = {};
  const api = mockApi({
    "GET /admin/cost": () => (response.guard ? response.guard() : { enabled: false, threshold_krw: 0 }),
    [costPath]: async ({ body }) => {
      const epoch = tokenStore.getSessionEpoch();
      try {
        const result = await (response.predict ? response.predict(body) : estimateResult);
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        return result;
      } catch (cause) {
        // Mirror only the existing shared APIClient's post-await epoch guard;
        // no scope, readonly, numeric validation or fixture auto-retry here.
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        throw cause;
      }
    },
  });
  let refresh: () => void = () => undefined;
  function Probe() {
    const value = useContext(FeatureAccessContext);
    return <output data-testid="cost-access">{`${value?.featureId}:${String(value?.readOnly)}`}</output>;
  }
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      refresh = () => setRevision((revision) => revision + 1);
      return () => {
        refresh = () => undefined;
      };
    }, []);
    const feature = migrationRegistry.find((candidate) => candidate.featureId === runtime.owner);
    if (!feature) throw new Error("missing feature fixture");
    return (
      <FeatureRoute feature={feature}>
        <Probe />
        <RoutingPage />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules/preview" });
  await screen.findByText("제한 없음");
  expect(screen.getByTestId("cost-access")).toHaveTextContent(`routing.rules:${String(mode !== "writable")}`);
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    fields(model = "public-cost-model", input = "1000", max = "600") {
      fireEvent.change(screen.getByRole("textbox", { name: "모델" }), {
        target: { value: model },
      });
      fireEvent.change(screen.getByRole("spinbutton", { name: "입력 토큰" }), { target: { value: input } });
      fireEvent.change(screen.getByRole("spinbutton", { name: "최대 출력 토큰" }), {
        target: { value: max },
      });
    },
    capture() {
      const callback = captured.click;
      if (!callback) throw new Error("missing rendered cost callback");
      return () => callback(new window.MouseEvent("click") as unknown as MouseEvent<HTMLButtonElement>);
    },
    capturedInput(label: string, value: string) {
      const input = screen.getByLabelText(label);
      const callback = captured.inputs.get(input.id);
      if (!callback) throw new Error("missing rendered cost input callback");
      act(() => callback({ target: { value } } as ChangeEvent<HTMLInputElement>));
    },
    update(change: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, change);
        refresh();
      });
    },
  };
}
