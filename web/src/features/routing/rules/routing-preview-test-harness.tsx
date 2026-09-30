import { act, fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { isValidElement, useContext, useEffect, useState, type ComponentProps, type MouseEvent } from "react";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import type { ButtonProps } from "@/shared/components/ui/Button";
import type * as SectionCardModule from "@/shared/components/ui/SectionCard";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { PreviewTab } from "./PreviewTab";

export type PreviewMode = "writable" | "read_only" | "preview_read_only";
const runtime = vi.hoisted(() => ({
  mode: "writable",
  scopes: ["routing:read"],
  prefixes: ["vc_sk_", "vc_sa_"],
  owner: "routing.rules",
  userId: "preview-user-a",
}));
const captured = vi.hoisted(() => ({ click: undefined as ButtonProps["onClick"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: runtime.scopes, user: { id: runtime.userId } });
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
// Keep the real SectionCard/Button DOM. Capture the actual rendered handler for
// direct callback checks; those are not physical clicks or native form submits.
vi.mock("@/shared/components/ui/SectionCard", async (importOriginal) => {
  const actual = await importOriginal<typeof SectionCardModule>();
  return {
    ...actual,
    SectionCard: (props: ComponentProps<typeof actual.SectionCard>) => {
      if (props.title === "라우팅 미리보기" && isValidElement<ButtonProps>(props.actions))
        captured.click = props.actions.props.onClick;
      return <actual.SectionCard {...props} />;
    },
  };
});

export const previewPath = "POST /admin/routing/preview";
export const previewResult = {
  requested_model: "public-request-model",
  selected_model: "public-selected-model",
  selected_provider: "공개 합성 공급자",
  policy_api_key_id: "",
  complexity: { score: 10, tier: "low" },
  risk: { score: 0, tier: "low", categories: [] },
  health_score: 100,
  fallback_plan: [],
  route_reason: "client_model",
  decision_reason: "합성 읽기 미리보기",
  would_rewrite: false,
};

beforeEach(() => {
  runtime.mode = "writable";
  runtime.scopes = ["routing:read"];
  runtime.prefixes = ["vc_sk_", "vc_sa_"];
  runtime.owner = "routing.rules";
  runtime.userId = "preview-user-a";
  captured.click = undefined;
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

export async function setupPreview(mode: PreviewMode = "writable") {
  runtime.mode = mode;
  const response: { preview?: (body: unknown) => unknown } = {};
  const api = mockApi({
    // The adjacent cost card is not under test. This response is not evidence
    // that routing:read authorizes the real cost endpoint.
    "GET /admin/cost": () => ({ enabled: false, threshold_krw: 0 }),
    [previewPath]: async ({ body }) => {
      const epoch = tokenStore.getSessionEpoch();
      try {
        const result = await (response.preview ? response.preview(body) : previewResult);
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        return result;
      } catch (cause) {
        // Match the existing API client's epoch rejection so late-state tests
        // do not invent an old successful response it already prevents.
        if (epoch !== tokenStore.getSessionEpoch()) throw new AppError("old session", { kind: "aborted" });
        throw cause;
      }
    },
  });
  let refresh: () => void = () => undefined;
  function Probe() {
    const context = useContext(FeatureAccessContext);
    return (
      <output data-testid="preview-access">{`${context?.featureId}:${String(context?.readOnly)}`}</output>
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
    const feature = migrationRegistry.find((candidate) => candidate.featureId === runtime.owner);
    if (!feature) throw new Error("missing real feature registry item");
    return (
      <FeatureRoute feature={feature}>
        <Probe />
        <PreviewTab canPredict={false} />
      </FeatureRoute>
    );
  }
  const view = renderScreen(<Host />, { route: "/routing/rules/preview" });
  await screen.findByText("제한 없음");
  expect(screen.getByTestId("preview-access")).toHaveTextContent(
    `routing.rules:${String(mode !== "writable")}`,
  );
  return {
    api,
    response,
    view,
    user: userEvent.setup(),
    fields(model = "public-request-model", sample = "샘플 A", keyId = "") {
      fireEvent.change(screen.getByRole("textbox", { name: "요청 모델" }), { target: { value: model } });
      fireEvent.change(screen.getByRole("textbox", { name: "샘플 요청 내용" }), {
        target: { value: sample },
      });
      fireEvent.change(screen.getByRole("textbox", { name: "정책 API 키 ID" }), { target: { value: keyId } });
    },
    capture() {
      const callback = captured.click;
      if (!callback) throw new Error("missing actual rendered preview callback");
      return () => callback(new window.MouseEvent("click") as unknown as MouseEvent<HTMLButtonElement>);
    },
    update(change: Partial<typeof runtime>) {
      act(() => {
        Object.assign(runtime, change);
        refresh();
      });
    },
  };
}
