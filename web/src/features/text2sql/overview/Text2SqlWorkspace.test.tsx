import { focusManager } from "@tanstack/react-query";
import { useState } from "react";
import * as downloads from "@/shared/utils/csv";
import { toast } from "sonner";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { usePreferences } from "@/shared/stores/preferences";
import { Text2SqlPage } from "./Text2SqlPage";
import { workspaceOverview as overview } from "./text2sql-workspace-fixture";
const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
beforeEach(() => {
  state.auth = testAuth({ user: { team_id: "alpha" } });
  usePreferences.setState({ refreshInterval: 0 });
});
function setup(tab = "overview", overrides: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/text2sql": () => overview,
    "GET /admin/text2sql/features": () => ({ features: [] }),
    "GET /admin/text2sql/glossary": () => ({ terms: [], conflicts: [] }),
    "GET /admin/text2sql/tables": () => ({ tables: [], columns: [] }),
    "GET /admin/text2sql/reports": () => ({ reports: [] }),
    "GET /admin/text2sql/miners": () => ({ golden_candidates: [], glossary_candidates: [], summary: {} }),
    "GET /admin/text2sql/connections": () => ({ connections: [] }),
    "GET /admin/text2sql/kill-switch": () => ({ disabled: false, config_enabled: true }),
    "GET /admin/text2sql/risk-queue": () => ({ count: 0, queue: [] }),
    "GET /admin/text2sql/anomalies": () => ({
      detection_only: true,
      usage_smells: [],
      risk_exposure: [],
      intent_drifts: [],
    }),
    ...overrides,
  });
  let redraw = () => {};
  function Host() {
    const [, update] = useState(0);
    redraw = () => update((n) => n + 1);
    return (
      <FeatureAccessHarness featureId="text2sql.overview">
        <Text2SqlPage />
      </FeatureAccessHarness>
    );
  }
  return { ...renderScreen(<Host />, { route: `/text2sql?tab=${tab}` }), api, redraw: () => act(redraw) };
}
it("요약을 볼 때 사용하지 않는 연결 설정을 요청하지 않는다", async () => {
  const view = setup();
  await screen.findByText("지난달 주문 건수");
  expect(view.api.calls.some((c) => c.key === "GET /admin/text2sql/connections")).toBe(false);
});
it("위험 탭의 상단 새로고침은 현재 큐와 이상 탐지만 갱신한다", async () => {
  const view = setup("risk");
  await screen.findByRole("table", { name: "Text2SQL 위험 요청 큐" });
  const refresh = await screen.findByRole("button", { name: "새로고침" });
  const before = view.api.calls.length;
  await userEvent.click(refresh);
  await waitFor(() =>
    expect(
      view.api.calls
        .slice(before)
        .map((c) => c.key)
        .sort(),
    ).toEqual(["GET /admin/text2sql/anomalies", "GET /admin/text2sql/risk-queue"]),
  );
});
it("조회 거부가 발생하면 마지막 정상 질문과 SQL을 제거한다", async () => {
  let denied = false;
  const view = setup("overview", {
    "GET /admin/text2sql": () => {
      if (denied) throw apiFailure("denied", 403);
      return overview;
    },
  });
  await screen.findByText("지난달 주문 건수");
  denied = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "overview"] });
  });
  await waitFor(() => expect(screen.queryByText("지난달 주문 건수")).not.toBeInTheDocument());
  expect(screen.queryByText("SELECT COUNT(*) FROM orders")).not.toBeInTheDocument();
});
it("팀이 바뀌면 늦게 도착한 이전 팀의 질문을 표시하지 않는다", async () => {
  let finish!: (value: unknown) => void;
  let calls = 0;
  const view = setup("overview", {
    "GET /admin/text2sql": () =>
      ++calls === 1
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ...overview, logs: [] },
  });
  await waitFor(() => expect(calls).toBe(1));
  state.auth = testAuth({ user: { team_id: "beta" } });
  view.redraw();
  await act(async () => finish(overview));
  await waitFor(() => expect(calls).toBe(2));
  expect(screen.queryByText("지난달 주문 건수")).not.toBeInTheDocument();
});
it("기준 SQL 검증 탭 이름을 한글로 제공한다", async () => {
  setup();
  expect(await screen.findByRole("tab", { name: "기준 SQL 검증" })).toBeVisible();
});

