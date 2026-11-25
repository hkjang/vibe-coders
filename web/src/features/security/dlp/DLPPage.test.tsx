import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

import { DLPPage } from "./DLPPage";

let scopes = ["security:read", "admin:write"];
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({ mode: "authenticated", user: { scopes } }),
}));

const recommended = [
  {
    id: "mask-credentials",
    name: "자격 증명은 가리고 보내기",
    enabled: true,
    action: "MASK",
    profiles: ["credentials"],
    check: ["REQUEST"],
    teams: [],
    api_keys: [],
    note: "",
  },
  {
    id: "block-government-ids",
    name: "주민·여권 번호가 든 프롬프트 차단",
    enabled: true,
    action: "BLOCK",
    profiles: ["government"],
    check: ["REQUEST"],
    teams: [],
    api_keys: [],
    note: "",
  },
];

const catalog = [
  {
    id: "government",
    name: "정부 식별번호",
    description: "",
    default_min_confidence: "medium",
    default_min_matches: 1,
    record_distinct: 0,
    record_window: 0,
    entries: [
      {
        id: "kr_rrn",
        name: "주민·외국인등록번호",
        description: "",
        base_confidence: "medium",
        requires_context: false,
        context: [],
        mask: "[REDACTED_RRN]",
        example: "900101-1234561",
      },
    ],
  },
  {
    id: "pii",
    name: "개인 식별 정보",
    description: "",
    default_min_confidence: "medium",
    default_min_matches: 1,
    record_distinct: 0,
    record_window: 0,
    entries: [
      {
        id: "email",
        name: "이메일 주소",
        description: "",
        base_confidence: "high",
        requires_context: false,
        context: [],
        mask: "[REDACTED_EMAIL]",
        example: "kim.minsu@example.com",
      },
    ],
  },
];

function settings(overrides: { revision?: number; policies?: unknown[]; enabled?: boolean } = {}) {
  return {
    config: {
      enabled: overrides.enabled ?? false,
      evidence: "partial",
      max_scan_bytes: 262144,
      oversize: "allow",
      profiles: {},
      custom_profiles: [],
      policies: overrides.policies ?? [],
    },
    revision: overrides.revision ?? 0,
    updated_by: "",
    updated_at: "",
    catalog,
    recommended_policies: recommended,
    response_header: "X-Vibe-DLP",
    compat_header: "cf-aig-dlp",
  };
}

const noEvents = {
  events: [],
  summary: { by_action: [], by_check: [], by_profile: [], by_day: [] },
  hours: 24,
  count: 0,
};

type Handler = (body: unknown) => unknown;

function mockApi(handlers: Record<string, Handler>) {
  return vi.spyOn(apiClient, "request").mockImplementation((async (
    endpoint: { method: string; path: string },
    options?: { body?: unknown },
  ) => {
    const handler = handlers[`${endpoint.method} ${endpoint.path}`];
    if (!handler) throw new Error(`unexpected request ${endpoint.method} ${endpoint.path}`);
    return handler(options?.body);
  }) as never);
}

function bodyOf(request: ReturnType<typeof mockApi>, method: string, path: string): Record<string, unknown> {
  const call = request.mock.calls.find(([endpoint]) => {
    const e = endpoint as { method: string; path: string };
    return e.method === method && e.path === path;
  });
  return (call?.[1] as { body: Record<string, unknown> }).body;
}

function renderAt(path: string, readOnly = false) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <UnsavedChangesProvider>
          <FeatureAccessContext.Provider value={{ featureId: "security.dlp", permitted: true, readOnly }}>
            <DLPPage />
          </FeatureAccessContext.Provider>
        </UnsavedChangesProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  scopes = ["security:read", "admin:write"];
});

