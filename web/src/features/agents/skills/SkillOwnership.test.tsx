import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { SkillPage } from "./SkillPage";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import type * as Csv from "@/shared/utils/csv";

const runtime = vi.hoisted(() => ({ id: "one", team: "team-one", scopes: ["admin:read", "admin:write"] }));
const notifications = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), download: vi.fn() }));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/shared/utils/csv", async (load) => ({
  ...(await load<typeof Csv>()),
  downloadText: notifications.download,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
  };
});
const first = { name: "first-skill", description: "첫 계정 지침", instructions: "비공개 지침" };
function Host() {
  const [, refresh] = useState(0);
  const [visible, setVisible] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  return (
    <FeatureAccessContext.Provider
      value={{ featureId: "agents.skills", permitted: true, readOnly, status: "preview" }}
    >
      <button
        onClick={() => {
          runtime.id = "two";
          refresh((n) => n + 1);
        }}
      >
        계정 변경
      </button>
      <button
        onClick={() => {
          runtime.team = "team-two";
          refresh((n) => n + 1);
        }}
      >
        팀 변경
      </button>
      <button
        onClick={() => {
          runtime.scopes = [];
          refresh((n) => n + 1);
        }}
      >
        조회 권한 회수
      </button>
      <button
        onClick={() => {
          runtime.scopes = ["admin:read"];
          refresh((n) => n + 1);
        }}
      >
        쓰기 권한 회수
      </button>
      <button onClick={() => setReadOnly(true)}>읽기 전용 전환</button>
      <button onClick={() => setVisible(false)}>화면 나가기</button>
      {visible ? <SkillPage /> : <p>스킬 화면을 떠났습니다.</p>}
    </FeatureAccessContext.Provider>
  );
}
function heldResponse() {
  let resolve!: (value: unknown) => void;
  const promise = new Promise<unknown>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const setup = (route = "/agents/skills") => renderScreen(<Host />, { path: "/agents/skills", route });
const stats = { "GET /admin/skills/stats": () => ({ stats: [] }) };
beforeEach(() => {
  runtime.id = "one";
  runtime.team = "team-one";
  runtime.scopes = ["admin:read", "admin:write"];
  vi.clearAllMocks();
});

it("계정이 바뀌면 이전 목록을 재사용하지 않고 새로 조회한다", async () => {
  mockApi({
    ...stats,
    "GET /admin/skills": () => ({
      skills: [{ ...first, name: runtime.id === "one" ? first.name : "second-skill" }],
    }),
  });
  const user = userEvent.setup();
  setup();
  await screen.findByRole("button", { name: "first-skill 상세 열기" });
  await user.click(screen.getByRole("button", { name: "계정 변경" }));
  expect(await screen.findByRole("button", { name: "second-skill 상세 열기" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "first-skill 상세 열기" })).not.toBeInTheDocument();
});

it.each(["계정 변경", "팀 변경", "조회 권한 회수", "화면 나가기"])(
  "%s 이후 늦은 목록은 화면과 캐시에 남지 않는다",
  async (action) => {
    const held = heldResponse();
    let calls = 0;
    mockApi({
      ...stats,
      "GET /admin/skills": async () => {
        const initial = ++calls === 1;
        if (initial) return held.promise;
        return { skills: [] };
      },
    });
    const { client } = setup();
    await waitFor(() => expect(calls).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: action }));
    await act(async () => held.resolve({ skills: [first] }));
    expect(screen.queryByRole("button", { name: "first-skill 상세 열기" })).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        client
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain(first.instructions);
  },
);

