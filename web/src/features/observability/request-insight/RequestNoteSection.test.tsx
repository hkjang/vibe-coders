import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestNoteBoundary } from "./RequestNoteBoundary";
import { RequestNoteSection } from "./RequestNoteSection";
import { requestNoteKey } from "./request-note-state";
import { tokenStore } from "@/shared/auth/token-store";
import { Sheet } from "@/shared/components/ui/Sheet";
import { apiFailure, mockApi, type ApiHandler } from "@/test/api";
import { renderScreen } from "@/test/render";

const auth = vi.hoisted(() => ({ version: "v0.86.16", write: true }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        backendVersion: auth.version,
        scopes: auth.write ? ["admin:read", "admin:write"] : ["admin:read"],
        rawPromptView: false,
      }),
  };
});
const note = {
  request_id: "req-1",
  note: "기존 메모",
  tags: ["기존태그"],
  created_by: "admin_synthetic",
  updated_at: "2026-01-01T00:00:00Z",
  exists: true,
  redacted_fields: [],
};
const get = "GET /admin/requests/req-1/note",
  put = "PATCH /admin/requests/req-1/note",
  remove = "DELETE /admin/requests/req-1/note";
function setup(read: ApiHandler = () => note, overrides: Record<string, ApiHandler> = {}, inSheet = false) {
  const api = mockApi({
    [get]: read,
    [put]: () => note,
    [remove]: () => ({ id: "req-1", status: "deleted" }),
    ...overrides,
  });
  let refreshAuth = (): void => undefined;
  function Screen() {
    const [, refresh] = useState(0);
    const returnFocusRef = useRef<HTMLElement | null>(null);
    refreshAuth = () => refresh((value) => value + 1);
    const content = (
      <RequestNoteBoundary>
        <RequestNoteSection requestId="req-1" canWrite />
      </RequestNoteBoundary>
    );
    return inSheet ? (
      <>
        <main id="main-content" tabIndex={-1} />
        <Sheet
          open
          title="대상 요청 상세"
          description="메모 편집창이 닫혀도 남아 있는 요청 상세 패널입니다."
          onOpenChange={() => undefined}
          returnFocusRef={returnFocusRef}
        >
          {content}
        </Sheet>
      </>
    ) : (
      content
    );
  }
  const view = renderScreen(<Screen />);
  return { ...view, api, user: userEvent.setup(), refreshAuth: () => act(refreshAuth) };
}
async function open(user: ReturnType<typeof userEvent.setup>, deleting = false) {
  const trigger = await screen.findByRole("button", { name: deleting ? "태그·메모 삭제" : "메모·태그 수정" });
  await waitFor(() => expect(trigger).toBeEnabled());
  await user.click(trigger);
  return screen.findByRole("dialog", { name: deleting ? "요청 태그·메모 삭제" : "요청 메모·태그 수정" });
}
function submit(dialog: HTMLElement): void {
  const form = dialog.querySelector("form");
  if (!form) throw new Error("missing note form");
  fireEvent.submit(form);
}
beforeEach(() => {
  auth.version = "v0.86.16";
  auth.write = true;
  tokenStore.clearAll();
  toast.success.mockClear();
});