it.each(["team", "write-revoke-restore"])(
  "%s 전환 후 이전 삭제 결과는 알림과 새 조회를 변경하지 않는다",
  async (change) => {
    let finish!: (value: unknown) => void;
    const success = vi.spyOn(toast, "success");
    const view = setup("golden", {
      "DELETE /admin/text2sql/golden": () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const table = await screen.findByRole("table", { name: "Text2SQL 기준 SQL" });
    await userEvent.click(await within(table).findByRole("button", { name: "삭제" }));
    await userEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(view.api.calls.some((c) => c.key === "DELETE /admin/text2sql/golden")).toBe(true),
    );
    if (change === "team") state.auth = testAuth({ user: { team_id: "beta" } });
    else state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
    view.redraw();
    if (change === "write-revoke-restore") {
      state.auth = testAuth({ user: { team_id: "alpha" } });
      view.redraw();
    }
    await waitFor(() => expect(view.client.isFetching()).toBe(0));
    const reads = view.api.calls.filter((c) => c.key === "GET /admin/text2sql").length;
    await act(async () => finish({ status: "deleted" }));
    expect(success).not.toHaveBeenCalled();
    expect(view.api.calls.filter((c) => c.key === "GET /admin/text2sql")).toHaveLength(reads);
  },
);

it.each([
  ["overview", ["GET /admin/text2sql"]],
  ["runtime", ["GET /admin/text2sql", "GET /admin/text2sql/connections", "GET /admin/text2sql/features"]],
  ["schemas", ["GET /admin/text2sql", "GET /admin/text2sql/connections"]],
  ["access", ["GET /admin/text2sql", "GET /admin/text2sql/glossary"]],
  ["golden", ["GET /admin/text2sql"]],
  ["reports", ["GET /admin/text2sql/miners", "GET /admin/text2sql/reports"]],
] as const)("%s 탭 새로고침은 활성 화면의 API만 요청한다", async (tab, expected) => {
  const view = setup(tab);
  await waitFor(() => expect(view.client.isFetching()).toBe(0));
  const before = view.api.calls.length;
  await userEvent.click(screen.getByRole("button", { name: "새로고침" }));
  await waitFor(() =>
    expect(
      view.api.calls
        .slice(before)
        .map((c) => c.key)
        .sort(),
    ).toEqual([...expected].sort()),
  );
});
it("조회 거부 뒤 수동 재시도는 새 권한으로 다시 읽는다", async () => {
  let denied = true;
  const view = setup("overview", {
    "GET /admin/text2sql": () => {
      if (denied) throw apiFailure("denied", 403);
      return overview;
    },
  });
  await screen.findByRole("alert");
  expect(view.api.calls.filter((c) => c.key === "GET /admin/text2sql")).toHaveLength(1);
  denied = false;
  await userEvent.click(screen.getByRole("button", { name: "다시 시도" }));
  await screen.findByText("지난달 주문 건수");
  expect(view.api.calls.filter((c) => c.key === "GET /admin/text2sql")).toHaveLength(2);
});
it("연결 목록 거부는 정상 프로필을 가리지 않고 변경 버튼을 잠근다", async () => {
  setup("runtime", {
    "GET /admin/text2sql/connections": () => {
      throw apiFailure("denied", 403);
    },
  });
  await screen.findByText("vibe/text2sql-finance");
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "프로필 추가" })).toBeDisabled();
});
it("팀 전환 후 늦게 도착한 내보내기 결과로 파일을 내려받지 않는다", async () => {
  let finish!: (value: unknown) => void;
  const download = vi.spyOn(downloads, "downloadText").mockImplementation(() => {});
  const view = setup("schemas", {
    "GET /admin/text2sql/registry/export": () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "JSON 내보내기" }));
  await waitFor(() => expect(finish).toBeTypeOf("function"));
  state.auth = testAuth({ user: { team_id: "beta" } });
  view.redraw();
  await act(async () => finish({ version: 1, tables: [], columns: [] }));
  expect(download).not.toHaveBeenCalled();
});
it("현재 화면에서 완료된 내보내기만 내려받는다", async () => {
  const download = vi.spyOn(downloads, "downloadText").mockImplementation(() => {});
  setup("schemas", {
    "GET /admin/text2sql/registry/export": () => ({ version: 1, tables: [], columns: [] }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "JSON 내보내기" }));
  await waitFor(() => expect(download).toHaveBeenCalledOnce());
  expect(download.mock.calls[0]?.[0]).toBe("text2sql-registry.json");
});

