import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelContractsPanel } from "./ModelContractsPanel";
import { ModelDeprecationsPanel } from "./ModelDeprecationsPanel";
import { contractFixture, deprecationFixture, runFixture } from "./model-governance-test-fixtures";
import { modelGovernanceKeys } from "./use-model-governance";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { tokenStore } from "@/shared/auth/token-store";
import { featureReadonlyReason } from "@/shared/feature-access/policy";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readonly: false, write: true }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: ["admin:read", ...(runtime.write ? ["admin:write"] : [])] });
      return {
        ...auth,
        features: auth.features.map((feature) => ({ ...feature, readOnly: runtime.readonly })),
      };
    },
  };
});
beforeEach(() => {
  runtime.readonly = false;
  runtime.write = true;
  tokenStore.clearAll();
  toast.success.mockClear();
  toast.error.mockClear();
});
async function setup(
  kind: "contracts" | "deprecations" = "contracts",
  overrides: Record<string, ApiHandler> = {},
) {
  const api = mockApi({
    "GET /admin/models/contracts": () => ({ contracts: [contractFixture] }),
    "POST /admin/models/contracts": () => ({ id: contractFixture.id, ok: true }),
    "DELETE /admin/models/contracts": () => ({ ok: true }),
    "POST /admin/models/contracts/run": () => runFixture,
    "GET /admin/model-deprecations": () => ({ deprecations: [deprecationFixture] }),
    "POST /admin/model-deprecations": () => ({ deprecation: deprecationFixture }),
    "DELETE /admin/model-deprecations/moddep_original": () => ({ id: deprecationFixture.id, deleted: true }),
    ...overrides,
  });
  const feature = migrationRegistry.find((item) => item.featureId === "gateway.models");
  if (!feature) throw new Error("missing actual model feature");
  const modelFeature = feature;
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <main id="main-content" tabIndex={-1}>
        <FeatureRoute feature={modelFeature}>
          {kind === "contracts" ? <ModelContractsPanel /> : <ModelDeprecationsPanel />}
        </FeatureRoute>
      </main>
    );
  }
  const rendered = renderScreen(<Host />, { route: "/gateway/models" });
  await screen.findByRole("table", {
    name: kind === "contracts" ? "작업 유형별 모델 계약" : "모델 지원 종료 정책",
  });
  return {
    api,
    ...rendered,
    user: userEvent.setup(),
    refresh,
    readonly: (value: boolean) => {
      runtime.readonly = value;
      act(refresh);
    },
  };
}
async function edit(view: Awaited<ReturnType<typeof setup>>) {
  await view.user.click(screen.getByRole("button", { name: "수정" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByLabelText(/^이름/u);
  await view.user.clear(input);
  await view.user.type(input, "고정된 변경 이름");
  return { dialog, input };
}
async function submit(formHost: HTMLElement) {
  const form = formHost.querySelector("form");
  if (!form) throw new Error("missing real form");
  await act(async () => {
    fireEvent.submit(form);
  });
}

describe("모델 관리 확정목록·readonly 초안", () => {
  it.each(["edit", "delete", "deprecation", "deprecationDelete"])(
    "%s는 초안/대상을 보존하고 복구 뒤 수동 전송만 허용한다",
    async (mode) => {
      const view = await setup(mode.startsWith("deprecation") ? "deprecations" : "contracts");
      if (mode === "edit") await edit(view);
      else
        await view.user.click(
          screen.getByRole("button", { name: mode === "deprecation" ? "정책 추가" : "삭제" }),
        );
      const dialog = await screen.findByRole("dialog");
      if (mode === "deprecation") await view.user.type(within(dialog).getByLabelText(/^모델 패턴/u), "OLD-*");
      const input = within(dialog).queryByLabelText(mode === "edit" ? /^이름/u : /^모델 패턴/u);
      const description = dialog.getAttribute("aria-describedby");
      const descriptionText = description ? document.getElementById(description)?.textContent : undefined;
      dialog.dataset.original = "same-instance";
      view.readonly(true);
      expect(dialog).toHaveAttribute("data-original", "same-instance");
      expect(dialog).toHaveTextContent(featureReadonlyReason);
      if (input) {
        expect(input).toBeDisabled();
        expect(input).toHaveValue(mode === "edit" ? "고정된 변경 이름" : "OLD-*");
        await submit(dialog);
      } else {
        expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
        if (description)
          expect(document.getElementById(description)).toHaveTextContent(descriptionText ?? "");
      }
      expect(view.api.calls.filter((call) => !call.key.startsWith("GET "))).toEqual([]);
      expect(within(dialog).getByRole("button", { name: "취소" })).toBeEnabled();
      if (mode === "edit") {
        const save = within(dialog).getByRole("button", { name: "변경 내용 검토" });
        expect(save).toHaveAccessibleDescription("읽기 전용 · 저장 잠김");
        expect(dialog.querySelector(".dialog-footer [role=status]")).toHaveTextContent(
          "읽기 전용 · 저장 잠김",
        );
      }
      view.readonly(false);
      expect(view.api.calls.filter((call) => !call.key.startsWith("GET "))).toEqual([]);
      if (mode === "edit") {
        await view.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
        await view.user.click(await within(dialog).findByRole("button", { name: "검토한 계약 저장" }));
      } else
        await view.user.click(
          within(dialog).getByRole("button", { name: mode === "deprecation" ? "저장" : "삭제" }),
        );
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(view.api.calls.filter((call) => !call.key.startsWith("GET "))).toHaveLength(1);
    },
  );

  it("재조회는 고정 ID와 baseline을 바꾸지 않고 저장뒤 같은 행 수정버튼으로 돌아간다", async () => {
    let current = { ...contractFixture };
    const view = await setup("contracts", {
      "GET /admin/models/contracts": () => ({ contracts: [current] }),
    });
    const { dialog } = await edit(view);
    current = { ...contractFixture, name: "재조회된 다른 이름", min_quality_score: 91 };
    await view.user.click(within(dialog).getByRole("button", { name: "계약 목록 다시 조회" }));
    await waitFor(() =>
      expect(view.client.getQueryData(modelGovernanceKeys.contracts)).toEqual({ contracts: [current] }),
    );
    await view.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    const table = await within(dialog).findByRole("table", { name: "모델 계약 변경 전후 비교" });
    expect(table).toHaveTextContent("기존 계약");
    expect(table).not.toHaveTextContent("재조회된 다른 이름");
    await view.user.click(within(dialog).getByRole("button", { name: "검토한 계약 저장" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(view.api.bodies("POST /admin/models/contracts")[0]).toMatchObject({
      id: contractFixture.id,
      name: "고정된 변경 이름",
      min_quality_score: 70,
      max_avg_cost_krw: 0.0000003,
    });
    expect(screen.getByRole("button", { name: "수정" })).toHaveFocus();
  });

  it("조회 실패/invalidated가 입력을 잃게하지 않으며 readonly 재조회복구뒤 수동 저장한다", async () => {
    let fails = false;
    const view = await setup("contracts", {
      "GET /admin/models/contracts": () => {
        if (fails) throw apiFailure("synthetic", 503, "req_model_list");
        return { contracts: [contractFixture] };
      },
    });
    const { dialog, input } = await edit(view);
    await act(async () => {
      await view.client.invalidateQueries({ queryKey: modelGovernanceKeys.contracts, refetchType: "none" });
    });
    expect(within(dialog).getByRole("button", { name: "변경 내용 검토" })).toBeDisabled();
    await submit(dialog);
    expect(view.api.bodies("POST /admin/models/contracts")).toEqual([]);
    fails = true;
    await view.user.click(within(dialog).getByRole("button", { name: "계약 목록 다시 조회" }));
    await waitFor(() => expect(dialog).toHaveTextContent("req_model_list"));
    expect(input).toHaveValue("고정된 변경 이름");
    view.readonly(true);
    fails = false;
    await view.user.click(within(dialog).getByRole("button", { name: "다시 시도" }));
    await waitFor(() => expect(dialog).not.toHaveTextContent("req_model_list"));
    expect(within(dialog).getByRole("button", { name: "변경 내용 검토" })).toBeDisabled();
    view.readonly(false);
    await view.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    await view.user.click(within(dialog).getByRole("button", { name: "검토한 계약 저장" }));
    await waitFor(() => expect(view.api.bodies("POST /admin/models/contracts")).toHaveLength(1));
  });

  it("readonly에서도 순수검증과 한글지표단위를 유지하고 FEFF 모델을 바꾸지 않는다", async () => {
    runtime.readonly = true;
    const view = await setup();
    await view.user.type(screen.getByLabelText("검증할 모델"), "\u0085\uFEFFpublic-model\u0085");
    await view.user.click(screen.getByRole("button", { name: "계약 검증 실행" }));
    await screen.findByText("검증 결과");
    expect(view.api.bodies("POST /admin/models/contracts/run")).toEqual([{ model: "\uFEFFpublic-model" }]);
    expect(screen.getByText(/품질 점수: 주의/u)).toHaveTextContent("72점");
    expect(screen.getByText(/평균 지연: 충족/u)).toHaveTextContent("100ms");
    expect(screen.getByText(/평균 비용: 충족/u)).toHaveTextContent("3e-7원");
    expect(screen.getByRole("button", { name: "계약 추가" })).toBeDisabled();
  });
  it("쓰기 scope가 없으면 readonly 복구가 순수검증 권한도 새로주지 않는다", async () => {
    runtime.write = false;
    runtime.readonly = true;
    const view = await setup();
    await view.user.type(screen.getByLabelText("검증할 모델"), "public-model");
    view.readonly(false);
    expect(screen.getByRole("button", { name: "계약 검증 실행" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "계약 추가" })).toBeDisabled();
    expect(view.api.calls.filter((call) => !call.key.startsWith("GET "))).toEqual([]);
  });
});
