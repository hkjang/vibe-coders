import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import { FeatureAccessContext } from "@/shared/feature-access/context";

import { generateGatewaySecret, rotationRefused, secretDraftError } from "./secret-rotation";
import { SecretRotationPage } from "./SecretRotationPage";

const secret = "synthetic-rotation-secret-0123456789";

let scopes = ["admin:read", "admin:write"];
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({ mode: "authenticated", user: { scopes } }),
}));

function renderTab(hasAdminWrite = true, readOnly = false) {
  scopes = hasAdminWrite ? ["admin:read", "admin:write"] : ["admin:read"];
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <FeatureAccessContext.Provider value={{ featureId: "system.secrets", permitted: true, readOnly }}>
          <SecretRotationPage />
        </FeatureAccessContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const keyInputs = () =>
  (screen.getAllByLabelText(/새 비밀키/u) as HTMLInputElement[]).filter(
    (element) => element.tagName === "INPUT" && element.type !== "checkbox",
  );

function fillDraft(value = secret) {
  for (const box of screen.getAllByRole("checkbox")) fireEvent.click(box);
  fireEvent.change(keyInputs()[0] as HTMLElement, { target: { value } });
  fireEvent.change(keyInputs()[1] as HTMLElement, { target: { value } });
}

async function confirmRotation() {
  fireEvent.click(screen.getByRole("button", { name: "비밀키 교체 실행" }));
  const dialog = await screen.findByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "교체 실행" });
  expect(confirm).toBeDisabled();
  fireEvent.change(within(dialog).getByRole("textbox"), { target: { value: "비밀키 교체" } });
  await waitFor(() => expect(confirm).toBeEnabled());
  fireEvent.click(confirm);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("secretDraftError", () => {
  it("requires a long enough key entered twice the same", () => {
    expect(secretDraftError("", "")).toBe("새 비밀키를 입력하세요.");
    expect(secretDraftError("short", "short")).toContain("16자 이상");
    expect(secretDraftError(secret, "")).toContain("한 번 더");
    expect(secretDraftError(secret, `${secret}x`)).toContain("서로 다릅니다");
    expect(secretDraftError(secret, secret)).toBeUndefined();
    expect(secretDraftError(`  ${secret} `, secret)).toBeUndefined();
  });

  it("counts length after trimming, as the server does", () => {
    const padded = `   ${"a".repeat(10)}      `;
    expect(secretDraftError(padded, padded)).toContain("16자 이상");
  });
});

describe("generateGatewaySecret", () => {
  it("makes distinct 256-bit hex keys", () => {
    const first = generateGatewaySecret();
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(generateGatewaySecret()).not.toBe(first);
  });
});

describe("rotationRefused", () => {
  it("treats only a definite refusal as nothing having changed", () => {
    expect(rotationRefused(new AppError("x", { kind: "http", status: 400, code: "weak_secret" }))).toBe(true);
    expect(rotationRefused(new AppError("x", { kind: "http", status: 409 }))).toBe(true);
    expect(rotationRefused(new AppError("x", { kind: "auth", status: 401 }))).toBe(true);
    expect(rotationRefused(new AppError("x", { kind: "permission", status: 403 }))).toBe(true);
    expect(rotationRefused(new AppError("x", { kind: "http", status: 500 }))).toBe(false);
    expect(rotationRefused(new AppError("x", { kind: "network" }))).toBe(false);
    expect(rotationRefused(new AppError("x", { kind: "timeout" }))).toBe(false);
    expect(rotationRefused(new AppError("x", { kind: "contract" }))).toBe(false);
    expect(rotationRefused(new Error("x"))).toBe(false);
  });
});

