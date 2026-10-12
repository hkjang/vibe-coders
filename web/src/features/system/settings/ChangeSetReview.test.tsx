import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { tokenStore } from "@/shared/auth/token-store";

import { ChangeSetsTab } from "./ChangeSetsTab";
import { systemSettingsKeys } from "./use-system-settings";
import { FeatureAccessHarness } from "@/test/feature-access";
import { mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const identity = vi.hoisted(() => ({
  id: "user-a",
  team_id: "team-a",
  role: "admin",
  scopes: ["admin:read", "admin:write"],
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: identity.scopes,
        user: { id: identity.id, team_id: identity.team_id, role: identity.role },
      }),
  };
});
beforeEach(() => {
  identity.id = "user-a";
  identity.team_id = "team-a";
  identity.role = "admin";
  identity.scopes = ["admin:read", "admin:write"];
  vi.clearAllMocks();
});

const changeSet = {
  id: "cset_review",
  title: "요청 제한 검토",
  status: "approved",
  items: [{ kind: "setting", key: "upstream.timeout", value: "30s" }],
  prior: [],
  updated_at: "2026-10-12T00:00:00Z",
};

function setup(readOnly = false, overrides: Record<string, ApiHandler> = {}) {
  const api = mockApi({
    "GET /admin/change-sets": () => ({ change_sets: [changeSet] }),
    "POST /admin/change-sets": () => ({ ...changeSet, status: "draft" }),
    "POST /admin/change-sets/cset_review/apply": () => ({
      status: "applied",
      applied_count: 1,
      change_set: { ...changeSet, status: "applied" },
    }),
    "DELETE /admin/change-sets/cset_review": () => ({ status: "deleted" }),
    "POST /admin/change-sets/cset_review/dryrun": () => ({
      change_set_id: changeSet.id,
      checks: [],
      changed_count: 0,
      invalid_count: 0,
    }),
    ...overrides,
  });
  let changeAccess: (value: { readOnly: boolean; write: boolean }) => void = () => undefined;
  function Harness() {
    const [access, setAccess] = useState({ readOnly, write: true });
    changeAccess = setAccess;
    return (
      <FeatureAccessHarness featureId="system.settings" readOnly={access.readOnly}>
        <ChangeSetsTab hasAdminWrite={access.write} />
      </FeatureAccessHarness>
    );
  }
  return {
    ...renderScreen(<Harness />),
    api,
    changeAccess: (value: { readOnly: boolean; write: boolean }) => act(() => changeAccess(value)),
  };
}

async function openReview(action = "적용") {
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "요청 제한 검토 상세" }));
  const sheet = screen.getByRole("dialog", { name: changeSet.title });
  await user.click(within(sheet).getByRole("button", { name: action }));
  const dialog = screen.getByRole("dialog", {
    name: action === "삭제" ? "변경 세트를 삭제할까요?" : "설정을 실제로 적용할까요?",
  });
  await user.type(within(dialog).getByLabelText(/변경 사유/), "운영 검토 완료");
  await user.type(within(dialog).getByLabelText(/확인 문구/), changeSet.id);
  return { user, dialog };
}

