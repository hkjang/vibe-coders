import { useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { FeatureAccessHarness } from "@/test/feature-access";
import { testAuth } from "@/test/auth";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";
import { text2sqlSchemaDetailSchema } from "@/shared/api/domains/text2sql-schema-detail";
import { SchemaDetailPage } from "./SchemaDetailPage";
import { SchemaDetailLink } from "./SchemaDetailLink";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
const row = {
  name: "정산/서울?%#",
  team: "운영 팀",
  dialect: "postgres",
  schema_text: "승인된 정산 설명",
  allowed_tables: ["정산_내역"],
  enabled: false,
  is_default: true,
  version: 3,
  collected_at: "",
  updated_at: "2026-11-01T00:00:00Z",
  source_fingerprint: "source-v3",
};
const response = { schema: row, raw_content_available: true };
const route = "/text2sql/schemas/detail?schema_name=" + encodeURIComponent(row.name);
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.107", scopes: ["admin:read"] });
});
function setup(handler: ApiHandler = () => response, target = route) {
  const api = mockApi({ "GET /admin/text2sql": handler });
  let refresh = () => {};
  function Host() {
    const [, update] = useState(0);
    refresh = () => update((value) => value + 1);
    return (
      <FeatureAccessHarness featureId="text2sql.overview" readOnly>
        <SchemaDetailPage />
      </FeatureAccessHarness>
    );
  }
  return { ...renderScreen(<Host />, { route: target }), api, refresh: () => act(refresh) };
}
it("선택한 스키마만 조회하고 중지·기본 상태와 접힌 설명을 제공한다", async () => {
  const view = setup();
  expect(await screen.findByRole("heading", { name: row.name })).toBeVisible();
  expect(screen.getByText("중지됨")).toBeVisible();
  expect(screen.getByText("기본 스키마")).toBeVisible();
  expect(screen.queryByText(row.schema_text)).not.toBeInTheDocument();
  const toggle = screen.getByRole("button", { name: "설명 보기" });
  toggle.focus();
  await userEvent.keyboard("{Enter}");
  expect(screen.getByText(row.schema_text)).toBeVisible();
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  expect(view.api.calls.map((call) => call.options.query)).toEqual([{ view: "schema", name: row.name }]);
  expect(view.api.calls.every((call) => call.key === "GET /admin/text2sql")).toBe(true);
  expect(screen.queryByRole("button", { name: /저장|삭제|적용|실행/ })).not.toBeInTheDocument();
});
it("설명 원문 권한이 없는 응답에서 설명과 테이블을 표시하지 않는다", async () => {
  setup(() => ({
    schema: { ...row, schema_text: "[sensitive-content-omitted]", allowed_tables: [] },
    raw_content_available: false,
  }));
  expect(await screen.findByText("스키마 설명과 허용 테이블은 비공개입니다.")).toBeVisible();
  expect(screen.queryByRole("button", { name: "설명 보기" })).not.toBeInTheDocument();
  expect(screen.queryByText("별도 제한 없음")).not.toBeInTheDocument();
});
it("다른 스키마 응답을 선택한 상세로 표시하지 않는다", async () => {
  setup(() => ({ ...response, schema: { ...row, name: "다른 스키마" } }));
  expect(await screen.findByText("스키마 상세를 불러오지 못했습니다.")).toBeVisible();
  expect(screen.queryByText("다른 스키마")).not.toBeInTheDocument();
});
it.each(["", "?schema_name=", "?schema_name=a&schema_name=b", "?schema_name=%20a", "?schema_name=a%00b"])(
  "잘못된 상세 주소 %s는 요청하지 않는다",
  async (query) => {
    const view = setup(undefined, "/text2sql/schemas/detail" + query);
    expect(await screen.findByText("스키마 상세 주소를 확인하세요.")).toBeVisible();
    expect(view.api.calls).toEqual([]);
  },
);
it("구버전 서버에서는 상세 조회를 보내지 않는다", async () => {
  state.auth = { ...state.auth, backendVersion: "v0.86.106" };
  const view = setup();
  expect(await screen.findByText("서버 업데이트가 필요합니다.")).toBeVisible();
  expect(view.api.calls).toEqual([]);
});
it("쓰기 권한만으로 상세나 기존 화면 링크를 제공하지 않는다", async () => {
  state.auth = testAuth({ scopes: ["admin:write"] });
  const view = setup();
  expect(await screen.findByText("스키마 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
  expect(view.api.calls).toEqual([]);
});
it("목록 링크는 특수문자 이름을 한 번만 인코딩한다", () => {
  renderScreen(<SchemaDetailLink name={row.name} />);
  const link = screen.getByRole("link", { name: row.name });
  const url = new URL(link.getAttribute("href") ?? "", "https://console.invalid");
  expect(url.pathname).toBe("/text2sql/schemas/detail");
  expect(url.searchParams.get("schema_name")).toBe(row.name);
});
it("조회 오류는 이전 정보를 숨기고 요청 ID와 수동 재시도를 제공한다", async () => {
  let fail = false;
  const view = setup(() => {
    if (fail) throw apiFailure("private failure", 500, "req_schema");
    return response;
  });
  await screen.findByRole("heading", { name: row.name });
  fail = true;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(await screen.findByText("스키마 상세를 불러오지 못했습니다.")).toBeVisible();
  expect(screen.queryByText(row.team)).not.toBeInTheDocument();
  expect(screen.queryByText("private failure")).not.toBeInTheDocument();
  expect(screen.getByText("요청 ID: req_schema")).toBeVisible();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByText(row.team)).toBeVisible();
  expect(view.api.calls).toHaveLength(3);
});
it("권한 거부 뒤 캐시를 폐기하고 명시적 재확인으로 새로 조회한다", async () => {
  let denied = false;
  const view = setup(() => {
    if (denied) throw apiFailure("denied", 403);
    return response;
  });
  await screen.findByText(row.team);
  denied = true;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  expect(await screen.findByText("스키마 조회 권한을 확인하세요.")).toBeVisible();
  expect(screen.queryByText(row.team)).not.toBeInTheDocument();
  await waitFor(() => expect(view.client.getQueryCache().getAll()).toHaveLength(0));
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "권한 다시 확인" }));
  expect(await screen.findByText(row.team)).toBeVisible();
});
it("팀 변경 후 늦게 도착한 이전 설명을 보관하지 않는다", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const view = setup(() =>
    ++calls === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.reject(apiFailure("missing", 404)),
  );
  await waitFor(() => expect(calls).toBe(1));
  if (!state.auth.user) throw new Error("fixture identity required");
  state.auth = { ...state.auth, user: { ...state.auth.user, team_id: "other" } };
  view.refresh();
  expect(await screen.findByText("해당 스키마를 찾을 수 없습니다.")).toBeVisible();
  await act(async () => finish(response));
  expect(screen.queryByText(row.team)).not.toBeInTheDocument();
  expect(
    view.client
      .getQueryCache()
      .getAll()
      .some((query) => query.state.data === response),
  ).toBe(false);
});
it("조회 후 인증 접두사가 바뀌면 새 규칙으로 내용을 가린다", async () => {
  const credential = "corp_" + "x".repeat(43);
  const view = setup(() => ({
    ...response,
    schema: {
      ...row,
      team: credential,
      source_fingerprint: credential,
      schema_text: credential,
      allowed_tables: [credential],
    },
  }));
  await screen.findByRole("heading", { name: row.name });
  state.auth = { ...state.auth, credentialPrefixes: ["corp_"] };
  view.refresh();
  await waitFor(() => expect(view.api.calls).toHaveLength(2));
  await userEvent.click(await screen.findByRole("button", { name: "설명 보기" }));
  expect(screen.queryByText(credential)).not.toBeInTheDocument();
  expect(screen.getAllByText("비공개 정보").length).toBeGreaterThan(0);
});
it("긴 설명은 접어서 시작하고 테이블은 50개씩 탐색한다", async () => {
  setup(() => ({
    ...response,
    schema: {
      ...row,
      schema_text: "가".repeat(20001),
      allowed_tables: Array.from({ length: 51 }, (_, index) => `테이블_${index}`),
    },
  }));
  const list = await screen.findByRole("list", { name: "허용 테이블" });
  expect(within(list).getAllByRole("listitem")).toHaveLength(50);
  await userEvent.click(screen.getByRole("button", { name: "다음 테이블" }));
  expect(within(list).getAllByRole("listitem")).toHaveLength(1);
  expect(screen.getByText("테이블_50")).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "설명 보기" }));
  expect(screen.queryByLabelText("스키마 설명 본문")).not.toBeInTheDocument();
  expect(screen.getByText(/설명이 길어/)).toBeVisible();
});
it("계약은 숨김 표시와 원문·테이블의 불일치를 거부한다", () => {
  expect(text2sqlSchemaDetailSchema.safeParse(response).success).toBe(true);
  expect(text2sqlSchemaDetailSchema.safeParse({ ...response, raw_content_available: false }).success).toBe(
    false,
  );
  expect(text2sqlSchemaDetailSchema.safeParse({ ...response, schemas: [row] }).success).toBe(false);
});

