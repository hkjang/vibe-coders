import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderPage } from "./ProviderPage";
import { providerImpactAcknowledgement } from "./ProviderImpactPanel";
import { providerImpactFixture } from "./provider-impact-test-fixtures";
import { FeatureRoute } from "@/app/guards/FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { usePreferences } from "@/shared/stores/preferences";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false, write: true }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ scopes: ["admin:read", ...(runtime.write ? ["admin:write"] : [])] });
      return {
        ...auth,
        features: auth.features.map((feature) => ({ ...feature, readOnly: runtime.readOnly })),
      };
    },
  };
});
const provider = {
  name: "public-provider",
  provider_ref: `prv_${"a".repeat(43)}`,
  base_url: "https://provider.example.invalid/v1",
  api_key_configured: true,
  enabled: true,
  timeout_ms: 30000,
  model_patterns: "public-*",
  failover_group: "",
  priority: 10,
  created_at: "2026-09-01T00:00:00Z",
};
async function setup(overrides: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/providers": () => ({ providers: [provider] }),
    "GET /admin/providers/slo": () => ({ slos: [], evaluations: [], since: "2026-09-01T00:00:00Z" }),
    "GET /admin/provider-impact": () => providerImpactFixture(provider.provider_ref),
    "POST /admin/providers": () => ({ provider }),
    "POST /admin/providers/slo": () => ({ slo: { provider: provider.name } }),
    "DELETE /admin/providers/public-provider": () => ({ deleted: provider.name }),
    ...overrides,
  });
  const selected = migrationRegistry.find((feature) => feature.featureId === "gateway.providers");
  if (!selected) throw new Error("missing provider feature");
  const feature = selected;
  let refresh: () => void = () => undefined;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureRoute feature={feature}>
        <ProviderPage />
      </FeatureRoute>
    );
  }
  renderScreen(<Host />, { route: "/gateway/providers" });
  const link = await screen.findByRole("link", { name: provider.name });
  const row = link.closest("tr");
  if (!row) throw new Error("missing provider row");
  return {
    api,
    row,
    user: userEvent.setup(),
    readonly: (value: boolean) => {
      runtime.readOnly = value;
      act(refresh);
    },
  };
}
beforeEach(() => {
  runtime.readOnly = false;
  runtime.write = true;
  usePreferences.setState({ refreshInterval: 0 });
});
describe("공급자 runtime readonly", () => {
  it("admin:write가 있어도 실제 FeatureRoute readonly는 추가·변경·삭제·SLO를 막는다", async () => {
    runtime.readOnly = true;
    const current = await setup();
    expect(screen.getByRole("button", { name: "공급자 추가" })).toBeDisabled();
    for (const name of ["수정", "중지", "삭제", "서비스 목표"])
      expect(within(current.row).getByRole("button", { name })).toBeDisabled();
    await waitFor(() => expect(screen.getByRole("button", { name: /^새로고침$/u })).toBeEnabled());
  });
  it.each(["추가", "수정", "서비스 목표", "삭제"])(
    "열린 %s 입력은 전환 시 보존·잠금되고 복구 후 수동으로만 전송한다",
    async (mode) => {
      const current = await setup();
      await current.user.click(
        mode === "추가"
          ? screen.getByRole("button", { name: "공급자 추가" })
          : within(current.row).getByRole("button", { name: mode }),
      );
      const dialog = await screen.findByRole("dialog");
      let input: HTMLElement;
      let value: string;
      if (mode === "추가") {
        await current.user.type(within(dialog).getByLabelText(/^이름/u), "new-provider");
        input = within(dialog).getByLabelText(/^기본 URL/u);
        value = "https://new.example.invalid/v1";
      } else if (mode === "수정") {
        input = within(dialog).getByLabelText(/^기본 URL/u);
        value = "https://changed.example.invalid/v1";
      } else if (mode === "서비스 목표") {
        input = within(dialog).getByLabelText("메모");
        value = "고정 서비스 목표 초안";
      } else {
        input = within(dialog).getByLabelText("삭제 대상 재입력");
        value = provider.name;
      }
      await current.user.clear(input);
      await current.user.type(input, value);
      const form = input.closest("form");
      if (!form) throw new Error("missing form");
      const mutations = () => current.api.calls.filter((call) => !call.key.startsWith("GET "));
      current.readonly(true);
      expect(input).toHaveValue(value);
      expect(input).toBeDisabled();
      expect(within(dialog).getByRole("button", { name: "취소" })).toBeEnabled();
      await act(async () => {
        fireEvent.submit(form);
      });
      expect(mutations()).toHaveLength(0);
      current.readonly(false);
      expect(input).toHaveValue(value);
      expect(input).toBeEnabled();
      expect(mutations()).toHaveLength(0);
      if (mode === "수정")
        await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
      if (mode === "수정" || mode === "삭제") {
        const acknowledgement = await screen.findByRole("checkbox", {
          name: new RegExp(providerImpactAcknowledgement),
        });
        await waitFor(() => expect(acknowledgement).toBeEnabled());
        await current.user.click(acknowledgement);
      }
      await current.user.click(
        within(dialog).getByRole("button", {
          name: mode === "수정" ? "검토한 내용 저장" : mode === "삭제" ? "삭제" : "저장",
        }),
      );
      await waitFor(() => expect(mutations()).toHaveLength(1));
      if (mode === "서비스 목표")
        expect(current.api.bodies("POST /admin/providers/slo")[0]).toMatchObject({
          provider: provider.name,
          note: value,
        });
      if (mode === "수정")
        expect(current.api.bodies("POST /admin/providers")[0]).toMatchObject({
          name: provider.name,
          base_url: value,
        });
    },
  );

  it("읽기 전용 검토는 영향 재조회를 허용하며 새 응답의 동의를 복구 후 다시 받아야 한다", async () => {
    const current = await setup();
    await current.user.click(within(current.row).getByRole("button", { name: "수정" }));
    const dialog = await screen.findByRole("dialog");
    await current.user.clear(within(dialog).getByLabelText("우선순위"));
    await current.user.type(within(dialog).getByLabelText("우선순위"), "27");
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    const acknowledgement = await screen.findByRole("checkbox", {
      name: new RegExp(providerImpactAcknowledgement),
    });
    await waitFor(() => expect(acknowledgement).toBeEnabled());
    await current.user.click(acknowledgement);
    current.readonly(true);
    expect(acknowledgement).toBeChecked();
    expect(acknowledgement).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "다시 편집" })).toBeDisabled();
    expect(within(dialog).getByRole("table", { name: "공급자 변경 전후 비교" })).toHaveTextContent("27");
    const before = current.api.calls.filter((call) => call.key === "GET /admin/provider-impact").length;
    await current.user.click(within(dialog).getByRole("button", { name: "참조 영향 다시 조회" }));
    await waitFor(() =>
      expect(current.api.calls.filter((call) => call.key === "GET /admin/provider-impact")).toHaveLength(
        before + 1,
      ),
    );
    expect(acknowledgement).not.toBeChecked();
    expect(acknowledgement).toBeDisabled();
    current.readonly(false);
    await waitFor(() => expect(acknowledgement).toBeEnabled());
    expect(within(dialog).getByRole("button", { name: "검토한 내용 저장" })).toBeDisabled();
    expect(current.api.bodies("POST /admin/providers")).toHaveLength(0);
    await current.user.click(acknowledgement);
    await current.user.click(within(dialog).getByRole("button", { name: "검토한 내용 저장" }));
    await waitFor(() => expect(current.api.bodies("POST /admin/providers")).toHaveLength(1));
    expect(current.api.bodies("POST /admin/providers")[0]).toMatchObject({
      name: provider.name,
      priority: 27,
    });
  });

  it("실패한 서비스 목표의 요청 ID와 입력을 보존하고 복구 뒤 수동 재시도한다", async () => {
    let attempts = 0;
    const current = await setup({
      "POST /admin/providers/slo": () => {
        attempts += 1;
        if (attempts === 1) throw apiFailure("synthetic failure", 503, "req_slo_readonly");
        return { slo: { provider: provider.name } };
      },
    });
    await current.user.click(within(current.row).getByRole("button", { name: "서비스 목표" }));
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByLabelText("메모");
    await current.user.type(input, "재시도할 초안");
    await current.user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(dialog).toHaveTextContent("req_slo_readonly"));
    current.readonly(true);
    expect(input).toHaveValue("재시도할 초안");
    expect(dialog).toHaveTextContent("req_slo_readonly");
    const form = input.closest("form");
    if (!form) throw new Error("missing form");
    await act(async () => {
      fireEvent.submit(form);
    });
    expect(attempts).toBe(1);
    current.readonly(false);
    expect(attempts).toBe(1);
    await current.user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(current.api.bodies("POST /admin/providers/slo")[1]).toEqual(
      current.api.bodies("POST /admin/providers/slo")[0],
    );
  });
});
