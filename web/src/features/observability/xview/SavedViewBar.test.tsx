import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { SavedViewBar } from "./SavedViewBar";
import { mockApi } from "@/test/api";
import { FeatureAccessHarness } from "@/test/feature-access";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const saved = {
  id: "view-1",
  name: "운영 오류",
  view: "xview",
  params: "models=fixture-model",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
};
function setup({ readOnly = false, canWrite = true } = {}) {
  const onApply = vi.fn();
  const api = mockApi({
    "GET /admin/saved-filters": () => ({ filters: [saved] }),
    "POST /admin/saved-filters": () => ({ filter: saved }),
    "PATCH /admin/saved-filters/view-1": () => ({ filter: saved }),
    "DELETE /admin/saved-filters/view-1": () => ({ deleted: true }),
  });
  function RuntimeView() {
    const [locked, setLocked] = useState(readOnly);
    return (
      <FeatureAccessHarness featureId="observability.xview" readOnly={locked}>
        <button onClick={() => setLocked((value) => !value)}>테스트 전환</button>
        <SavedViewBar
          canWrite={canWrite}
          currentParams="models=fixture-model"
          selectedId="view-1"
          onApply={onApply}
          writeDeniedReason="쓰기 권한 없음"
        />
      </FeatureAccessHarness>
    );
  }
  renderScreen(<RuntimeView />);
  return { api, onApply };
}

describe("SavedViewBar feature access", () => {
  it.each([
    { readOnly: true, canWrite: true },
    { readOnly: false, canWrite: false },
  ])("keeps views readable but blocks persistence for %j", async (policy) => {
    const user = userEvent.setup();
    const { api, onApply } = setup(policy);
    await screen.findByRole("option", { name: "운영 오류" });
    for (const name of [/새로 저장/u, "덮어쓰기", "삭제"])
      expect(screen.getByRole("button", { name })).toBeDisabled();
    await user.selectOptions(screen.getByRole("combobox", { name: "저장된 뷰" }), "view-1");
    expect(onApply).toHaveBeenCalledWith("models=fixture-model", "view-1");
    expect(screen.getByRole("button", { name: "링크 복사" })).toBeEnabled();
    expect(api.calls.filter((call) => !call.key.startsWith("GET "))).toEqual([]);
  });

  it("preserves the new-view draft across a read-only flip and submits only after manual recovery", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await user.click(screen.getByRole("button", { name: /새로 저장/u }));
    const dialog = await screen.findByRole("dialog", { name: "현재 필터를 저장" });
    const input = within(dialog).getByLabelText(/뷰 이름/u);
    await user.type(input, "새 오류 보기");
    fireEvent.click(screen.getByRole("button", { name: "테스트 전환", hidden: true }));
    expect(input).toBeDisabled();
    expect(input).toHaveValue("새 오류 보기");
    expect(within(dialog).getByRole("button", { name: "저장" })).toBeDisabled();
    const form = dialog.querySelector("form");
    if (!form) throw new Error("saved view form is missing");
    fireEvent.submit(form);
    expect(api.bodies("POST /admin/saved-filters")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    await user.click(await screen.findByRole("button", { name: "계속 편집" }));
    expect(input).toHaveValue("새 오류 보기");
    fireEvent.click(screen.getByRole("button", { name: "테스트 전환", hidden: true }));
    expect(api.bodies("POST /admin/saved-filters")).toEqual([]);
    await user.click(within(dialog).getByRole("button", { name: "저장" }));
    await waitFor(() =>
      expect(api.bodies("POST /admin/saved-filters")).toEqual([
        { view: "xview", name: "새 오류 보기", params: "models=fixture-model" },
      ]),
    );
  });

  it("locks an already-open delete confirmation but permits cancellation", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByRole("option", { name: "운영 오류" });
    await user.click(screen.getByRole("button", { name: "삭제" }));
    const dialog = await screen.findByRole("dialog", { name: "저장된 뷰 삭제" });
    fireEvent.click(screen.getByRole("button", { name: "테스트 전환", hidden: true }));
    expect(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
    expect(within(dialog).getByText(/이 화면은 읽기 전용/u)).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "취소" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(api.bodies("DELETE /admin/saved-filters/view-1")).toEqual([]);
  });

  it("keeps the original writable overwrite payload", async () => {
    const user = userEvent.setup();
    const { api } = setup();
    await screen.findByRole("option", { name: "운영 오류" });
    await user.click(screen.getByRole("button", { name: "덮어쓰기" }));
    await waitFor(() =>
      expect(api.bodies("PATCH /admin/saved-filters/view-1")).toEqual([{ params: "models=fixture-model" }]),
    );
  });
});
