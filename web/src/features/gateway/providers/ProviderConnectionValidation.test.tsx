import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "@/test/api";
import {
  connectionProvider,
  connectionScreen,
  fillNewConnection,
  openConnection,
} from "./provider-connection-test-harness";
import { providerImpactFixture } from "./provider-impact-test-fixtures";
import type * as FormModule from "@/shared/components/form/use-zod-form";

const validation = vi.hoisted(() => ({ hold: false, entered: 0, wait: Promise.resolve() }));
vi.mock("@/shared/components/form/use-zod-form", async (importOriginal) => {
  const original = await importOriginal<typeof FormModule>();
  return {
    ...original,
    useZodForm: (...args: Parameters<typeof original.useZodForm>) =>
      original.useZodForm(
        args[0].refine(async () => {
          if (validation.hold) {
            validation.entered += 1;
            await validation.wait;
          }
          return true;
        }),
        args[1],
      ),
  };
});
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
beforeEach(() => {
  validation.hold = false;
  validation.entered = 0;
  mockApi({ "GET /admin/provider-impact": () => providerImpactFixture(connectionProvider.identity) });
});

describe("실제 RHF 비동기 검증 이후 최신 초안", () => {
  it.each(["create", "edit"])("%s 검증 중 초안 변경은 이전 내용의 저장/검토를 폐기한다", async (mode) => {
    const save = vi.fn(async () => undefined);
    const { user } = connectionScreen({ row: mode === "edit" ? connectionProvider : undefined, save });
    await openConnection(user);
    if (mode === "create") await fillNewConnection(user);
    const field = screen.getByRole("textbox", { name: "모델 패턴" });
    fireEvent.change(field, { target: { value: "before-*" } });
    let release: () => void = () => undefined;
    validation.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    validation.hold = true;
    await user.click(screen.getByRole("button", { name: mode === "create" ? "저장" : "변경 내용 검토" }));
    await waitFor(() => expect(validation.entered).toBeGreaterThan(0));
    expect(field).toBeEnabled();
    fireEvent.change(field, { target: { value: "after-*" } });
    await act(async () => {
      validation.hold = false;
      release();
    });
    expect(save).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "변경 내용 검토" })).not.toBeInTheDocument();
    expect(field).toHaveValue("after-*");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(screen.getByText("검증 중 입력이 달라졌습니다. 현재 내용을 다시 확인하세요.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: mode === "create" ? "저장" : "변경 내용 검토" }));
    if (mode === "create") {
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      expect(save.mock.calls[0]).toEqual([expect.objectContaining({ model_patterns: "after-*" })]);
    } else {
      expect(await screen.findByRole("heading", { name: "변경 내용 검토" })).toBeVisible();
      expect(save).not.toHaveBeenCalled();
    }
  });
});