describe("요청 메모·태그 안전한 폼", () => {
  it("마스킹 필드는 기본 유지하고 전체 교체 입력에 표시값을 복사하지 않는다", async () => {
    const { user, api } = setup(() => ({
      ...note,
      note: "[REDACTED_EMAIL]",
      tags: ["[REDACTED_EMAIL]", "[REDACTED_EMAIL]"],
      redacted_fields: ["note", "tags"],
    }));
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("태그 변경 방법"), "replace");
    expect(within(dialog).getByLabelText("새 태그")).toHaveValue("");
    await user.type(within(dialog).getByLabelText("새 태그"), "새태그, 한글");
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await waitFor(() =>
      expect(api.bodies(put)).toEqual([{ preserve_fields: ["note"], tags: ["새태그", "한글"] }]),
    );
    expect(toast.success).toHaveBeenCalledWith("요청 메모·태그를 저장했습니다.");
  });
  it.each([
    { note: "", tags: ["태그"] },
    { note: "", tags: [] },
  ])("메모가 빈 저장 행도 태그와 함께 삭제한다: %j", async (fields) => {
    const { user, api } = setup(() => ({ ...note, ...fields }));
    const dialog = await open(user, true);
    expect(api.calls.filter((call) => call.key === remove)).toHaveLength(0);
    await user.click(within(dialog).getByRole("button", { name: "태그·메모 삭제" }));
    await waitFor(() => expect(api.calls.filter((call) => call.key === remove)).toHaveLength(1));
  });
  it("미존재 행은 삭제하지 않으며 생성 시에도 preserve_fields를 전송한다", async () => {
    const { user, api } = setup(() => ({ ...note, exists: false, note: "", tags: [] }));
    await waitFor(() => expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeEnabled());
    expect(screen.getByRole("button", { name: "태그·메모 삭제" })).toBeDisabled();
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "replace");
    await user.type(within(dialog).getByLabelText("새 메모"), "새 메모");
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await waitFor(() => expect(api.bodies(put)).toEqual([{ preserve_fields: ["tags"], note: "새 메모" }]));
  });
  it("명시적 비우기와 공통 dirty close·유지·폐기·포커스를 보호한다", async () => {
    const { user, api } = setup();
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "clear");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await screen.findByRole("alertdialog");
    await user.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(within(dialog).getByLabelText("메모 변경 방법")).toHaveValue("clear");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(screen.getByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "메모·태그 수정" })).toHaveFocus();
    expect(api.bodies(put)).toEqual([]);
  });
  it.each([false, true])(
    "정상 처리 뒤 재조회 중에는 비활성 trigger 대신 남은 Sheet 내부로 포커스를 복원한다: delete=%s",
    async (deleting) => {
      let saved = false;
      let releaseRead!: (value: unknown) => void;
      const { user, api } = setup(
        () =>
          saved
            ? new Promise((resolve) => {
                releaseRead = resolve;
              })
            : note,
        {
          [deleting ? remove : put]: () => {
            saved = true;
            return deleting ? { id: "req-1", status: "deleted" } : note;
          },
        },
        true,
      );
      const dialog = await open(user, deleting);
      await user.click(
        within(dialog).getByRole("button", { name: deleting ? "태그·메모 삭제" : "메모·태그 저장" }),
      );
      await waitFor(() => expect(dialog).not.toBeInTheDocument());
      const parent = screen.getByRole("dialog", { name: "대상 요청 상세" });
      expect(within(parent).getByRole("button", { name: "메모·태그 수정" })).toBeDisabled();
      await waitFor(() => expect(parent).toHaveFocus());
      expect(document.getElementById("main-content")).not.toHaveFocus();
      await user.tab();
      expect(parent.contains(document.activeElement)).toBe(true);
      expect(api.calls.filter((call) => call.key === (deleting ? remove : put))).toHaveLength(1);
      await act(async () => releaseRead(note));
      await waitFor(() =>
        expect(within(parent).getByRole("button", { name: "메모·태그 수정" })).toBeEnabled(),
      );
    },
  );
  it.each([false, true])("Sheet 안에서도 취소·폐기는 정확한 trigger로 복귀한다: dirty=%s", async (dirty) => {
    const { user, api } = setup(() => note, {}, true);
    const dialog = await open(user);
    if (dirty) await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "clear");
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    if (dirty) {
      const guard = await screen.findByRole("alertdialog");
      await user.click(within(guard).getByRole("button", { name: "변경 버리기" }));
    }
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    const parent = screen.getByRole("dialog", { name: "대상 요청 상세" });
    await waitFor(() => expect(within(parent).getByRole("button", { name: "메모·태그 수정" })).toHaveFocus());
    expect(api.bodies(put)).toEqual([]);
  });
  it("조회 갱신과 invalidation이 초안을 바꾸지 않고 저장만 차단한다", async () => {
    const { user, client, api } = setup();
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "replace");
    const input = within(dialog).getByLabelText("새 메모");
    await user.clear(input);
    await user.type(input, "열린 초안");
    act(() =>
      client.setQueryData(requestNoteKey("req-1", tokenStore.getSessionEpoch()), {
        ...note,
        note: "다른 관리자 변경",
      }),
    );
    expect(input).toHaveValue("열린 초안");
    await act(async () => {
      await client.invalidateQueries({
        queryKey: requestNoteKey("req-1", tokenStore.getSessionEpoch()),
        refetchType: "none",
      });
    });
    submit(dialog);
    expect(api.bodies(put)).toEqual([]);
    expect(input).toHaveValue("열린 초안");
    expect(within(dialog).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
  });
  it("실패 Request ID와 초안을 유지하고 수동 재시도만 보낸다", async () => {
    let fail = true;
    const { user, api } = setup(() => note, {
      [put]: () => {
        if (fail) throw apiFailure("write failed", 500, "note-retry-id");
        return note;
      },
    });
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("태그 변경 방법"), "clear");
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    expect(await within(dialog).findByText(/note-retry-id/u)).toBeVisible();
    expect(within(dialog).getByLabelText("태그 변경 방법")).toHaveValue("clear");
    fail = false;
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await waitFor(() =>
      expect(api.bodies(put)).toEqual([
        { preserve_fields: ["note"], tags: [] },
        { preserve_fields: ["note"], tags: [] },
      ]),
    );
  });
  it("v16 조회 뒤 구버전 저장 수신자의405도 PATCH로만 실패하고 PUT·POST로 우회하지 않는다", async () => {
    const { user, api } = setup(() => note, {
      [put]: () => {
        throw apiFailure("method not allowed", 405, "old-recipient-id");
      },
    });
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "clear");
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await within(dialog).findByText("저장 요청을 받은 서버가 안전한 편집을 지원하지 않습니다.");
    expect(within(dialog).getByText(/old-recipient-id/u)).toBeVisible();
    expect(within(dialog).getByLabelText("메모 변경 방법")).toHaveValue("clear");
    expect(api.bodies(put)).toEqual([{ preserve_fields: ["tags"], note: "" }]);
    expect(api.calls.some((call) => /^(PUT|POST) /u.test(call.key))).toBe(false);
  });
  it("저장 확정 뒤 조회 실패는 재전송하지 않으며 정상 조회 후 오래된 성공 안내를 지운다", async () => {
    let readError = false;
    const { user, api } = setup(
      () => {
        if (readError) throw apiFailure("read failed", 503, "note-read-id");
        return note;
      },
      {
        [put]: () => {
          readError = true;
          return note;
        },
      },
    );
    const dialog = await open(user);
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await screen.findByText("메모·태그 저장은 완료됐습니다.");
    expect(api.bodies(put)).toHaveLength(1);
    readError = false;
    await user.click(screen.getByRole("button", { name: "메모·태그 새로고침" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeEnabled());
    readError = true;
    await user.click(screen.getByRole("button", { name: "메모·태그 새로고침" }));
    await screen.findByText(/note-read-id/u);
    expect(screen.queryByText("메모·태그 저장은 완료됐습니다.")).not.toBeInTheDocument();
    expect(api.bodies(put)).toHaveLength(1);
  });
  it.each(["v0.86.15", "", "bad", "v0.86.16-rc.1"])(
    "구버전·미확인 버전 %s는 편집하지 못한다",
    async (version) => {
      auth.version = version;
      const { api } = setup();
      await screen.findByText("메모·태그 편집의 서버 버전을 확인하세요.");
      expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeDisabled();
      expect(api.bodies(put)).toEqual([]);
    },
  );
  it("열린 폼에서 버전/권한 변경은 직접 form submit도 차단한다", async () => {
    const { user, refreshAuth, api } = setup();
    const dialog = await open(user);
    auth.version = "v0.86.15";
    auth.write = false;
    refreshAuth();
    submit(dialog);
    expect(api.bodies(put)).toEqual([]);
    expect(within(dialog).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
  });
  it("조회 실패·잘못된 DTO는 빈 메모로 저장하지 않는다", async () => {
    const { api, client } = setup(() => ({ ...note, exists: null }));
    await waitFor(() =>
      expect(client.getQueryState(requestNoteKey("req-1", tokenStore.getSessionEpoch()))?.status).toBe(
        "success",
      ),
    );
    await screen.findByText("현재 메모·태그를 확인하기 전에는 변경할 수 없습니다.");
    expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeDisabled();
    expect(api.bodies(put)).toEqual([]);
  });
  it("저장 중에는 중복 제출·수정·닫기가 잠기며 늦은 성공 후 한 번만 완료한다", async () => {
    let resolve!: (value: unknown) => void;
    const { user, api } = setup(() => note, {
      [put]: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const dialog = await open(user);
    await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "clear");
    await user.click(within(dialog).getByRole("button", { name: "메모·태그 저장" }));
    await waitFor(() => expect(api.bodies(put)).toHaveLength(1));
    submit(dialog);
    expect(within(dialog).getByLabelText("메모 변경 방법")).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "취소" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(api.bodies(put)).toHaveLength(1);
    await act(async () => resolve(note));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(toast.success).toHaveBeenCalledTimes(1);
  });
  it("편집 폼의 기본 접근성 위반이 없다", async () => {
    const { user } = setup();
    const dialog = await open(user);
    expect((await axe.run(dialog, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual(
      [],
    );
  });
});
