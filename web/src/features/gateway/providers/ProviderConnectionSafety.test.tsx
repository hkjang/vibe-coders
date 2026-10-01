import { screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockApi } from "@/test/api";
import { providerImpactFixture } from "./provider-impact-test-fixtures";
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
let api: ReturnType<typeof mockApi>;
beforeEach(() => {
  api = mockApi({
    [connectionEndpoint]: () => connectionOutcome,
    "GET /admin/provider-impact": () => providerImpactFixture(connectionProvider.identity),
  });
});

describe("공급자 저장 전 연결 테스트", () => {
  it("기존 정상 생성 저장은 별도 작업이며 변경되지 않는다", async () => {
    const save = vi.fn(async () => undefined);
    const { user } = connectionScreen({ save });
    await openConnection(user);
    await fillNewConnection(user);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
  it("기존 수정 검토는 즉시 저장하지 않는다", async () => {
    const save = vi.fn(async () => undefined);
    const { user } = connectionScreen({ row: connectionProvider, save });
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(await screen.findByRole("heading", { name: "변경 내용 검토" })).toBeVisible();
    expect(save).not.toHaveBeenCalled();
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
  });
  it("추가 초안을 검사해도 저장·닫기·비밀 복제 없이 dirty를 유지한다", async () => {
    const save = vi.fn(async () => undefined);
    const { user, client } = connectionScreen({ save });
    const dialog = await openConnection(user);
    await fillNewConnection(user);
    await user.type(screen.getByLabelText("API 키"), "public-synthetic-key");
    const probe = screen.getByRole("button", { name: "연결 테스트" });
    expect(probe).toHaveAttribute("type", "button");
    await user.click(probe);
    expect(await screen.findByText("모델 목록 연결을 확인했습니다.")).toBeVisible();
    expect(api.bodies(connectionEndpoint)).toEqual([
      {
        name: "new-provider",
        base_url: "https://public.example/v1",
        credential_mode: "draft",
        api_key: "public-synthetic-key",
      },
    ]);
    expect(save).not.toHaveBeenCalled();
    expect(dialog).toBeVisible();
    expect(screen.getByLabelText("API 키")).toHaveValue("public-synthetic-key");
    expect(dialog.textContent).not.toContain("public-synthetic-key");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
    expect(JSON.stringify(client.getQueryCache().getAll())).not.toContain("public-synthetic-key");
    await user.click(screen.getByRole("button", { name: "취소" }));
    expect(await screen.findByRole("alertdialog")).toBeVisible();
  });
  it("편집의 빈 키는 같은 주소에서만 저장된 키를 사용한다", async () => {
    const { user } = connectionScreen({ row: connectionProvider });
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    expect(api.bodies(connectionEndpoint)).toEqual([
      {
        provider_ref: connectionProvider.identity,
        base_url: "https://public.example/v1",
        credential_mode: "stored",
        timeout_ms: 30000,
      },
    ]);
    expect(screen.queryByRole("heading", { name: "변경 내용 검토" })).not.toBeInTheDocument();
  });
  it("저장된 키를 새 주소로 전송하지 않고 새 키를 요구한다", async () => {
    const { user } = connectionScreen({ row: connectionProvider });
    await openConnection(user);
    const url = screen.getByRole("textbox", { name: "기본 URL" });
    await user.clear(url);
    await user.type(url, "https://other.example/v1");
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(
      await screen.findByText("주소를 변경한 경우 새 API 키를 입력해야 연결을 확인할 수 있습니다."),
    ).toBeVisible();
    expect(screen.getByLabelText("API 키")).toHaveFocus();
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
  });
  it("새 키 없는 초안은 명시적 무인증 동의 후에만 검사한다", async () => {
    const { user } = connectionScreen();
    await openConnection(user);
    await fillNewConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
    await user.click(screen.getByRole("checkbox", { name: /^API 키 없이 확인/u }));
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    expect(api.bodies(connectionEndpoint)).toEqual([
      {
        name: "new-provider",
        base_url: "https://public.example/v1",
        credential_mode: "none",
      },
    ]);
  });
  it("연결 검사도 이름 검증과 첫 오류 초점을 지킨다", async () => {
    const { user } = connectionScreen();
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    expect(await screen.findByText("공급자 이름을 입력하세요.")).toBeVisible();
    expect(screen.getByRole("textbox", { name: "이름" })).toHaveFocus();
    expect(api.bodies(connectionEndpoint)).toHaveLength(0);
  });
  it("성공 후 연결 입력 변경은 이전 결과를 현재 확인으로 표시하지 않는다", async () => {
    const { user } = connectionScreen({ row: connectionProvider });
    await openConnection(user);
    await user.click(screen.getByRole("button", { name: "연결 테스트" }));
    await screen.findByText("모델 목록 연결을 확인했습니다.");
    await user.type(screen.getByLabelText("API 키"), "public-new-key");
    expect(await screen.findByText("연결 입력이 달라졌습니다. 다시 연결 테스트를 실행하세요.")).toBeVisible();
    expect(api.bodies(connectionEndpoint)).toHaveLength(1);
  });
});
