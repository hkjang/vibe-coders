import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RequestIOPage } from "./RequestIOPage";
import { comparisonRequest, comparisonResponse } from "../requests/request-comparison-fixtures";
import { requestIODetailSchema } from "@/shared/api/domains/observability.schemas";
import { mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
afterEach(() => vi.unstubAllGlobals());

it("기본 조회에서 모델 목록을 제외하고 옵션 변경 시 보류된 목록·상세를 정리한다", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  const catalog = { ...comparisonRequest("catalog"), model: "모델 목록 조회 표본", endpoint: "/v1/models" };
  let hold = false;
  let release: (() => void) | undefined;
  const api = mockApi({
    "GET /admin/requests": async ({ query }) => {
      if ((query as { exclude_models: boolean }).exclude_models) {
        if (hold)
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return comparisonResponse();
      }
      return comparisonResponse(catalog);
    },
    "GET /admin/requests/io": () => ({ previews: [], capture: {} }),
    "GET /admin/requests/catalog/io": () =>
      requestIODetailSchema.parse({
        request_id: "catalog",
        input: { state: "captured", messages: [{ role: "user", text: "카탈로그 상세 표본" }] },
        output: {},
        capture: {},
      }),
  });
  const { container } = renderScreen(
    <FeatureAccessHarness featureId="observability.io">
      <RequestIOPage />
    </FeatureAccessHarness>,
    { path: "/observability/io", route: "/observability/io?live=off" },
  );
  await screen.findByText("표시할 요청이 없습니다.");
  expect(api.calls.find((call) => call.key === "GET /admin/requests")?.options.query).toMatchObject({
    exclude_models: true,
  });
  const user = userEvent.setup();
  await user.click(screen.getByRole("switch", { name: "모델 목록 조회 포함" }));
  await screen.findByText("모델 목록 조회 표본");
  await screen.findByText("카탈로그 상세 표본");
  expect(screen.getByRole("switch", { name: "모델 목록 조회 포함" })).toHaveFocus();
  const list = container.querySelector(".io-list-pane");
  if (!list) throw new Error("목록 영역 없음");
  Object.defineProperty(list, "scrollTop", { value: 100 });
  fireEvent.scroll(list);
  hold = true;
  await user.click(screen.getByRole("switch", { name: "모델 목록 조회 포함" }));
  await waitFor(() => expect(release).toBeTypeOf("function"));
  expect(screen.queryByText("모델 목록 조회 표본")).toBeNull();
  expect(screen.queryByText("카탈로그 상세 표본")).toBeNull();
  expect(screen.getByRole("switch", { name: "모델 목록 조회 포함" })).toHaveAttribute(
    "aria-checked",
    "false",
  );
  expect(screen.getByRole("switch", { name: "모델 목록 조회 포함" })).toHaveFocus();
  await act(async () => release?.());
  await screen.findByText("표시할 요청이 없습니다.");
  expect(api.calls.every((call) => call.key.startsWith("GET "))).toBe(true);
});

it("공유 주소의 명시적인 포함 옵션을 복원한다", async () => {
  const api = mockApi({
    "GET /admin/requests": () => comparisonResponse(),
    "GET /admin/requests/io": () => ({ previews: [], capture: {} }),
  });
  renderScreen(
    <FeatureAccessHarness featureId="observability.io">
      <RequestIOPage />
    </FeatureAccessHarness>,
    { path: "/observability/io", route: "/observability/io?live=off&include_models=true" },
  );
  await screen.findByText("표시할 요청이 없습니다.");
  expect(screen.getByRole("switch", { name: "모델 목록 조회 포함" })).toHaveAttribute("aria-checked", "true");
  expect(api.calls.find((call) => call.key === "GET /admin/requests")?.options.query).toMatchObject({
    exclude_models: false,
  });
});
