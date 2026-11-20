import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { toast as sonnerToast } from "sonner";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppProviders } from "@/app/providers/AppProviders";
import { toast } from "./toast";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { AuthProvider: ({ children }: PropsWithChildren) => children, useAuth: () => testAuth() };
});
async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  render(
    <AppProviders>
      <button>작업 시작</button>
    </AppProviders>,
  );
});
afterEach(async () => {
  sonnerToast.dismiss();
  await tick(1000);
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("공통 알림 표시 시간", () => {
  it("짧은 시간이 지정돼도 오류와 요청 번호를 유지하고 한글 닫기 작업을 전달한다", async () => {
    const onDismiss = vi.fn();
    const trigger = screen.getByRole("button", { name: "작업 시작" });
    trigger.focus();
    act(() => {
      toast.error("작업을 완료하지 못했습니다.", {
        description: "요청 ID: public-operation",
        duration: 1,
        onDismiss,
      });
    });
    await tick(100);
    await tick(15_000);
    expect(screen.getByText("작업을 완료하지 못했습니다.")).toBeInTheDocument();
    expect(screen.getByText("요청 ID: public-operation")).toBeInTheDocument();
    expect(trigger).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "알림 닫기" }));
    await tick(1000);
    expect(screen.queryByText("작업을 완료하지 못했습니다.")).not.toBeInTheDocument();
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it.each(["success", "info"] as const)("%s 알림은 계속 자동 종료한다", async (kind) => {
    act(() => {
      toast[kind]("작업 결과를 확인하세요.");
    });
    await tick(100);
    expect(screen.getByText("작업 결과를 확인하세요.")).toBeInTheDocument();
    await tick(4500);
    await tick(1000);
    expect(screen.queryByText("작업 결과를 확인하세요.")).not.toBeInTheDocument();
  });

  it("경고와 설명을 읽을 시간을 확보한 뒤 자동 종료한다", async () => {
    act(() => {
      toast.warning("건너뛴 행 5건", { description: "파일의 검사 키를 확인하세요.", duration: 1 });
    });
    await tick(100);
    await tick(5500);
    expect(screen.getByText("건너뛴 행 5건")).toBeInTheDocument();
    expect(screen.getByText("파일의 검사 키를 확인하세요.")).toBeInTheDocument();
    await tick(5000);
    await tick(1000);
    expect(screen.queryByText("건너뛴 행 5건")).not.toBeInTheDocument();
  });
});
