import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppErrorBoundary } from "@/app/error-boundaries/AppErrorBoundary";

const privateDetail = "SYNTHETIC_PRIVATE_PROVIDER_FAILURE";

function ThrowingChild(): React.JSX.Element {
  throw new Error(privateDetail);
}

function renderFailure(): ReturnType<typeof render> {
  // Deliberately no AuthProvider: the production boundary also surrounds it.
  // This is a React render failure, not an injected window/event exception.
  return render(
    <AppErrorBoundary>
      <ThrowingChild />
    </AppErrorBoundary>,
  );
}

describe("AppErrorBoundary recovery without a trusted authentication provider", () => {
  beforeEach(() => {
    // React reports the deliberately thrown synthetic error during recovery.
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  it("control: preserves healthy children without requiring authentication context", () => {
    render(
      <AppErrorBoundary>
        <h1>정상 화면</h1>
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "정상 화면" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("control: catches a real child render error outside AuthProvider and hides its raw detail", () => {
    renderFailure();

    expect(screen.getByRole("alert")).toHaveTextContent("신규 콘솔에서 오류가 발생했습니다.");
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent(privateDetail);
    expect(console.error).toHaveBeenCalledWith("app_error_boundary", {
      name: "Error",
      componentStack: expect.any(String),
    });
  });

  it("does not offer Legacy navigation when permission and fallback settings are unavailable", () => {
    renderFailure();

    expect(screen.getByRole("heading", { name: "신규 콘솔에서 오류가 발생했습니다." })).toBeVisible();
    expect(screen.queryByRole("link", { name: "기존 관리자 화면 열기" })).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/admin"]')).not.toBeInTheDocument();
  });

  it("gives actionable Korean guidance without asserting unverified Legacy server health", () => {
    renderFailure();

    expect(screen.getByRole("alert")).not.toHaveTextContent("기존 관리자 화면은 영향을 받지 않았습니다.");
    expect(screen.getByRole("alert")).toHaveTextContent(
      "화면을 다시 불러오세요. 문제가 계속되면 관리자에게 문의하세요.",
    );
  });

  it("focuses the fatal heading on error entry, then preserves the user's recovery action focus", async () => {
    const user = userEvent.setup();
    const view = render(
      <AppErrorBoundary>
        <button>정상 화면 작업</button>
      </AppErrorBoundary>,
    );
    screen.getByRole("button", { name: "정상 화면 작업" }).focus();
    expect(screen.getByRole("button", { name: "정상 화면 작업" })).toHaveFocus();
    view.rerender(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole("heading", { name: "신규 콘솔에서 오류가 발생했습니다." })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toHaveFocus();
    view.rerender(
      <AppErrorBoundary>
        <ThrowingChild />
      </AppErrorBoundary>,
    );
    expect(screen.getByRole("button", { name: "다시 불러오기" })).toHaveFocus();
  });
});