describe("DLPPage settings", () => {
  it("adds the recommended policies and saves them on top of the loaded revision", async () => {
    const request = mockApi({
      "GET /admin/security/dlp": () => settings(),
      "GET /admin/security/dlp/events": () => noEvents,
      "PUT /admin/security/dlp": (body) => ({
        config: (body as { config: unknown }).config,
        revision: 1,
        updated_by: "ops",
        updated_at: "2026-11-26T00:00:00Z",
      }),
    });
    renderAt("/dlp");
    expect(await screen.findByText("아직 정책이 없습니다.")).toBeVisible();
    const save = screen.getByRole("button", { name: "저장" });
    expect(save).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /권장 정책 추가/u }));
    const list = await screen.findByRole("list", { name: "DLP 정책 목록" });
    expect(within(list).getByText("자격 증명은 가리고 보내기")).toBeVisible();
    expect(within(list).getByText("주민·여권 번호가 든 프롬프트 차단")).toBeVisible();
    expect(save).toBeEnabled();

    fireEvent.click(save);
    await waitFor(() => expect(screen.getByText("버전 1")).toBeVisible());
    const body = bodyOf(request, "PUT", "/admin/security/dlp");
    expect(body.expected_revision).toBe(0);
    expect((body.config as { policies: { id: string }[] }).policies.map((p) => p.id)).toEqual([
      "mask-credentials",
      "block-government-ids",
    ]);
    expect(save).toBeDisabled();
  });

  it("keeps the draft and explains a conflict when someone else saved first", async () => {
    mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 3, policies: [recommended[0]] }),
      "GET /admin/security/dlp/events": () => noEvents,
      "PUT /admin/security/dlp": () => {
        throw new AppError("conflict", { kind: "http", status: 409, code: "dlp_conflict" });
      },
    });
    renderAt("/dlp");
    fireEvent.click(await screen.findByRole("switch", { name: /DLP 꺼짐/u }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("다른 운영자가 먼저 저장했습니다.")).toBeVisible();
    expect(screen.getByRole("switch", { name: /DLP 켜짐/u })).toBeChecked();
    expect(screen.getByRole("button", { name: /최신 설정 불러오기/u })).toBeVisible();
  });

  it("lists server issues by place and opens the tab that holds the field", async () => {
    mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 2, policies: [recommended[0]] }),
      "GET /admin/security/dlp/events": () => noEvents,
      "PUT /admin/security/dlp": () => {
        throw new AppError("invalid", {
          kind: "http",
          status: 422,
          code: "dlp_config_invalid",
          details: { issues: [{ path: "policies[0].profiles", message: "알 수 없는 프로필 secret" }] },
        });
      },
    });
    renderAt("/dlp");
    fireEvent.click(await screen.findByRole("switch", { name: /DLP 꺼짐/u }));
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByText("설정 오류 1건 — 저장하지 않았습니다.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "정책 자격 증명은 가리고 보내기" }));
    expect(await screen.findByRole("list", { name: "DLP 정책 목록" })).toBeVisible();
  });

  it("shows the settings read-only without admin:write", async () => {
    scopes = ["security:read"];
    mockApi({
      "GET /admin/security/dlp": () => settings(),
      "GET /admin/security/dlp/events": () => noEvents,
    });
    renderAt("/dlp");
    expect(await screen.findByText("아직 정책이 없습니다.")).toBeVisible();
    expect(screen.queryByRole("button", { name: /권장 정책 추가/u })).toBeNull();
    expect(screen.queryByRole("button", { name: "저장" })).toBeNull();
    expect(screen.getByRole("switch", { name: /DLP 꺼짐/u })).toBeDisabled();
  });
});