it("자동 갱신은 현재 위험 탭만 읽고 비활성 브라우저에서는 멈춘다", async () => {
  vi.useFakeTimers();
  usePreferences.setState({ refreshInterval: 60 });
  const view = setup("risk");
  const count = (path: string) =>
    view.api.calls.filter((c) => c.key === `GET /admin/text2sql/${path}`).length;
  try {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(count("risk-queue")).toBe(1);
    expect(count("anomalies")).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(count("risk-queue")).toBe(2);
    expect(count("anomalies")).toBe(2);
    expect(view.api.calls.some((c) => c.key === "GET /admin/text2sql")).toBe(false);
    act(() => focusManager.setFocused(false));
    const before = view.api.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(180_000);
    });
    expect(view.api.calls).toHaveLength(before);
  } finally {
    view.unmount();
    focusManager.setFocused(undefined);
    vi.useRealTimers();
  }
});
it("요약 조회 실패에도 연결 목록과 다른 탭을 계속 사용할 수 있다", async () => {
  setup("runtime", {
    "GET /admin/text2sql": () => {
      throw apiFailure("unavailable", 503);
    },
  });
  await screen.findByRole("alert");
  expect(screen.getByRole("table", { name: "Text2SQL 실행 DB 연결" })).toBeVisible();
  await userEvent.click(screen.getByRole("tab", { name: "위험·이상" }));
  await screen.findByRole("table", { name: "Text2SQL 위험 요청 큐" });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
});

it("프로필 입력 중 쓰기 권한을 회수해도 초안은 유지하고 강제 제출을 막는다", async () => {
  const view = setup("runtime");
  await userEvent.click(await screen.findByRole("button", { name: "프로필 추가" }));
  const dialog = await screen.findByRole("dialog", { name: "런타임 프로필 추가" });
  await userEvent.type(within(dialog).getByRole("textbox", { name: /가상 모델/ }), "vibe/text2sql-draft");
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
  view.redraw();
  const save = within(dialog).getByRole("button", { name: "저장" });
  expect(save).toBeDisabled();
  expect(within(dialog).getByRole("textbox", { name: /가상 모델/ })).toHaveValue("vibe/text2sql-draft");
  save.removeAttribute("disabled");
  const form = dialog.querySelector("form");
  if (!form) throw new Error("입력 폼이 없습니다.");
  fireEvent.submit(form);
  await act(async () => {});
  expect(view.api.calls.some((c) => c.key.startsWith("POST"))).toBe(false);
  state.auth = testAuth({ user: { team_id: "alpha" } });
  view.redraw();
  expect(within(dialog).getByRole("button", { name: "저장" })).toBeEnabled();
  expect(view.api.calls.some((c) => c.key.startsWith("POST"))).toBe(false);
});

it("DB 연결 점검 진단에 인증정보를 표시하지 않는다", async () => {
  setup("runtime", {
    "GET /admin/text2sql/healthcheck": () => ({
      status: "error",
      detail: "ping failed postgres://account:private-password@db.invalid/app",
      driver: "postgres",
      read_only_tx_ok: false,
    }),
  });
  await userEvent.click(await screen.findByRole("button", { name: "기본(환경 변수) 연결 점검" }));
  await screen.findByText("민감한 연결 정보는 표시하지 않습니다.");
  expect(document.body.textContent).not.toContain("private-password");
});

