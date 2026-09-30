import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatRunActions } from "./ChatRunActions";
import { downloadMultiRunExport } from "./multi-run-export";
import type * as ExportModule from "./multi-run-export";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authentication = vi.hoisted(() => ({ raw: true, scopes: ["admin:read", "admin:write"] }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authentication.scopes, rawPromptView: authentication.raw }) };
});
vi.mock("./multi-run-export", async (original) => ({
  ...(await original<typeof ExportModule>()),
  downloadMultiRunExport: vi.fn(),
}));
const exporter = vi.mocked(downloadMultiRunExport);
const diff = { answered_models: 1, common_blocks: [], per_model: [], models: [], note: "공개 저장 응답 A" };
const diffPath = (id: string) => `GET /admin/chat-test/multi-run/runs/${id}/diff`;

beforeEach(() => {
  authentication.raw = true;
  authentication.scopes = ["admin:read", "admin:write"];
  tokenStore.clearAll();
  exporter.mockReset();
  exporter.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(respond: () => unknown = () => diff) {
  const api = mockApi({
    [diffPath("run-a")]: respond,
    [diffPath("run-c")]: () => ({ ...diff, note: "공개 저장 응답 C" }),
  });
  type State = { run: string; owner: string; readOnly: boolean; revision: number };
  let update!: (next: Partial<State>) => void;
  function Host() {
    const [state, setState] = useState<State>({
      run: "run-a",
      owner: "gateway.chat",
      readOnly: false,
      revision: 0,
    });
    update = (next) => setState((current) => ({ ...current, ...next }));
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: state.owner, permitted: true, readOnly: state.readOnly }}
      >
        <ChatRunActions
          runId={state.run}
          models={["public-model"]}
          prompt="공개 질문"
          canWrite={authentication.scopes.includes("admin:write")}
          writeDeniedReason="쓰기 권한이 없습니다."
        />
      </FeatureAccessContext.Provider>
    );
  }
  const view = renderScreen(<Host />);
  return { api, view, user: userEvent.setup(), update: (next: Partial<State>) => act(() => update(next)) };
}

describe("실행 후 원문 조회의 호출자 수명", () => {
  it("readonly에서도 기존 원문 권한으로 diff와 export를 허용한다", async () => {
    const current = setup();
    current.update({ readOnly: true });
    await current.user.click(screen.getByRole("button", { name: "답변 비교" }));
    expect(await screen.findByText(/공개 저장 응답 A/u)).toBeInTheDocument();
    expect(current.api.calls).toHaveLength(1);
    await current.user.click(screen.getByRole("button", { name: "서버에서 내보내기" }));
    expect(exporter).toHaveBeenCalledTimes(1);
    expect(exporter.mock.calls[0]?.slice(0, 2)).toEqual(["run-a", "md"]);
    expect(exporter.mock.calls[0]?.[2]?.assertCurrent).toBeTypeOf("function");
  });

  for (const denied of ["scope", "raw", "owner"] as const) {
    it(`${denied} 조건이 없으면 기존 조회 권한을 추가 부여하지 않는다`, async () => {
      const current = setup();
      if (denied === "scope") authentication.scopes = ["admin:write"];
      if (denied === "raw") authentication.raw = false;
      current.update({ revision: 1, ...(denied === "owner" ? { owner: "gateway.models" } : {}) });
      expect(screen.getByRole("button", { name: "답변 비교" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "서버에서 내보내기" })).toBeDisabled();
      expect(current.api.calls).toHaveLength(0);
      expect(exporter).not.toHaveBeenCalled();
    });
  }

  for (const boundary of ["run", "epoch", "owner", "unmount", "raw"] as const) {
    it(`${boundary} 뒤 export callback은 이전 파일의 배달을 허용하지 않는다`, async () => {
      const response = deferred<undefined>();
      exporter.mockImplementation(() => response.promise);
      const current = setup();
      await current.user.click(screen.getByRole("button", { name: "서버에서 내보내기" }));
      const options = exporter.mock.calls[0]?.[2];
      if (!options) throw new Error("missing export ownership guard");
      if (boundary === "run") current.update({ run: "run-c" });
      if (boundary === "epoch") act(() => tokenStore.clearAll());
      if (boundary === "owner") current.update({ owner: "gateway.models" });
      if (boundary === "unmount") current.view.unmount();
      if (boundary === "raw") {
        authentication.raw = false;
        current.update({ revision: 1 });
      }
      // Caller callback proof only; actual post-body download suppression lives
      // in the export helper tests, not this mocked transport.
      expect(() => options.assertCurrent()).toThrow();
      if (boundary !== "raw") expect(options.signal?.aborted).toBe(true);
      await act(async () => {
        response.resolve(undefined);
        await response.promise;
      });
      if (boundary !== "unmount") expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    });
  }

  for (const outcome of ["success", "failure"] as const) {
    it(`실행 C가 보일 때 실행 A의 늦은 diff ${outcome}는 현재 결과를 덮지 않는다`, async () => {
      const response = deferred<unknown>();
      const current = setup(() => response.promise);
      await current.user.click(screen.getByRole("button", { name: "답변 비교" }));
      current.update({ run: "run-c" });
      await current.user.click(screen.getByRole("button", { name: "답변 비교" }));
      expect(await screen.findByText(/공개 저장 응답 C/u)).toBeInTheDocument();
      await act(async () => {
        if (outcome === "success") response.resolve(diff);
        else response.reject(apiFailure("오래된 조회 실패", 503, "public-old-diff"));
        await response.promise.catch(() => undefined);
      });
      expect(screen.getByText(/공개 저장 응답 C/u)).toBeInTheDocument();
      expect(screen.queryByText(/공개 저장 응답 A/u)).not.toBeInTheDocument();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(current.api.calls).toHaveLength(2);
    });
  }
});