it.each([401, 403])("명시적 스캔의 %s는 기존 조회를 폐기하고 수동 복구만 허용한다", async (status) => {
  const api = mockApi({
    ...stats,
    "GET /admin/skills": () => ({ skills: [first] }),
    "GET /admin/skills/scan": () => {
      throw apiFailure("denied", status);
    },
  });
  const user = userEvent.setup();
  const { client } = setup();
  await screen.findByRole("button", { name: "first-skill 상세 열기" });
  await user.click(screen.getByRole("button", { name: "보안 스캔" }));
  expect(await screen.findByText("스킬 조회 권한을 다시 확인하세요.")).toBeVisible();
  expect(
    JSON.stringify(
      client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain(first.instructions);
  expect(api.calls.filter((call) => call.key === "GET /admin/skills/scan")).toHaveLength(1);
  await user.click(screen.getByRole("button", { name: "다시 시도" }));
  expect(await screen.findByRole("button", { name: "first-skill 상세 열기" })).toBeVisible();
  expect(api.calls.filter((call) => call.key === "GET /admin/skills/scan")).toHaveLength(1);
});

it.each(["계정 변경", "읽기 전용 전환", "쓰기 권한 회수"])(
  "저장 중 %s 이후 응답을 새 화면과 알림에 반영하지 않는다",
  async (action) => {
    const held = heldResponse();
    const api = mockApi({
      ...stats,
      "GET /admin/skills": () => ({ skills: [first] }),
      "POST /admin/skills": () => held.promise,
    });
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole("button", { name: "스킬 추가" }));
    const dialog = screen.getByRole("dialog", { name: "스킬 추가" });
    await user.type(within(dialog).getByRole("textbox", { name: /이름/ }), "new-skill");
    await user.click(within(dialog).getByRole("button", { name: "스킬 만들기" }));
    await waitFor(() => expect(api.bodies("POST /admin/skills")).toHaveLength(1));
    expect(api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST")?.[1]).toEqual(
      expect.objectContaining({ retryUnauthorized: false }),
    );
    fireEvent.click(screen.getByText(action, { selector: "button" }));
    await act(async () => undefined);
    const reads = api.calls.filter((call) => call.key === "GET /admin/skills").length;
    await act(async () => held.resolve({ skill: { name: "new-skill" } }));
    expect(api.calls.filter((call) => call.key === "GET /admin/skills")).toHaveLength(reads);
    expect(notifications.success).not.toHaveBeenCalled();
    expect(notifications.error).not.toHaveBeenCalled();
    if (action !== "계정 변경") {
      expect(within(dialog).getByRole("textbox", { name: /이름/ })).toHaveValue("new-skill");
      expect(within(dialog).getByRole("button", { name: "스킬 만들기" })).toBeDisabled();
    }
  },
);

it("시뮬레이션 입력이 바뀌면 이전 입력의 늦은 판정을 표시하지 않는다", async () => {
  const held = heldResponse();
  const api = mockApi({
    ...stats,
    "GET /admin/skills": () => ({ skills: [first] }),
    "POST /admin/skills/evaluate": () => held.promise,
  });
  const user = userEvent.setup();
  setup();
  await user.click(await screen.findByRole("button", { name: "first-skill 상세 열기" }));
  await user.click(screen.getByRole("button", { name: "정책 시뮬레이션" }));
  await user.type(screen.getByRole("textbox", { name: "모델" }), "first-model");
  await user.click(screen.getByRole("button", { name: "정책 확인" }));
  await waitFor(() => expect(api.bodies("POST /admin/skills/evaluate")).toHaveLength(1));
  await user.clear(screen.getByRole("textbox", { name: "모델" }));
  await user.type(screen.getByRole("textbox", { name: "모델" }), "next-model");
  await act(async () =>
    held.resolve({ allowed: true, would_block: false, enforcement: "off", violations: [] }),
  );
  expect(screen.queryByText("판정")).not.toBeInTheDocument();
  expect(api.bodies("POST /admin/skills/evaluate")).toMatchObject([{ model: "first-model" }]);
  await user.click(await screen.findByRole("button", { name: "정책 확인" }));
  expect(await screen.findByText("판정")).toBeVisible();
  expect(api.bodies("POST /admin/skills/evaluate")).toMatchObject([
    { model: "first-model" },
    { model: "next-model" },
  ]);
});

it("계정 변경 시 열려 있던 스킬 입력 초안을 폐기한다", async () => {
  mockApi({ ...stats, "GET /admin/skills": () => ({ skills: [first] }) });
  const user = userEvent.setup();
  setup();
  await user.click(await screen.findByRole("button", { name: "스킬 추가" }));
  await screen.findByRole("dialog");
  fireEvent.click(screen.getByText("계정 변경", { selector: "button" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("이전 계정에서 요청한 늦은 번들은 다운로드하거나 알리지 않는다", async () => {
  const held = heldResponse();
  const api = mockApi({
    ...stats,
    "GET /admin/skills": () => ({ skills: [first] }),
    "GET /admin/skills/export": () => held.promise,
  });
  const user = userEvent.setup();
  setup();
  await user.click(await screen.findByRole("button", { name: "내보내기" }));
  await waitFor(() => expect(api.calls.some((c) => c.key === "GET /admin/skills/export")).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "계정 변경" }));
  await act(async () => held.resolve({ version: "1", skills: [first] }));
  expect(notifications.download).not.toHaveBeenCalled();
  expect(notifications.success).not.toHaveBeenCalled();
  expect(notifications.error).not.toHaveBeenCalled();
});

it("임의의 상태 필터와 catalog 스킬의 준비도는 서로 다른 결과를 유지한다", async () => {
  mockApi({
    ...stats,
    "GET /admin/skills": () => ({ skills: [{ ...first, name: "catalog", status: "readiness" }] }),
    "GET /admin/skill-studio/candidates": () => ({ candidates: [] }),
    "GET /admin/skill-studio/readiness": () => ({ name: "catalog", production_ready: true, checks: [] }),
  });
  setup("/agents/skills?status=readiness&skill=catalog&tab=studio");
  expect(await screen.findByText("준비 완료", { exact: true })).toBeVisible();
  expect(screen.getByRole("combobox", { name: "스킬 선택" })).toHaveValue("catalog");
});