describe("변경 세트의 현재 검토 기준", () => {
  it.each([
    ["apply_pending", "적용"],
    ["rollback_pending", "되돌리기"],
  ] as const)("%s에서는 복구 안내를 표시하고 삭제를 차단한다", async (status, resumeLabel) => {
    const view = setup(false, {
      "GET /admin/change-sets": () => ({ change_sets: [{ ...changeSet, status }] }),
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "요청 제한 검토 상세" }));
    const sheet = screen.getByRole("dialog", { name: changeSet.title });
    expect(within(sheet).getByText("설정 저장 후 복구 대기 중")).toBeVisible();
    expect(within(sheet).getByText(/설정을 중복 저장하지 않고/)).toBeVisible();
    expect(within(sheet).getByRole("button", { name: resumeLabel })).toBeEnabled();
    const remove = within(sheet).getByRole("button", { name: "삭제" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(screen.queryByRole("dialog", { name: "변경 세트를 삭제할까요?" })).not.toBeInTheDocument();
    expect(view.api.bodies("DELETE /admin/change-sets/cset_review")).toHaveLength(0);
  });

  it.each(["network", "empty-id", "wrong-status"])(
    "생성 %s 결과가 불확실하면 초안을 유지하고 같은 창의 재전송을 잠근다",
    async (outcome) => {
      const view = setup(false, {
        "POST /admin/change-sets": () => {
          if (outcome === "network") throw new Error("synthetic connection interrupted");
          return {
            id: outcome === "empty-id" ? "" : "new-id",
            status: outcome === "wrong-status" ? "applied" : "draft",
          };
        },
      });
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "새 변경 세트" }));
      const dialog = screen.getByRole("dialog", { name: "새 변경 세트" });
      await user.type(within(dialog).getByLabelText(/제목/), "복구할 생성 초안");
      await user.click(within(dialog).getByRole("button", { name: "만들기" }));
      await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
      expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
      expect(within(dialog).getByLabelText(/제목/)).toHaveValue("복구할 생성 초안");
      expect(toast.success).not.toHaveBeenCalled();
      expect(view.api.bodies("POST /admin/change-sets")).toHaveLength(1);
      expect(
        view.api.spy.mock.calls.find(
          ([endpoint]) => endpoint.path === "/admin/change-sets" && endpoint.method === "POST",
        )?.[1],
      ).toMatchObject({ retryUnauthorized: false });
    },
  );

  it("조회 실패 중에는 새 작성 흐름을 열지 않는다", async () => {
    const view = setup(false, {
      "GET /admin/change-sets": () => {
        throw new Error("synthetic list failure");
      },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "새 변경 세트" })).toBeDisabled());
    expect(view.api.bodies("POST /admin/change-sets")).toHaveLength(0);
  });

  it("이전 팀 생성 응답은 새 팀 초안과 알림을 바꾸지 않는다", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const pending = new Promise((ok) => {
      resolve = ok;
    });
    const view = setup(false, { "POST /admin/change-sets": () => pending });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "새 변경 세트" }));
    await user.type(screen.getByLabelText(/제목/), "이전 팀 초안");
    await user.click(screen.getByRole("button", { name: "만들기" }));
    await waitFor(() => expect(view.api.bodies("POST /admin/change-sets")).toHaveLength(1));
    identity.team_id = "new-team";
    view.changeAccess({ readOnly: false, write: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "새 변경 세트" })).toBeEnabled());
    await user.click(screen.getByRole("button", { name: "새 변경 세트" }));
    await user.type(screen.getByLabelText(/제목/), "새 팀 초안");
    const reads = view.api.calls.filter((call) => call.key.startsWith("GET ")).length;
    await act(async () => {
      resolve({ id: "old-created-id", status: "draft" });
      await Promise.resolve();
    });
    expect(screen.getByLabelText(/제목/)).toHaveValue("새 팀 초안");
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(view.api.calls.filter((call) => call.key.startsWith("GET "))).toHaveLength(reads);
  });

  it("같은 사용자라도 인증 세션 경계에서 생성 초안을 폐기한다", async () => {
    setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "새 변경 세트" }));
    await user.type(screen.getByLabelText(/제목/), "이전 세션 초안");
    act(() => tokenStore.clearAll());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
  it("같은 틱에 목록이 바뀌면 이전 행에서 새 검토를 시작하지 않는다", async () => {
    const view = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "요청 제한 검토 상세" }));
    const trigger = within(screen.getByRole("dialog", { name: changeSet.title })).getByRole("button", {
      name: "적용",
    });
    act(() => {
      view.client.setQueriesData(
        { queryKey: systemSettingsKeys.changeSets },
        { change_sets: [{ ...changeSet, title: "새로운 검토 제목" }] },
      );
      fireEvent.click(trigger);
    });
    expect(screen.queryByRole("dialog", { name: "설정을 실제로 적용할까요?" })).not.toBeInTheDocument();
    expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(0);
  });

  it("미리보기를 기다리는 동안 목록이 바뀌면 이전 결과를 표시하지 않는다", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const pending = new Promise((ok) => {
      resolve = ok;
    });
    const view = setup(false, { "POST /admin/change-sets/cset_review/dryrun": () => pending });
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "요청 제한 검토 상세" }));
    await user.click(screen.getByRole("button", { name: "미리보기" }));
    await waitFor(() => expect(view.api.calls.some((call) => call.key.endsWith("/dryrun"))).toBe(true));
    await act(async () => {
      view.client.setQueriesData(
        { queryKey: systemSettingsKeys.changeSets },
        { change_sets: [{ ...changeSet, updated_at: "new-revision" }] },
      );
      resolve({ change_set_id: changeSet.id, checks: [], changed_count: 0, invalid_count: 0 });
      await Promise.resolve();
    });
    expect(screen.queryByRole("heading", { name: "적용 미리보기" })).not.toBeInTheDocument();
  });
  it("완료를 입증하지 못하는 2xx 응답은 성공 알림 없이 재조회 전까지 잠근다", async () => {
    const view = setup(false, { "POST /admin/change-sets/cset_review/apply": () => ({ status: "applied" }) });
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("button", { name: "적용" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
    expect(toast.success).not.toHaveBeenCalled();
    expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    const sheet = screen.getByRole("dialog", { name: changeSet.title });
    expect(within(sheet).getByRole("button", { name: "적용" })).toBeDisabled();
    expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(1);
  });
  it.each(["invalidate", "same-data", "aba", "replacement", "error"])(
    "%s 이후에는 동일 항목이어도 이전 확인창에서 전송하지 않는다",
    async (kind) => {
      const view = setup();
      const { user, dialog } = await openReview();
      const query = view.client
        .getQueryCache()
        .find({ queryKey: systemSettingsKeys.changeSets, exact: false });
      expect(query).toBeDefined();
      if (!query) throw new Error("missing fixture query");
      const data = query.state.data;
      await act(async () => {
        if (kind === "invalidate")
          await view.client.invalidateQueries({ queryKey: query.queryKey, refetchType: "none" });
        else if (kind === "error")
          query.setState({ status: "error", error: new Error("fixture read failed") });
        else if (kind === "replacement") {
          view.client.removeQueries({ queryKey: query.queryKey, exact: true });
          view.client.setQueryData(query.queryKey, data);
        } else {
          if (kind === "aba")
            view.client.setQueryData(query.queryKey, { change_sets: [{ ...changeSet, title: "중간 값" }] });
          view.client.setQueryData(query.queryKey, data);
        }
      });
      await waitFor(() => expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled());
      expect(within(dialog).getByLabelText(/변경 사유/)).toHaveValue("운영 검토 완료");
      await user.click(within(dialog).getByRole("button", { name: "적용" }));
      expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(0);
    },
  );

  it("목록이 바뀌어도 확인창은 검토 당시 대상을 표시한다", async () => {
    const view = setup();
    const { dialog } = await openReview();
    act(() =>
      view.client.setQueriesData(
        { queryKey: systemSettingsKeys.changeSets },
        {
          change_sets: [{ ...changeSet, title: "다른 대상 제목" }],
        },
      ),
    );
    expect(within(dialog).getByText(/요청 제한 검토의 설정 항목/)).toBeVisible();
    expect(within(dialog).queryByText(/다른 대상 제목/)).not.toBeInTheDocument();
  });

  it("위험 작업은 정확한 변경 세트 ID를 재입력해야 한다", async () => {
    const view = setup();
    const { user, dialog } = await openReview();
    const target = within(dialog).getByLabelText(/확인 문구/);
    await user.clear(target);
    await user.type(target, changeSet.id + " ");
    expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled();
    expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(0);
    await user.clear(target);
    await user.type(target, changeSet.id);
    expect(within(dialog).getByRole("button", { name: "적용" })).toBeEnabled();
  });

  it("같은 틱에 두 번 확인해도 변경 요청은 한 번만 전송한다", async () => {
    const view = setup();
    const { dialog } = await openReview();
    const button = within(dialog).getByRole("button", { name: "적용" });
    act(() => {
      fireEvent.click(button);
      fireEvent.click(button);
    });
    await waitFor(() => expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(1));
  });

  it("응답을 받지 못한 변경은 같은 검토에서 다시 보내지 않는다", async () => {
    const view = setup(false, {
      "POST /admin/change-sets/cset_review/apply": () => {
        throw new Error("fixture transport failure");
      },
    });
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("button", { name: "적용" }));
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
    expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled();
    expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(1);
  });

  it("전환 설정이 읽기 전용이면 변경은 잠그고 적용 없는 미리보기는 유지한다", async () => {
    const { api } = setup(true);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "요청 제한 검토 상세" }));
    const sheet = screen.getByRole("dialog", { name: changeSet.title });
    expect(within(sheet).getByRole("button", { name: "적용" })).toBeDisabled();
    expect(within(sheet).getByRole("button", { name: "삭제" })).toBeDisabled();
    await user.click(within(sheet).getByRole("button", { name: "미리보기" }));
    await waitFor(() => expect(api.calls.some((call) => call.key.endsWith("/dryrun"))).toBe(true));
    expect(api.calls.every((call) => call.key.startsWith("GET ") || call.key.endsWith("/dryrun"))).toBe(true);
  });

  it.each(["readonly", "permission"])(
    "열린 확인창에서 %s 제한이 바뀌면 사유를 유지하고 전송을 잠근다",
    async (kind) => {
      const view = setup();
      const { user, dialog } = await openReview();
      view.changeAccess({ readOnly: kind === "readonly", write: kind !== "permission" });
      expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled();
      expect(within(dialog).getByLabelText(/변경 사유/)).toHaveValue("운영 검토 완료");
      await user.click(within(dialog).getByRole("button", { name: "적용" }));
      expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(0);
    },
  );

  it("생성 초안을 작성한 뒤 읽기 전용으로 바뀌면 내용을 유지하고 만들기를 잠근다", async () => {
    const view = setup();
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "새 변경 세트" }));
    const dialog = screen.getByRole("dialog", { name: "새 변경 세트" });
    await user.type(within(dialog).getByLabelText(/제목/), "보존할 초안");
    view.changeAccess({ readOnly: true, write: true });
    expect(within(dialog).getByRole("button", { name: "만들기" })).toBeDisabled();
    expect(within(dialog).getByLabelText(/제목/)).toHaveValue("보존할 초안");
    expect(view.api.bodies("POST /admin/change-sets")).toHaveLength(0);
  });

  it("같은 승인 상태라도 검토 뒤 변경 항목이 바뀌면 다시 검토해야 한다", async () => {
    const view = setup();
    const { dialog } = await openReview();
    act(() =>
      view.client.setQueriesData(
        { queryKey: systemSettingsKeys.changeSets },
        {
          change_sets: [{ ...changeSet, items: [{ ...changeSet.items[0], value: "60s" }] }],
        },
      ),
    );
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "적용" })).toBeDisabled());
    expect(within(dialog).getByLabelText(/변경 사유/)).toHaveValue("운영 검토 완료");
  });

  it("화면 갱신 전 같은 틱의 클릭도 최신 조회 기준과 대조해 차단한다", async () => {
    const view = setup();
    const { dialog } = await openReview();
    act(() => {
      view.client.setQueriesData(
        { queryKey: systemSettingsKeys.changeSets },
        {
          change_sets: [{ ...changeSet, title: "새 검토" }],
        },
      );
      fireEvent.click(within(dialog).getByRole("button", { name: "적용" }));
    });
    await waitFor(() => expect(within(dialog).getByRole("alert")).toBeVisible());
    expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(0);
  });

  it("명시적으로 검토한 변경 요청은 401 자동 갱신 재전송을 허용하지 않는다", async () => {
    const view = setup();
    const { user, dialog } = await openReview();
    await user.click(within(dialog).getByRole("button", { name: "적용" }));
    await waitFor(() => expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(1));
    const call = view.api.spy.mock.calls.find(([endpoint]) => endpoint.path.endsWith("/apply"));
    expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
  });

  it("삭제 사유도 기존 서버가 읽는 요청 본문으로 전달한다", async () => {
    const view = setup();
    const { user, dialog } = await openReview("삭제");
    await user.click(within(dialog).getByRole("button", { name: "삭제" }));
    await waitFor(() =>
      expect(view.api.bodies("DELETE /admin/change-sets/cset_review")).toEqual([{ note: "운영 검토 완료" }]),
    );
  });

  it.each(["id", "team_id", "role"] as const)(
    "%s 변경은 이전 생성 초안을 지우고 새 소유자에서 다시 시작한다",
    async (field) => {
      const view = setup();
      const user = userEvent.setup();
      await user.click(await screen.findByRole("button", { name: "새 변경 세트" }));
      await user.type(screen.getByLabelText(/제목/), "이전 소유자의 초안");
      identity[field] = "different-owner";
      view.changeAccess({ readOnly: false, write: true });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "새 변경 세트" }));
      expect(screen.getByLabelText(/제목/)).toHaveValue("");
      expect(view.api.bodies("POST /admin/change-sets")).toHaveLength(0);
    },
  );

  it("조회 권한이 사라지면 열린 검토와 상세 데이터를 숨긴다", async () => {
    const view = setup();
    await openReview();
    identity.scopes = [];
    view.changeAccess({ readOnly: false, write: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByText(changeSet.title)).not.toBeInTheDocument();
    expect(screen.getByText("현재 계정과 화면에서 변경 세트를 조회할 수 없습니다.")).toBeVisible();
  });

  it.each(["success", "error"])(
    "이전 팀에서 보낸 적용의 늦은 %s는 새 화면 조회와 알림을 만들지 않는다",
    async (outcome) => {
      let resolve: (value: unknown) => void = () => undefined;
      let reject: (reason: Error) => void = () => undefined;
      const pending = new Promise((ok, fail) => {
        resolve = ok;
        reject = fail;
      });
      const view = setup(false, { "POST /admin/change-sets/cset_review/apply": () => pending });
      const { user, dialog } = await openReview();
      await user.click(within(dialog).getByRole("button", { name: "적용" }));
      await waitFor(() =>
        expect(view.api.bodies("POST /admin/change-sets/cset_review/apply")).toHaveLength(1),
      );
      identity.team_id = "team-b";
      view.changeAccess({ readOnly: false, write: true });
      await screen.findByText(changeSet.title);
      const reads = view.api.calls.filter((call) => call.key.startsWith("GET ")).length;
      await act(async () => {
        if (outcome === "success") resolve({ status: "applied", applied_count: 1 });
        else reject(new Error("old owner failure"));
        await Promise.resolve();
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(toast.success).not.toHaveBeenCalled();
      expect(toast.error).not.toHaveBeenCalled();
      expect(view.api.calls.filter((call) => call.key.startsWith("GET "))).toHaveLength(reads);
    },
  );
});
