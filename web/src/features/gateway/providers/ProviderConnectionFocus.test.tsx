import { act, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as GuardModule from "@/shared/unsaved/use-draft-guard";
import { mockApi } from "@/test/api";
import {
  connectionEndpoint,
  connectionOutcome,
  connectionScreen,
  openConnection,
} from "./provider-connection-test-harness";

const settlement = vi.hoisted(() => ({ entered: 0, wait: Promise.resolve() }));
vi.mock("@/shared/unsaved/use-draft-guard", async (importOriginal) => {
  const original = await importOriginal<typeof GuardModule>();
  return {
    ...original,
    useDraftGuard: (...args: Parameters<typeof original.useDraftGuard>) => {
      const guard = original.useDraftGuard(...args);
      return {
        ...guard,
        run: <Result,>(
          operation: () => Promise<Result>,
          onError: (error: unknown) => void,
          onSaved?: (result: Result) => void,
        ) =>
          guard.run(
            async () => {
              const value = await operation();
              // Keep the real guard pending after real RHF validation completes.
              // This controlled scheduling boundary is not browser blur evidence.
              settlement.entered += 1;
              await settlement.wait;
              return value;
            },
            onError,
            onSaved,
          ),
      };
    },
  };
});
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
beforeEach(() => {
  settlement.entered = 0;
});

describe("검증 오류와 제출 가드 해제 사이 입력 초점", () => {
  it.each(["연결 테스트", "저장"])("%s는 첫 오류 입력을 가드 해제 전에도 잠그지 않는다", async (label) => {
    let release: () => void = () => undefined;
    settlement.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const save = vi.fn(async () => undefined);
    const { user } = connectionScreen({ save });
    await openConnection(user);
    const name = screen.getByRole("textbox", { name: "이름" });
    try {
      await user.click(screen.getByRole("button", { name: label }));
      await waitFor(() => expect(settlement.entered).toBe(1));
      expect(screen.getByText("공급자 이름을 입력하세요.")).toBeVisible();
      expect(name).toHaveAttribute("aria-invalid", "true");
      expect(name).toBeEnabled();
      expect(name).toHaveFocus();
      expect(api.bodies(connectionEndpoint)).toHaveLength(0);
      expect(save).not.toHaveBeenCalled();
    } finally {
      await act(async () => release());
    }
    expect(name).toBeEnabled();
    expect(name).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });
});