describe("SecretRotationPage", () => {
  it("stays locked until every precondition and the repeated key are in place", () => {
    renderTab();
    const run = screen.getByRole("button", { name: "비밀키 교체 실행" });
    expect(run).toBeDisabled();
    fireEvent.change(keyInputs()[0] as HTMLElement, { target: { value: secret } });
    fireEvent.change(keyInputs()[1] as HTMLElement, { target: { value: secret } });
    expect(run).toBeDisabled();
    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(4);
    for (const box of boxes.slice(0, 3)) fireEvent.click(box);
    expect(run).toBeDisabled();
    fireEvent.click(boxes[3] as HTMLElement);
    expect(run).toBeEnabled();
  });

  it("cannot run without write access or in read-only mode", () => {
    renderTab(false);
    fillDraft();
    expect(screen.getByRole("button", { name: "비밀키 교체 실행" })).toBeDisabled();
    expect(screen.getByText(/admin:write 권한/u)).toBeVisible();
    cleanup();
    renderTab(true, true);
    fillDraft();
    expect(screen.getByRole("button", { name: "비밀키 교체 실행" })).toBeDisabled();
  });

  it("sends once without auth replay, reports the rows and forgets the key", async () => {
    const request = vi.spyOn(apiClient, "request").mockResolvedValue({
      status: "ok",
      rotated: { provider_configs: 3, sso_provider_config: 1 },
    } as never);
    renderTab();
    fillDraft();
    await confirmRotation();

    expect(await screen.findByText("저장된 비밀값을 새 키로 다시 암호화했습니다.")).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]?.[1]).toMatchObject({
      body: { new_secret: secret },
      retryUnauthorized: false,
    });
    const table = screen.getByRole("table");
    expect(within(table).getByRole("row", { name: /공급자 API 키 3/u })).toBeVisible();
    expect(within(table).getByRole("row", { name: /MCP 인증값 0/u })).toBeVisible();
    expect(screen.getByText(/GATEWAY_SECRET을 새 키로/u)).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "처음 화면으로" }));
    expect(keyInputs()[0]).toHaveValue("");
    expect(document.body.textContent).not.toContain(secret);
    for (const box of screen.getAllByRole("checkbox")) expect(box).not.toBeChecked();
  });

  it.each([
    ["a lost connection", new AppError("x", { kind: "network" })],
    ["a timeout", new AppError("x", { kind: "timeout" })],
    ["a server failure", new AppError("x", { kind: "http", status: 500, code: "rotation_failed" })],
    ["an unreadable success", new AppError("x", { kind: "contract" })],
  ])("treats %s as an unknown outcome and does not retry", async (_name, failure) => {
    const request = vi.spyOn(apiClient, "request").mockRejectedValue(failure);
    renderTab();
    fillDraft();
    await confirmRotation();

    expect(await screen.findByText("교체 결과를 확인할 수 없습니다. 다시 실행하지 마세요.")).toBeVisible();
    expect(request).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).not.toContain(secret);
    expect(screen.queryByRole("button", { name: "비밀키 교체 실행" })).not.toBeInTheDocument();
  });

  it("keeps the draft after a definite refusal so the operator can correct it", async () => {
    vi.spyOn(apiClient, "request").mockRejectedValue(
      new AppError("x", { kind: "http", status: 400, code: "dev_secret_rejected" }),
    );
    renderTab();
    fillDraft();
    await confirmRotation();

    expect(await screen.findByText(/개발용 기본값은 비밀키로 쓸 수 없습니다/u)).toBeVisible();
    expect(
      screen.queryByText("교체 결과를 확인할 수 없습니다. 다시 실행하지 마세요."),
    ).not.toBeInTheDocument();
    expect(keyInputs()[0]).toHaveValue(secret);
  });

  it("does not put a generated key anywhere but the form", () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: "무작위 값 만들기" }));
    const value = keyInputs()[0]?.value ?? "";
    expect(value).toMatch(/^[0-9a-f]{64}$/u);
    expect(window.location.href).not.toContain(value);
    expect(JSON.stringify({ ...localStorage })).not.toContain(value);
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(value);
  });
});
