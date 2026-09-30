import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FeatureRoute } from "./FeatureRoute";
import { migrationRegistry } from "@/config/migration-registry";
import { SkillDetailSheet } from "@/features/agents/skills/SkillDetailSheet";
import { RequestNoteBoundary } from "@/features/observability/request-insight/RequestNoteBoundary";
import { RequestNoteSection } from "@/features/observability/request-insight/RequestNoteSection";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ readOnly: false, previewReadonly: false }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth();
      return {
        ...auth,
        features: auth.features.map((feature) => ({
          ...feature,
          readOnly: runtime.readOnly,
          status: runtime.previewReadonly ? ("preview_read_only" as const) : feature.status,
        })),
      };
    },
  };
});
const note = {
  request_id: "req",
  note: "기존 메모",
  tags: [],
  exists: true,
  redacted_fields: [],
  created_by: "writer",
  updated_at: "2026-01-01T00:00:00Z",
};
const fitness = { skill: "skill", evidence: [], passing_count: 0, required: 2 };
type Pilot = "agents.skills" | "observability.llm" | "observability.xview";
async function setup(id: Pilot, deleting = false) {
  let release: (() => void) | undefined;
  let hold = false,
    fail = false;
  const write = () => {
    if (fail) throw apiFailure("synthetic failure", 503, "req_readonly_retry");
    return hold
      ? new Promise((resolve) => {
          release = () => resolve(id === "agents.skills" ? { skill_name: "skill", created_at: "" } : note);
        })
      : id === "agents.skills"
        ? { skill_name: "skill", created_at: "" }
        : note;
  };
  const method =
    id === "agents.skills"
      ? "POST /admin/skills/fitness"
      : `${deleting ? "DELETE" : "PATCH"} /admin/requests/req/note`;
  const api = mockApi({
    "GET /admin/skills/fitness": () => fitness,
    "GET /admin/requests/req/note": () => note,
    [method]: write,
  });
  let refresh: () => void = () => undefined;
  const selected = migrationRegistry.find((entry) => entry.featureId === id);
  if (!selected) throw new Error("missing fixture feature");
  const feature = selected;
  function Host() {
    const [, redraw] = useState(0);
    refresh = () => redraw((value) => value + 1);
    return (
      <FeatureRoute feature={feature}>
        {id === "agents.skills" ? (
          <SkillDetailSheet
            open
            canWrite
            skill={{ name: "skill" }}
            onOpenChange={() => undefined}
            onEdit={() => undefined}
            onDelete={() => undefined}
            onPromote={() => undefined}
            returnFocusRef={{ current: null }}
            writeDisabledReason="권한 없음"
          />
        ) : (
          <RequestNoteBoundary>
            <RequestNoteSection requestId="req" canWrite />
          </RequestNoteBoundary>
        )}
      </FeatureRoute>
    );
  }
  renderScreen(<Host />);
  const user = userEvent.setup();
  if (id === "agents.skills") await user.click(screen.getByRole("button", { name: "적합성 근거" }));
  const opener = await screen.findByRole("button", {
    name: id === "agents.skills" ? "근거 기록" : deleting ? "태그·메모 삭제" : "메모·태그 수정",
  });
  await waitFor(() => expect(opener).toBeEnabled());
  await user.click(opener);
  const dialog = await screen.findByRole("dialog", {
    name:
      id === "agents.skills"
        ? "스킬 적합성 근거 기록"
        : deleting
          ? "요청 태그·메모 삭제"
          : "요청 메모·태그 수정",
  });
  const field =
    id === "agents.skills"
      ? within(dialog).getByRole("textbox", { name: "참조 ID" })
      : deleting
        ? undefined
        : within(dialog).getByLabelText("메모 변경 방법");
  if (id === "agents.skills" && field) await user.type(field, "유지할 참조");
  else if (!deleting && field) await user.selectOptions(field, "clear");
  const save = within(dialog).getByRole("button", {
    name: id === "agents.skills" ? "근거 기록 저장" : deleting ? "태그·메모 삭제" : "메모·태그 저장",
  });
  const submit = () => {
    const form = dialog.querySelector("form");
    if (!form) throw new Error("missing form");
    fireEvent.submit(form);
  };
  return {
    api,
    method,
    user,
    dialog,
    field,
    save,
    submit,
    readonly: (value: boolean, preview = false) => {
      runtime.readOnly = !preview && value;
      runtime.previewReadonly = preview && value;
      act(refresh);
    },
    hold: () => {
      hold = true;
    },
    release: () => act(() => release?.()),
    fail: (value: boolean) => {
      fail = value;
    },
  };
}
beforeEach(() => {
  runtime.readOnly = false;
  runtime.previewReadonly = false;
});
describe("열린 초안의 runtime readonly 전환", () => {
  for (const id of ["agents.skills", "observability.llm", "observability.xview"] as const) {
    it.each([false, true])(
      `${id} dirty 초안은 flag/status 전환에서도 같은 입력·guard를 유지한다: status=%s`,
      async (preview) => {
        const current = await setup(id);
        current.readonly(true, preview);
        expect(current.field).toBeDisabled();
        expect(current.field).toHaveValue(id === "agents.skills" ? "유지할 참조" : "clear");
        expect(current.save).toBeDisabled();
        expect(within(current.dialog).getByText(/이 화면은 읽기 전용입니다/u)).toBeVisible();
        current.submit();
        expect(current.api.bodies(current.method)).toEqual([]);
        await current.user.click(within(current.dialog).getByRole("button", { name: "취소" }));
        await current.user.click(await screen.findByRole("button", { name: "계속 편집" }));
        expect(current.dialog).toBeInTheDocument();
        current.readonly(false);
        expect(current.field).toBeEnabled();
        expect(current.api.bodies(current.method)).toEqual([]);
        await current.user.click(current.save);
        await waitFor(() => expect(current.dialog).not.toBeInTheDocument());
        expect(current.api.bodies(current.method)).toHaveLength(1);
      },
    );
    it(`${id} 이미 전송한 요청은 readonly 후에도 사실 결과로 완료하되 추가 요청은 없다`, async () => {
      const current = await setup(id);
      current.hold();
      current.submit();
      await waitFor(() => expect(current.api.bodies(current.method)).toHaveLength(1));
      current.readonly(true);
      current.submit();
      expect(current.api.bodies(current.method)).toHaveLength(1);
      current.release();
      await waitFor(() => expect(current.dialog).not.toBeInTheDocument());
      expect(current.api.bodies(current.method)).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: id === "agents.skills" ? "근거 기록" : "메모·태그 수정" }),
      ).toBeDisabled();
    });
  }
  it.each(["observability.llm", "observability.xview"] as const)(
    "%s 열린 삭제와 오류 재시도도 readonly가 막는다",
    async (id) => {
      const current = await setup(id, true);
      current.fail(true);
      current.submit();
      expect(await within(current.dialog).findByRole("alert")).toHaveTextContent("req_readonly_retry");
      current.readonly(true);
      expect(current.save).toBeDisabled();
      current.submit();
      expect(current.api.bodies(current.method)).toHaveLength(1);
      current.fail(false);
      current.readonly(false);
      expect(current.api.bodies(current.method)).toHaveLength(1);
      current.submit();
      await waitFor(() => expect(current.dialog).not.toBeInTheDocument());
      expect(current.api.bodies(current.method)).toHaveLength(2);
    },
  );
});