describe("DLPPage test scan", () => {
  it("scans with the unsaved draft and marks what it found", async () => {
    const text = "주민번호 900101-1234561";
    const start = new TextEncoder().encode("주민번호 ").length;
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 1, policies: [recommended[1]] }),
      "POST /admin/security/dlp/test": () => ({
        matches: [
          {
            profile_id: "government",
            entry_id: "kr_rrn",
            entry_name: "주민·외국인등록번호",
            start,
            end: start + "900101-1234561".length,
            confidence: "high",
          },
        ],
        profiles: [
          {
            profile_id: "government",
            name: "정부 식별번호",
            triggered: true,
            match_count: 1,
            entry_ids: ["kr_rrn"],
          },
        ],
        truncated: false,
        scanned_bytes: 30,
        request: {
          action: "BLOCK",
          policies: [{ policy_id: "block-government-ids", action: "BLOCK", profiles: ["government"] }],
        },
        response: { action: "", policies: [] },
        masked_request: "",
        header: '{"action":"BLOCK"}',
      }),
    });
    renderAt("/dlp?tab=test");
    fireEvent.change(await screen.findByLabelText(/검사할 텍스트/u), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "검사" }));

    const marked = await screen.findByLabelText("찾은 위치가 표시된 텍스트");
    expect(within(marked).getByText("900101-1234561")).toBeVisible();
    expect(screen.getByText("block-government-ids")).toBeVisible();
    const body = bodyOf(request, "POST", "/admin/security/dlp/test");
    expect(body.text).toBe(text);
    expect((body.config as { policies: { id: string }[] }).policies.map((p) => p.id)).toEqual([
      "block-government-ids",
    ]);
  });
});

describe("DLPPage test scan without write access", () => {
  it("tests the saved configuration, never a draft", async () => {
    scopes = ["security:read"];
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 1, policies: [recommended[1]] }),
      "POST /admin/security/dlp/test": () => ({
        matches: [],
        profiles: [],
        truncated: false,
        scanned_bytes: 6,
        request: { action: "", policies: [] },
        response: { action: "", policies: [] },
        masked_request: "",
        header: "",
      }),
    });
    renderAt("/dlp?tab=test");
    fireEvent.change(await screen.findByLabelText(/검사할 텍스트/u), { target: { value: "안녕하세요" } });
    fireEvent.click(screen.getByRole("button", { name: "검사" }));
    expect(await screen.findByText("찾은 값이 없습니다.")).toBeVisible();
    const body = bodyOf(request, "POST", "/admin/security/dlp/test");
    expect(body.text).toBe("안녕하세요");
    expect(body).not.toHaveProperty("config");
  });
});

describe("DLPPage events", () => {
  it("shows masked previews and fingerprints, never the matched value", async () => {
    mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 1, enabled: true, policies: [recommended[0]] }),
      "GET /admin/security/dlp/events": () => ({
        events: [
          {
            id: "dlp_1",
            request_id: "req_1",
            api_key_id: "key_1",
            user_id: "",
            team_id: "team-a",
            check: "REQUEST",
            action: "FLAG",
            policy_ids: ["flag-personal-data"],
            profile_id: "pii",
            entry_ids: ["email"],
            match_count: 1,
            confidence: "high",
            evidence: ["k•••@e•••.com (21자)"],
            hashes: ["0123456789abcdef"],
            endpoint: "/v1/chat/completions",
            model: "gpt-4.1",
            created_at: "2026-11-26T00:00:00Z",
          },
          {
            id: "dlp_2",
            request_id: "req_2",
            api_key_id: "",
            user_id: "",
            team_id: "",
            check: "RESPONSE",
            action: "BLOCK",
            policy_ids: [],
            profile_id: "government",
            entry_ids: ["kr_rrn"],
            match_count: 2,
            confidence: "high",
            evidence: [],
            hashes: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
            endpoint: "/v1/chat/completions",
            model: "",
            created_at: "2026-11-26T00:01:00Z",
          },
        ],
        summary: {
          by_action: [{ key: "FLAG", events: 1, requests: 1, matches: 1 }],
          by_check: [],
          by_profile: [{ key: "pii", events: 1, requests: 1, matches: 1 }],
          by_day: [],
        },
        hours: 24,
        count: 2,
      }),
    });
    renderAt("/dlp?tab=events");
    const table = await screen.findByRole("table", { name: "DLP 탐지 이벤트" });
    expect(within(table).getByText("k•••@e•••.com (21자)")).toBeVisible();
    expect(within(table).getByText("지문 2개")).toBeVisible();
    expect(within(table).getByText("이메일 주소")).toBeVisible();
    expect(within(table).getByRole("link", { name: "요청 req_1 입출력 보기" })).toHaveAttribute(
      "href",
      "/observability/io?request_id=req_1",
    );
    expect(document.body.textContent).not.toContain("kim.minsu@example.com");
  });
});

