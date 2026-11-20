import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { RequestNoteBoundary } from "./RequestNoteBoundary";
import { RequestNoteSection } from "./RequestNoteSection";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
const runtime = vi.hoisted(() => ({
  version: "v0.86.15",
  path: "/admin#/requests",
  fallback: true,
  detail: true,
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => {
      const auth = testAuth({ backendVersion: runtime.version });
      return {
        ...auth,
        capabilities: {
          raw_prompt_view: false,
          legacy_request_detail: runtime.detail,
          legacy_request_direct_detail: true,
        },
        features: auth.features.map((f) =>
          f.featureId === "observability.requests"
            ? { ...f, legacyPath: runtime.path, fallbackEnabled: runtime.fallback }
            : f,
        ),
      };
    },
  };
});
beforeEach(() => {
  Object.assign(runtime, { version: "v0.86.15", path: "/admin#/requests", fallback: true, detail: true });
});
const id = "note +%2F?&# 한글";
function setup() {
  const api = mockApi({
    ["GET /admin/requests/" + encodeURIComponent(id) + "/note"]: () => ({
      request_id: id,
      note: "saved",
      tags: [],
      created_by: "operator",
      updated_at: "2026-01-01T00:00:00Z",
      exists: true,
      redacted_fields: [],
    }),
  });
  let refresh = () => {};
  function Screen() {
    const [, render] = useState(0);
    refresh = () => render((n) => n + 1);
    return (
      <RequestNoteBoundary>
        <RequestNoteSection requestId={id} canWrite />
      </RequestNoteBoundary>
    );
  }
  renderScreen(
    <FeatureAccessHarness featureId="observability.llm">
      <Screen />
    </FeatureAccessHarness>,
  );
  return { api, user: userEvent.setup(), refresh: () => act(refresh) };
}
it("keeps the original note target when its contract is unsupported", async () => {
  const { api } = setup();
  await screen.findByText("메모·태그 편집의 서버 버전을 확인하세요.");
  expect(screen.getByRole("link", { name: "기존 화면에서 같은 요청 열기" })).toHaveAttribute(
    "href",
    "/admin#/requests?" + new URLSearchParams({ request_id: id }),
  );
  expect(api.calls.every((c) => c.key.startsWith("GET "))).toBe(true);
});
it("uses the request destination policy, independent of the current LLM feature", async () => {
  runtime.path = "/admin#/configured-requests?custom=1";
  setup();
  expect(await screen.findByRole("link", { name: "기존 화면에서 요청 열기" })).toHaveAttribute(
    "href",
    runtime.path,
  );
});
it("hides the note fallback when the request destination is disabled", async () => {
  runtime.fallback = false;
  setup();
  await screen.findByText("메모·태그 편집의 서버 버전을 확인하세요.");
  expect(screen.queryByRole("link", { name: /기존 화면에서/u })).toBeNull();
});
it("keeps the dialog target and unsaved draft when contract support disappears", async () => {
  runtime.version = "v0.86.16";
  const { api, user, refresh } = setup();
  await waitFor(() => expect(screen.getByRole("button", { name: "메모·태그 수정" })).toBeEnabled());
  await user.click(screen.getByRole("button", { name: "메모·태그 수정" }));
  const dialog = await screen.findByRole("dialog", { name: "요청 메모·태그 수정" });
  await user.selectOptions(within(dialog).getByLabelText("메모 변경 방법"), "replace");
  await user.clear(within(dialog).getByLabelText("새 메모"));
  await user.type(within(dialog).getByLabelText("새 메모"), "UNSAVED_DRAFT");
  runtime.version = "v0.86.15";
  refresh();
  expect(within(dialog).getByRole("link", { name: "기존 화면에서 같은 요청 열기" })).toHaveAttribute(
    "href",
    "/admin#/requests?" + new URLSearchParams({ request_id: id }),
  );
  expect(within(dialog).getByLabelText("새 메모")).toHaveValue("UNSAVED_DRAFT");
  expect(within(dialog).getByRole("button", { name: "메모·태그 저장" })).toBeDisabled();
  await user.click(within(dialog).getByRole("button", { name: "취소" }));
  await screen.findByRole("alertdialog");
  await user.click(screen.getByRole("button", { name: "계속 편집" }));
  expect(within(dialog).getByLabelText("새 메모")).toHaveValue("UNSAVED_DRAFT");
  expect(api.calls.every((c) => c.key.startsWith("GET "))).toBe(true);
});
