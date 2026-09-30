import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useContext, useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { ChatTestPage } from "@/features/gateway/chat/ChatTestPage";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({
  scopes: ["admin:read", "admin:write"],
  mode: "writable",
}));
const toastSpy = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: authRuntime.scopes });
      return {
        ...auth,
        features: auth.features.map((feature) =>
          feature.featureId === "gateway.chat"
            ? {
                ...feature,
                status: authRuntime.mode === "preview_read_only" ? "preview_read_only" : "preview",
                readOnly: authRuntime.mode === "read_only",
              }
            : feature,
        ),
      };
    },
  };
});
vi.mock("sonner", () => ({ toast: toastSpy }));

const promptA = "공개 질문 A: 첫 실행의 내용을 요약하세요.";
const promptB = "공개 질문 B: 아직 실행하지 않은 다음 초안입니다.";
const runEndpoint = "POST /admin/chat-test/multi-run";
const judgeEndpoint = "POST /admin/chat-test/multi-run/judge";
const goldenEndpoint = "POST /admin/chat-test/multi-run/runs/public-run-a/golden";

function AccessProbe() {
  const access = useContext(FeatureAccessContext);
  return <output data-testid="actual-feature-readonly">{String(access?.readOnly)}</output>;
}

beforeEach(() => {
  authRuntime.scopes = ["admin:read", "admin:write"];
  authRuntime.mode = "writable";
  toastSpy.success.mockClear();
  toastSpy.error.mockClear();
});
afterEach(() => vi.restoreAllMocks());

async function setup(handlers: Readonly<Record<string, ApiHandler>> = {}) {
  // Component-only API boundary: no provider or real Go server. The mock records
  // calls and never enforces UI scope/readonly itself, so an escaped write is seen.
  const api = mockApi({
    "GET /admin/chat-test/multi-run/runs": () => ({ runs: [] }),
    [runEndpoint]: () => ({
      status: "completed",
      run_id: "public-run-a",
      summary: { total_models: 1, success: 1, failed: 0 },
      results: [
        {
          model: "public-model",
          provider: "public-provider",
          status: "success",
          latency_ms: 12,
          input_tokens: 8,
          output_tokens: 10,
          cost_krw_est: 0.1,
          content: "공개 실행 A의 응답",
        },
      ],
    }),
    [judgeEndpoint]: () => ({
      run_id: "public-run-a",
      method: "rule",
      best_model: "public-model",
      judgements: [],
    }),
    [goldenEndpoint]: () => ({
      status: "saved",
      workflow_id: "public-workflow",
      workflow_name: "공개 회귀 검사",
      step_name: "public-step",
      step_count: 1,
      baseline_score: 4,
    }),
    ...handlers,
  });
  const feature = migrationRegistry.find((item) => item.featureId === "gateway.chat");
  if (!feature) throw new Error("missing actual chat feature");
  const chatFeature = feature;
  let update: () => void = () => undefined;
  function Host() {
    const [, setRevision] = useState(0);
    useEffect(() => {
      update = () => setRevision((revision) => revision + 1);
      return () => {
        update = () => undefined;
      };
    }, []);
    return (
      <FeatureRoute feature={chatFeature}>
        <AccessProbe />
        <ChatTestPage />
      </FeatureRoute>
    );
  }
  renderScreen(<Host />, { path: "/gateway/chat", route: "/gateway/chat?tab=compare" });
  const user = userEvent.setup();
  const models = await screen.findByLabelText(/^비교할 모델/u);
  await user.clear(models);
  await user.type(models, "public-model:public-provider");
  await user.type(screen.getByLabelText(/^사용자 질문/u), promptA);
  return {
    api,
    user,
    mode(mode: string) {
      act(() => {
        authRuntime.mode = mode;
        update();
      });
      expect(screen.getByTestId("actual-feature-readonly")).toHaveTextContent(String(mode !== "writable"));
    },
    revokeWrite() {
      act(() => {
        authRuntime.scopes = ["admin:read"];
        update();
      });
    },
  };
}

async function runComparison(view: Awaited<ReturnType<typeof setup>>) {
  await view.user.click(screen.getByRole("button", { name: "멀티 실행" }));
  await screen.findByText("공개 실행 A의 응답");
  expect(view.api.bodies(runEndpoint)).toEqual([
    expect.objectContaining({ messages: [{ role: "user", content: promptA }], save_prompt: false }),
  ]);
}