describe("DLPPage usability", () => {
  const putEcho = (body: unknown) => ({
    config: (body as { config: unknown }).config,
    revision: 4,
    updated_by: "ops",
    updated_at: "2026-11-26T00:00:00Z",
  });

  it("summarises unsaved changes, saves with Ctrl+S and warns before leaving", async () => {
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 3, policies: [recommended[0]] }),
      "GET /admin/security/dlp/events": () => noEvents,
      "PUT /admin/security/dlp": putEcho,
    });
    renderAt("/dlp");
    fireEvent.click(await screen.findByRole("switch", { name: /DLP 꺼짐/u }));
    expect(screen.getByText(/변경 1건: DLP 켜기/u)).toBeVisible();

    const leave = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(leave);
    expect(leave.defaultPrevented).toBe(true);

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(screen.getByText("버전 4")).toBeVisible());
    expect(bodyOf(request, "PUT", "/admin/security/dlp").expected_revision).toBe(3);
    expect(screen.queryByText(/변경 1건/u)).toBeNull();

    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it("does not save with Ctrl+S when nothing changed or without write access", async () => {
    scopes = ["security:read"];
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 3, policies: [recommended[0]] }),
      "GET /admin/security/dlp/events": () => noEvents,
    });
    renderAt("/dlp");
    await screen.findByRole("switch", { name: /DLP 꺼짐/u });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(request.mock.calls.some(([endpoint]) => (endpoint as { method: string }).method === "PUT")).toBe(
      false,
    );
  });

  it("finds a detection entry and tries its example in the test scan", async () => {
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 1, policies: [recommended[1]] }),
      "POST /admin/security/dlp/test": () => ({
        matches: [],
        profiles: [],
        truncated: false,
        scanned_bytes: 14,
        request: { action: "", policies: [] },
        response: { action: "", policies: [] },
        masked_request: "",
        header: "",
      }),
    });
    renderAt("/dlp?tab=profiles");
    fireEvent.change(await screen.findByRole("searchbox", { name: /탐지 항목 찾기/u }), {
      target: { value: "주민" },
    });
    expect(screen.getByText(/1개 프로필에서 1개 항목/u)).toBeVisible();
    expect(screen.queryByText("이메일 주소")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "주민·외국인등록번호 예시로 테스트 스캔 (정부 식별번호)" }),
    );

    expect(await screen.findByLabelText(/검사할 텍스트/u)).toHaveValue("900101-1234561");
    await waitFor(() =>
      expect(bodyOf(request, "POST", "/admin/security/dlp/test").text).toBe("900101-1234561"),
    );
  });

  it("scans with Ctrl+Enter, counts bytes against the limit and clears", async () => {
    const request = mockApi({
      "GET /admin/security/dlp": () => settings({ revision: 1, policies: [recommended[1]] }),
      "POST /admin/security/dlp/test": () => ({
        matches: [],
        profiles: [],
        truncated: false,
        scanned_bytes: 6,
        request: { action: "", policies: [] },
        response: { action: "", policies: [] },
        masked_request: "",
        header: "",
      }),
    });
    renderAt("/dlp?tab=test");
    const box = await screen.findByLabelText(/검사할 텍스트/u);
    fireEvent.change(box, { target: { value: "안녕" } });
    expect(screen.getByText(/6B \/ 검사 상한 256KiB/u)).toBeVisible();
    fireEvent.keyDown(box, { key: "Enter", ctrlKey: true });
    expect(await screen.findByText("찾은 값이 없습니다.")).toBeVisible();
    expect(bodyOf(request, "POST", "/admin/security/dlp/test").text).toBe("안녕");
    fireEvent.click(screen.getByRole("button", { name: /지우기/u }));
    expect(box).toHaveValue("");
    expect(screen.queryByText("찾은 값이 없습니다.")).toBeNull();
  });
});