it("선택한 스키마를 지원하는 기존 화면에 정확히 연결한다", async () => {
  state.auth = {
    ...state.auth,
    capabilities: { raw_prompt_view: false, legacy_text2sql_schema_detail: true },
  };
  setup();
  await screen.findByRole("heading", { name: row.name });
  expect(screen.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/text2sql?" + new URLSearchParams({ schema_name: row.name }),
  );
});
it("구버전과 사용자 지정 목적지는 임의의 상세 쿼리를 붙이지 않는다", async () => {
  const view = setup();
  await screen.findByRole("heading", { name: row.name });
  expect(screen.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/text2sql",
  );
  state.auth = {
    ...state.auth,
    capabilities: { raw_prompt_view: false, legacy_text2sql_schema_detail: true },
    features: state.auth.features.map((feature) =>
      feature.featureId === "text2sql.overview"
        ? { ...feature, legacyPath: "/admin#/custom?public=ok" }
        : feature,
    ),
  };
  view.refresh();
  expect(screen.getByRole("link", { name: "기존 화면에서 열기" })).toHaveAttribute(
    "href",
    "/admin#/custom?public=ok",
  );
});
it("조회 권한이 폐기되면 상세 링크도 즉시 숨긴다", async () => {
  state.auth = {
    ...state.auth,
    capabilities: { raw_prompt_view: false, legacy_text2sql_schema_detail: true },
  };
  let denied = false;
  setup(() => {
    if (denied) throw apiFailure("denied", 403);
    return response;
  });
  await screen.findByRole("heading", { name: row.name });
  denied = true;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await screen.findByText("스키마 조회 권한을 확인하세요.");
  expect(screen.queryByRole("link", { name: "기존 화면에서 열기" })).not.toBeInTheDocument();
});
