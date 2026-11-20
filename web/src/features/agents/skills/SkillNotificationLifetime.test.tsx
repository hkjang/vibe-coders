import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/app/providers/AppProviders";
import { apiClient } from "@/shared/api/client";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { SkillScopeBoundary } from "./skill-scope";
import { SkillToolbox } from "./SkillToolbox";

const download = vi.hoisted(() => vi.fn());
vi.mock("@/shared/utils/csv", () => ({ downloadText: download }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { AuthProvider: ({ children }: PropsWithChildren) => children, useAuth: () => testAuth() };
});
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
async function openToolbox() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/app/agents/skills"]}>
        <AppProviders>
          <FeatureAccessContext.Provider
            value={{ featureId: "agents.skills", permitted: true, readOnly: false }}
          >
            <SkillScopeBoundary>
              <SkillToolbox canWrite statusFilter="all" writeDisabledReason="읽기 전용" />
            </SkillScopeBoundary>
          </FeatureAccessContext.Provider>
        </AppProviders>
      </MemoryRouter>,
    );
  });
  await tick(100);
}
function MutationFailure() {
  const mutation = useMutationFeedback<undefined, undefined>({
    mutate: async () => {
      throw new Error("private synthetic mutation failure");
    },
    errorMessage: "저장하지 못했습니다.",
  });
  return <button onClick={() => mutation.mutate(undefined)}>저장</button>;
}
async function expectPersistentAndDismiss(message: string) {
  expect(screen.getByText(message)).toBeInTheDocument();
  await tick(4500);
  await tick(1000);
  expect(screen.queryByText(message)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
  await tick(1000);
  expect(screen.queryByText(message)).not.toBeInTheDocument();
}
beforeEach(() => {
  vi.useFakeTimers();
  download.mockClear();
});
afterEach(async () => {
  toast.dismiss();
  await tick(1000);
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("실제 알림의 오류 유지와 성공 종료", () => {
  it("스킬 내보내기 오류는 사용자가 닫을 때까지 유지하고 자동 재시도하지 않는다", async () => {
    const request = vi.spyOn(apiClient, "request").mockRejectedValue(new Error("private export error"));
    await openToolbox();
    fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
    await tick(100);
    await expectPersistentAndDismiss("스킬 번들을 내보내지 못했습니다.");
    expect(request).toHaveBeenCalledTimes(1);
    expect(download).not.toHaveBeenCalled();
    expect(screen.queryByText(/private export/)).not.toBeInTheDocument();
  });

  it.each([
    ["{", "번들 파일이 올바른 JSON이 아닙니다."],
    ['{"skills":{}}', "번들 파일에 skills 배열이 없습니다."],
  ])("스킬 파일 검증 오류도 직접 닫기 전까지 유지한다: %s", async (content, message) => {
    const request = vi.spyOn(apiClient, "request");
    await openToolbox();
    const file = new File([content], "invalid.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: async () => content });
    fireEvent.change(screen.getByLabelText("가져오기", { exact: true }), { target: { files: [file] } });
    await tick(100);
    await expectPersistentAndDismiss(message);
    expect(request).not.toHaveBeenCalled();
  });

  it("공통 저장 오류의 기존 유지·한글 닫기 동작을 보존한다", async () => {
    render(
      <AppProviders>
        <MutationFailure />
      </AppProviders>,
    );
    fireEvent.click(screen.getByRole("button", { name: "저장" }));
    await tick(100);
    await expectPersistentAndDismiss("저장하지 못했습니다.");
  });

  it("성공한 스킬 내보내기는 여전히 자동 종료하고 파일을 한 번 만든다", async () => {
    vi.spyOn(apiClient, "request").mockResolvedValue({ version: "1", skills: [] });
    await openToolbox();
    fireEvent.click(screen.getByRole("button", { name: "내보내기" }));
    await tick(100);
    expect(screen.getByText("스킬 번들을 내려받았습니다.")).toBeInTheDocument();
    await tick(4500);
    await tick(1000);
    expect(screen.queryByText("스킬 번들을 내려받았습니다.")).not.toBeInTheDocument();
    expect(download).toHaveBeenCalledTimes(1);
  });
});