it("한글 기능 이름으로 선택한 스위치만 기존 식별자로 저장하고 결과를 갱신한다", async () => {
  const features = [
    { name: "self_challenge", description: "추가 호출 비용이 발생합니다.", enabled: false },
    { name: "gateway_memory", description: "최근 스키마를 활용합니다.", enabled: true },
    { name: "cumulative_risk_enforce", description: "누적 위험 한도 초과를 차단합니다.", enabled: false },
  ];
  let finish!: () => void;
  const view = setup("runtime", {
    "GET /admin/text2sql/features": () => ({ features }),
    "POST /admin/text2sql/features": (options) =>
      new Promise((resolve) => {
        finish = () => {
          const body = options.body as { name: string; enabled: boolean };
          const selected = features.find((item) => item.name === body.name);
          if (selected) selected.enabled = body.enabled;
          resolve({ status: "ok" });
        };
      }),
  });
  const extraReview = await screen.findByRole("switch", { name: "SQL 추가 검토 꺼짐" });
  expect(screen.getByRole("switch", { name: "최근 스키마 활용 켜짐" })).toBeChecked();
  expect(screen.getByRole("switch", { name: "누적 위험 차단 꺼짐" })).not.toBeChecked();
  extraReview.focus();
  await userEvent.keyboard(" ");
  await waitFor(() =>
    expect(view.api.bodies("POST /admin/text2sql/features")).toEqual([
      { name: "self_challenge", enabled: true },
    ]),
  );
  expect(extraReview).toBeDisabled();
  expect(screen.getByRole("switch", { name: "최근 스키마 활용 켜짐" })).toBeDisabled();
  await userEvent.click(extraReview);
  expect(view.api.bodies("POST /admin/text2sql/features")).toHaveLength(1);
  await act(async () => finish());
  expect(await screen.findByRole("switch", { name: "SQL 추가 검토 켜짐" })).toBeChecked();
});

it("읽기 전용에서는 한글 기능 상태를 보여주고 변경 요청은 보내지 않는다", async () => {
  state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
  const view = setup("runtime", {
    "GET /admin/text2sql/features": () => ({
      features: [{ name: "gateway_memory", description: "최근 스키마 활용", enabled: true }],
    }),
  });
  const control = await screen.findByRole("switch", { name: "최근 스키마 활용 켜짐" });
  expect(control).toBeChecked();
  expect(control).toBeDisabled();
  await userEvent.click(control);
  expect(view.api.bodies("POST /admin/text2sql/features")).toEqual([]);
});

it("연결 조회 실패를 연결 삭제로 표시하지 않고 재조회 후 프로필 연결 이름을 복구한다", async () => {
  let fail = true;
  const view = setup("runtime", {
    "GET /admin/text2sql/connections": () => {
      if (fail) throw apiFailure("unavailable", 503);
      return {
        connections: [
          { id: "analytics_db", name: "분석 DB", driver: "postgres", enabled: false, description: "" },
        ],
      };
    },
  });
  const table = await screen.findByRole("table", { name: "런타임 Text2SQL 프로필" });
  expect(await within(table).findByText("연결 상태 확인 불가")).toBeVisible();
  expect(within(table).queryByText("등록되지 않은 연결")).not.toBeInTheDocument();
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "실행 DB 연결 재시도" }));
  expect(await within(table).findByText("분석 DB")).toBeVisible();
  expect(within(table).getByText("연결 중지")).toBeVisible();
  expect(view.api.bodies("POST /admin/text2sql/profiles")).toEqual([]);
});

it("선택 기능 갱신이 실패하면 이전 상태의 변경을 막고 수동 재시도로 복구한다", async () => {
  let fail = false;
  const view = setup("runtime", {
    "GET /admin/text2sql/features": () => {
      if (fail) throw apiFailure("unavailable", 503);
      return { features: [{ name: "self_challenge", description: "SQL 검토", enabled: false }] };
    },
  });
  const control = await screen.findByRole("switch", { name: "SQL 추가 검토 꺼짐" });
  expect(control).toBeEnabled();
  fail = true;
  await act(async () => {
    await view.client.invalidateQueries({ queryKey: ["text2sql", "features"] });
  });
  await waitFor(() => expect(control).toBeDisabled());
  expect(control).toHaveAttribute("title", "선택 기능 목록을 확인한 후 변경하세요.");
  await userEvent.click(control);
  expect(view.api.bodies("POST /admin/text2sql/features")).toEqual([]);
  fail = false;
  await userEvent.click(screen.getByRole("button", { name: "선택 기능 재시도" }));
  await waitFor(() => expect(control).toBeEnabled());
});
