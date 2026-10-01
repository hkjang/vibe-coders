import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { mockApi, apiFailure } from "@/test/api";
import { AppError } from "@/shared/api/error";
import {
  connectionEndpoint,
  connectionOutcome,
  connectionProvider,
  connectionScreen,
  fillNewConnection,
  openConnection,
} from "./provider-connection-test-harness";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: ["admin:read", "admin:write"] }) };
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function formOf(element: HTMLElement): HTMLFormElement {
  const form = element.closest("form");
  if (!form) throw new Error("missing provider form");
  return form;
}

describe("연결 테스트와 저장의 별도 의도", () => {
  it("검사 pending의 실제 클릭 반복/원래 submit/닫힘은 중복 검사·저장하지 않는다", async () => {
    const gate = deferred<typeof connectionOutcome>();
    const api = mockApi({ [connectionEndpoint]: () => gate.promise });
    const save = vi.fn(async () => undefined);
    const { user } = connectionScreen({ row: connectionProvider, save });
    const dialog = await openConnection(user);
    const probe = screen.getByRole("button", { name: "연결 테스트" });
    const url = screen.getByRole("textbox", { name: "기본 URL" });
    await user.click(probe);
    await waitFor(() => expect(api.bodies(connectionEndpoint)).toHaveLength(1));
    expect(probe).toHaveAttribute("aria-disabled", "true");
    expect(probe).not.toBeDisabled();
    expect(probe).toHaveFocus();
    expect(url).toBeDisabled();
    await user.click(probe);
    await user.keyboard("{Enter}");
    fireEvent.submit(formOf(url));
    await user.keyboard("{Escape}");
    expect(dialog).toBeVisible();
    expect(url).toBeDisabled();
    expect(probe).toHaveTextContent("연결 확인 중");
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
    expect(save).not.toHaveBeenCalled();
    await act(async () => gate.resolve(connectionOutcome));
    expect(await screen.findByText("모델 목록 연결을 확인했습니다.")).toBeVisible();
    expect(probe).toHaveFocus();
    expect(url).toBeEnabled();
    expect(save).not.toHaveBeenCalled();
  });
  it("생성 저장 pending이면 연결 검사는 전송하지 않으며 완료 후 trigger로 돌아간다", async () => {
    const gate = deferred<undefined>();
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const save = vi.fn(() => gate.promise);
    const { user } = connectionScreen({ save });
    await openConnection(user);
    await fillNewConnection(user);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
    expect(screen.getByRole("textbox", { name: "이름" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    await act(async () => gate.resolve(undefined));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "열기" })).toHaveFocus());
  });
  it("같은 입력 재검사 실패는 예전 성공을 현재 성공으로 함께 표시하지 않는다", async () => {
    let count = 0;
    const api = mockApi({
      [connectionEndpoint]: () => {
        count += 1;
        if (count === 2) throw apiFailure("private upstream body", 503, "req_public_probe");
        return connectionOutcome;
      },
    });
    const { user } = connectionScreen({ row: connectionProvider });
    const dialog = await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(await screen.findByText("연결 테스트를 실행하지 못했습니다.")).toBeVisible();
    expect(screen.queryByText("모델 목록 연결을 확인했습니다.")).not.toBeInTheDocument();
    expect(dialog).not.toHaveTextContent("private upstream body");
    expect(dialog).toHaveTextContent("req_public_probe");
    expect(api.bodies(connectionEndpoint)).toHaveLength(2);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    expect(api.bodies(connectionEndpoint)).toHaveLength(3);
  });
  it("새 이름 충돌은 안전한 안내만 보여주고 저장하지 않는다", async () => {
    const save = vi.fn(async () => undefined);
    mockApi({
      [connectionEndpoint]: () => {
        throw new AppError("raw user name/key", {
          kind: "http",
          status: 409,
          code: "provider_already_exists",
          requestId: "req_public_conflict",
        });
      },
    });
    const { user } = connectionScreen({ save });
    const dialog = await openConnection(user);
    await fillNewConnection(user);
    await user.click(screen.getByRole("checkbox", { name: /^API 키 없이 확인/u }));
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(
      await screen.findByText(
        "같은 이름의 공급자가 이미 있습니다. 목록을 확인하고 수정 화면에서 검사하세요.",
      ),
    ).toBeVisible();
    expect(dialog).not.toHaveTextContent("raw user name/key");
    expect(save).not.toHaveBeenCalled();
  });
  it("공급자 인증 거부는 연결 결과이며 사용자 재시도 전 자동으로 새 요청하지 않는다", async () => {
    const api = mockApi({
      [connectionEndpoint]: () => ({
        ...connectionOutcome,
        outcome: "authentication_rejected",
        upstream_status: 401,
        model_count: null,
      }),
    });
    const { user } = connectionScreen({ row: connectionProvider });
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(await screen.findByText("공급자가 인증을 거부했습니다.")).toBeVisible();
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
    expect(screen.getByRole("region", { name: "저장 전 연결 테스트 결과" })).toHaveTextContent("401");
  });
  it("무인증 동의 뒤 주소 변경은 동의를 폐기한다", async () => {
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const { user } = connectionScreen();
    await openConnection(user);
    await fillNewConnection(user);
    const ack = screen.getByRole("checkbox", { name: /^API 키 없이 확인/u });
    await user.click(ack);
    await user.type(screen.getByRole("textbox", { name: "기본 URL" }), "/other");
    expect(ack).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    expect(await screen.findByText("API 키를 입력하거나 ‘API 키 없이 확인’에 동의하세요.")).toBeVisible();
  });
  it("비연결 필드 변경은 현재 연결 결과를 복제하거나 자동 검사하지 않는다", async () => {
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const { user } = connectionScreen({ row: connectionProvider });
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    await user.type(screen.getByRole("textbox", { name: "모델 패턴" }), ",other-*");
    expect(
      screen.queryByText("연결 입력이 달라졌습니다. 다시 연결 테스트를 실행하세요."),
    ).not.toBeInTheDocument();
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
  });
  it("현재 접두사의 민감한 요청 ID와 upstream 원문은 출력하지 않는다", async () => {
    mockApi({
      [connectionEndpoint]: () => {
        throw apiFailure("raw provider payload", 503, `corp_${"A".repeat(32)}`);
      },
    });
    const { user } = connectionScreen({ row: connectionProvider, credentialPrefixes: ["corp_"] });
    const dialog = await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("연결 테스트를 실행하지 못했습니다.");
    expect(dialog.innerHTML).not.toContain("A".repeat(32));
    expect(dialog).not.toHaveTextContent("raw provider payload");
  });
  it("runtime readonly는 열린 초안을 보존하고 복구 후 수동 실행만 허용한다", async () => {
    const api = mockApi({ [connectionEndpoint]: () => connectionOutcome });
    const { user } = connectionScreen({ row: connectionProvider });
    const dialog = await openConnection(user);
    await user.type(screen.getByLabelText("API 키"), "public-unsaved-key");
    fireEvent.click(screen.getByRole("button", { name: "읽기 전용 전환", hidden: true }));
    const probe = within(dialog).getByRole("button", { name: "연결 테스트" });
    expect(probe).toHaveAttribute("aria-disabled", "true");
    await user.click(probe);
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    expect(screen.getByLabelText("API 키")).toHaveValue("public-unsaved-key");
    fireEvent.click(screen.getByRole("button", { name: "읽기 전용 전환", hidden: true }));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    await user.click(probe);
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
  });
});
