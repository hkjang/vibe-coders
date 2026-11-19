import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RequestIOPage } from "./RequestIOPage";
import { requestIODetailSchema } from "@/shared/api/domains/observability.schemas";
import { comparisonRequest, comparisonResponse } from "../requests/request-comparison-fixtures";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
const runtime = vi.hoisted(() => ({
  path: "/admin#/requests",
  fallback: true,
  detail: true,
  extended: true,
  wide: true,
  status: 200,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth();
      return {
        ...auth,
        capabilities: {
          raw_prompt_view: false,
          legacy_request_detail: runtime.detail,
          legacy_request_direct_detail: runtime.extended,
        },
        features: auth.features.map((f) =>
          f.featureId === "observability.io"
            ? { ...f, legacyPath: runtime.path, fallbackEnabled: runtime.fallback }
            : f,
        ),
      };
    },
  };
});
beforeEach(() => {
  Object.assign(runtime, {
    path: "/admin#/requests",
    fallback: true,
    detail: true,
    extended: true,
    wide: true,
    status: 200,
  });
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: runtime.wide, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});
afterEach(() => vi.unstubAllGlobals());
function setup(search: string, id = "outside-list", filterable = true) {
  const row = { ...comparisonRequest("listed-other"), request_filterable: filterable };
  const api = mockApi({
    "GET /admin/requests": () => comparisonResponse(row),
    "GET /admin/requests/io": () => ({ previews: [], capture: {} }),
    ["GET /admin/requests/" + encodeURIComponent(id) + "/io"]: () => {
      if (runtime.status !== 200) throw apiFailure("request unavailable", runtime.status);
      return requestIODetailSchema.parse({
        request_id: "PROJECTED_DIFFERENT_ID",
        input: { state: "captured", messages: [{ role: "user", text: "MASKED_SELECTED_REQUEST" }] },
        output: {},
        capture: {},
      });
    },
  });
  renderScreen(
    <FeatureAccessHarness featureId="observability.io">
      <RequestIOPage />
    </FeatureAccessHarness>,
    {
      path: "/observability/io",
      route: "/observability/io?live=off&" + search,
    },
  );
  return api;
}
it.each([true, false])(
  "hands off the exact off-list request in desktop/mobile despite a projected response ID: wide=%s",
  async (wide) => {
    runtime.wide = wide;
    const id = " original 한글 +%2F?&# ";
    const api = setup(new URLSearchParams({ request_id: id }).toString(), id);
    await screen.findByText("MASKED_SELECTED_REQUEST");
    const panel = wide
      ? screen.getByRole("region", { name: "선택한 요청의 입력과 출력" })
      : screen.getByRole("dialog", { name: "요청 입력과 출력" });
    expect(within(panel).getByRole("link", { name: "기존 화면에서 같은 요청 열기" })).toHaveAttribute(
      "href",
      "/admin#/requests?" + new URLSearchParams({ request_id: id }),
    );
    expect(api.calls.every((c) => c.key.startsWith("GET "))).toBe(true);
    expect(
      api.calls.some(
        (c) =>
          c.key.includes("PROJECTED_DIFFERENT_ID") ||
          (c.options.query as { reveal?: string } | undefined)?.reveal === "raw",
      ),
    ).toBe(false);
  },
);
it.each([
  "request_id=",
  "request_id=a&request_id=b",
  "request_id=%ED%A0%80",
  "request_id=vc_sk_abcdefghijk",
  "request_id=diff",
])("does not retarget invalid explicit selection: %s", async (search) => {
  const api = setup(search);
  await screen.findByText("요청 주소를 확인하세요.");
  await waitFor(() => expect(api.calls.some((c) => c.key === "GET /admin/requests")).toBe(true));
  expect(api.calls.some((c) => /^GET \/admin\/requests\/.+\/io$/u.test(c.key))).toBe(false);
  expect(screen.queryByRole("link", { name: "기존 화면에서 같은 요청 열기" })).toBeNull();
});
it("does not promote an unfilterable displayed row into a path lookup", async () => {
  const api = setup("", "outside-list", false);
  await screen.findByText("요청을 선택하세요.");
  await waitFor(() => expect(api.calls.some((c) => c.key === "GET /admin/requests")).toBe(true));
  expect(api.calls.some((c) => /^GET \/admin\/requests\/.+\/io$/u.test(c.key))).toBe(false);
});
it("uses the IO runtime destination rather than the request explorer's compiled route", async () => {
  runtime.path = "/admin#/runtime-io?custom=1";
  setup("request_id=outside-list");
  await screen.findByText("MASKED_SELECTED_REQUEST");
  expect(screen.getByRole("link", { name: "기존 화면에서 요청 열기" })).toHaveAttribute("href", runtime.path);
  expect(screen.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute("href", runtime.path);
});
it.each([403, 404])("retains the original target in an error fallback: status=%i", async (status) => {
  runtime.status = status;
  setup("request_id=outside-list");
  await screen.findByText("입력과 출력을 불러오지 못했습니다.", { selector: "strong" });
  expect(screen.getByRole("link", { name: "기존 화면에서 같은 요청 열기" })).toHaveAttribute(
    "href",
    "/admin#/requests?request_id=outside-list",
  );
});
it("honors disabled destination fallback", async () => {
  runtime.fallback = false;
  setup("request_id=outside-list");
  await screen.findByText("MASKED_SELECTED_REQUEST");
  expect(screen.queryByRole("link", { name: /기존 화면에서/u })).toBeNull();
});