async function openGolden(view: Awaited<ReturnType<typeof setup>>) {
  await view.user.click(screen.getByRole("button", { name: "골든 답변으로 저장" }));
  const dialog = await screen.findByRole("dialog", { name: "골든 답변으로 저장" });
  await view.user.type(within(dialog).getByLabelText(/^워크플로 이름/u), "공개 회귀 검사");
  return dialog;
}

describe("비교 실행의 고정 결과와 전송 승인 재현", () => {
  it.each([
    ["rule", "규칙 기반"],
    ["model", "심사 모델"],
    ["future-method", "future-method"],
    ["constructor", "constructor"],
  ])("평가 방식 %s는 알려진 값만 한글로 표시하고 전송 코드는 유지한다", async (method, label) => {
    const view = await setup({
      [judgeEndpoint]: () => ({
        run_id: "public-run-a",
        method,
        best_model: "public-model",
        judgements: [],
      }),
    });
    await runComparison(view);
    if (method === "model") {
      await view.user.selectOptions(screen.getByLabelText("자동 평가 방식"), "model");
      await view.user.type(screen.getByLabelText(/^심사 모델/u), "public-judge");
    }
    await view.user.click(screen.getByRole("button", { name: "자동 평가 실행" }));
    expect(await screen.findByText(`방식 ${label} · 최고 점수 모델 public-model`)).toBeVisible();
    expect(view.api.bodies(judgeEndpoint)).toEqual([
      expect.objectContaining({ method: method === "model" ? "model" : "rule" }),
    ]);
  });

  it("코드 위험도는 기존 한글 명칭을 사용하고 미지정·새 코드·객체 속성명은 안전하게 표시한다", async () => {
    const levels = ["high", "medium", "low", "none", "future-risk", "constructor", null];
    const labels = ["높음", "보통", "낮음", "없음", "future-risk", "constructor", "-"];
    const view = await setup({
      "GET /admin/chat-test/multi-run/runs/public-run-a/code-verify": () => ({
        run_id: "public-run-a",
        leaderboard: levels.map((risk, index) => ({
          model: `public-risk-${index}`,
          risk,
          block_count: 1,
          high: 0,
          medium: 0,
        })),
      }),
    });
    await runComparison(view);
    await view.user.click(screen.getByRole("button", { name: "코드 위험 비교" }));
    for (const label of labels) {
      expect(await screen.findByText(`위험도 ${label} · 코드 블록 1 · 높음 0 · 보통 0`)).toBeVisible();
    }
  });

  it("C 실행 대기 중 연 A의 골든 초안은 C 완료 뒤에도 대상·모델·질문·dirty 입력을 유지한다", async () => {
    let resolveC: (value: unknown) => void = () => undefined;
    const heldC = new Promise((resolve) => {
      resolveC = resolve;
    });
    let runCount = 0;
    const response = (id: string, model: string, content: string) => ({
      status: "completed",
      run_id: id,
      results: [{ model, provider: "public-provider", status: "success", content }],
    });
    const view = await setup({
      [runEndpoint]: () =>
        ++runCount === 1 ? response("public-run-a", "public-model", "공개 실행 A의 응답") : heldC,
    });
    await runComparison(view);
    const prompt = screen.getByLabelText(/^사용자 질문/u);
    await view.user.clear(prompt);
    await view.user.type(prompt, promptB);
    const models = screen.getByLabelText(/^비교할 모델/u);
    await view.user.clear(models);
    await view.user.type(models, "public-model-c:public-provider");
    await view.user.click(screen.getByRole("button", { name: "멀티 실행" }));
    expect(view.api.bodies(runEndpoint)).toHaveLength(2);
    const dialog = await openGolden(view);
    const originalInput = within(dialog).getByLabelText(/^워크플로 이름/u);
    await act(async () => resolveC(response("public-run-c", "public-model-c", "공개 실행 C의 응답")));
    await screen.findByText("공개 실행 C의 응답");
    expect(dialog.isConnected).toBe(true);
    expect(within(dialog).getByLabelText(/^워크플로 이름/u)).toBe(originalInput);
    expect(originalInput).toHaveValue("공개 회귀 검사");
    expect(dialog).toHaveAccessibleDescription(expect.stringContaining("public-run-a"));
    const modelSelect = within(dialog).getByLabelText(/^모델/u);
    expect(modelSelect).toHaveValue("public-model");
    expect(within(modelSelect).queryByRole("option", { name: "public-model-c" })).not.toBeInTheDocument();
    await view.user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.api.bodies(goldenEndpoint)).toHaveLength(1));
    expect(view.api.bodies(goldenEndpoint)[0]).toMatchObject({
      selected_model: "public-model",
      prompt: promptA,
    });
    expect(view.api.bodies("POST /admin/chat-test/multi-run/runs/public-run-c/golden")).toHaveLength(0);
  });

  it("정상 대조: 질문을 편집하지 않으면 실행 A와 골든 저장의 질문·모델이 일치한다", async () => {
    const view = await setup();
    await runComparison(view);
    const dialog = await openGolden(view);
    await view.user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.api.bodies(goldenEndpoint)).toHaveLength(1));
    expect(view.api.bodies(goldenEndpoint)[0]).toMatchObject({
      selected_model: "public-model",
      prompt: promptA,
    });
  });

  it("실행 A 뒤 질문 B를 편집해도 골든에는 실행 A의 질문을 전송한다", async () => {
    const view = await setup();
    await runComparison(view);
    const prompt = screen.getByLabelText(/^사용자 질문/u);
    await view.user.clear(prompt);
    await view.user.type(prompt, promptB);
    const dialog = await openGolden(view);
    await view.user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(view.api.bodies(goldenEndpoint)).toHaveLength(1));
    expect(view.api.bodies(runEndpoint)).toHaveLength(1);
    expect(view.api.bodies(goldenEndpoint)[0]).toMatchObject({
      selected_model: "public-model",
      prompt: promptA,
    });
  });

  it("정상 대조: 최초 admin:write 부재는 비교와 순수 비용 계산의 기존 권한을 상향하지 않는다", async () => {
    authRuntime.scopes = ["admin:read"];
    const view = await setup();
    expect(screen.getByRole("button", { name: "멀티 실행" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "예상 비용" })).toBeDisabled();
    expect(view.api.bodies(runEndpoint)).toHaveLength(0);
  });

  it.each(["read_only", "preview_read_only"])(
    "실제 FeatureRoute %s는 새 비교 전송을 막고 입력을 보존한다",
    async (mode) => {
      const view = await setup();
      view.mode(mode);
      // Real user click, not a disabled-attribute override or captured-handler claim.
      await view.user.click(screen.getByRole("button", { name: "멀티 실행" }));
      expect(screen.getByLabelText(/^사용자 질문/u)).toHaveValue(promptA);
      expect(view.api.bodies(runEndpoint)).toHaveLength(0);
    },
  );

  it.each(["read_only", "preview_read_only"])(
    "실행 후 %s는 점수를 저장하는 새 자동 평가 전송을 막는다",
    async (mode) => {
      const view = await setup();
      await runComparison(view);
      view.mode(mode);
      await view.user.click(screen.getByRole("button", { name: "자동 평가 실행" }));
      expect(view.api.bodies(judgeEndpoint)).toHaveLength(0);
    },
  );

  it.each(["scope", "read_only"])(
    "열린 골든 초안의 %s 변경 뒤 실제 form submit은 전송하지 않는다",
    async (boundary) => {
      const view = await setup();
      await runComparison(view);
      const dialog = await openGolden(view);
      if (boundary === "scope") view.revokeWrite();
      else view.mode("read_only");
      expect(within(dialog).getByLabelText(/^워크플로 이름/u)).toHaveValue("공개 회귀 검사");
      const form = dialog.querySelector("form");
      if (!form) throw new Error("missing actual golden form");
      const nativeSubmit = vi.fn();
      form.addEventListener("submit", nativeSubmit);
      await act(async () => form.requestSubmit());
      expect(nativeSubmit).toHaveBeenCalledTimes(1);
      expect(view.api.bodies(goldenEndpoint)).toHaveLength(0);
    },
  );
});
