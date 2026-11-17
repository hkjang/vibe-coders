import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../../index.html?raw";
import { startConsole } from "./startup-recovery";

beforeEach(() => {
  document.body.innerHTML = new DOMParser().parseFromString(indexHtml, "text/html").body.innerHTML;
});
afterEach(() => document.body.replaceChildren());

describe("startup recovery before the React/authentication runtime", () => {
  it("keeps an accessible fixed local recovery action while startup is pending", async () => {
    let finish: (() => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = startConsole(load);
    expect(screen.getByRole("heading", { name: "신규 콘솔을 준비하고 있습니다." })).toBeVisible();
    expect(screen.getByRole("link", { name: "콘솔 처음 화면 열기" })).toHaveAttribute("href", "/app/");
    expect(screen.queryByRole("button", { name: "현재 주소로 다시 시도" })).not.toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(1);
    finish?.();
    await pending;
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports a module error without leaking its details and reloads only after an explicit action", async () => {
    const secret = "SYNTHETIC_PRIVATE_STARTUP_FAILURE";
    const reload = vi.fn();
    const load = vi.fn(async () => {
      throw new Error(secret);
    });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await startConsole(load, reload);
    expect(screen.getByRole("alert")).toHaveTextContent("신규 콘솔을 불러오지 못했습니다.");
    expect(screen.getByRole("heading", { name: "신규 콘솔을 불러오지 못했습니다." })).toHaveFocus();
    expect(document.body.innerHTML).not.toContain(secret);
    expect(log).not.toHaveBeenCalled();
    expect(document.querySelector('a[href="/admin"]')).not.toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    const retry = screen.getByRole("button", { name: "현재 주소로 다시 시도" });
    await userEvent.click(retry);
    await userEvent.click(retry);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(retry).toBeDisabled();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("preserves keyboard focus that already reached the static link during loading", async () => {
    let fail: ((error: Error) => void) | undefined;
    const pending = startConsole(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    const link = screen.getByRole("link", { name: "콘솔 처음 화면 열기" });
    link.focus();
    fail?.(new Error("synthetic module failure"));
    await pending;
    expect(link).toHaveFocus();
    expect(screen.getByRole("alert")).toBeVisible();
  });

  it("does not overwrite a runtime-owned screen if it was already mounted", async () => {
    await startConsole(async () => {
      document.body.innerHTML = "<main><h1>인증 오류 안내</h1></main>";
      throw new Error("already mounted");
    });
    expect(screen.getByRole("heading", { name: "인증 오류 안내" })).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
