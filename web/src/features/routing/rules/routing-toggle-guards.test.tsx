import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import {
  getToggleToasts,
  initialRule,
  openToggle,
  patchPath,
  setupToggle,
} from "./routing-toggle-test-harness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}
async function rejectCaptured(confirm: (reason: string) => unknown) {
  let error: unknown;
  await act(async () => {
    await Promise.resolve()
      .then(() => confirm(""))
      .catch((cause: unknown) => {
        error = cause;
      });
  });
  expect(error).toBeInstanceOf(AppError);
}

describe("사용 전환의 고정 기준·수동 복구", () => {
  for (const field of ["target_provider", "note"] as const) {
    it(`${field} 변경은 잠기며 안전 표시한 최신 기준의 재확인 후에만 원래 의도를 전송`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      current.records.set(initialRule.id, { ...initialRule, [field]: `public-new-${field}` });
      await current.refetch();
      expect(within(opened.dialog).getByRole("button", { name: "중지" })).toBeDisabled();
      await rejectCaptured(opened.confirm);
      await current.user.click(within(opened.dialog).getByRole("button", { name: "최신 기준 다시 확인" }));
      expect(within(opened.dialog).getByText(`public-new-${field}`)).toBeVisible();
      await rejectCaptured(opened.confirm);
      expect(current.api.bodies(patchPath)).toHaveLength(0);
      await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
      await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
      expect(current.api.bodies(patchPath)).toEqual([{ enabled: false }]);
      expect(current.records.get(initialRule.id)?.[field]).toBe(`public-new-${field}`);
    });
  }
  for (const enabled of [true, false]) {
    it(`최신 목록이 이미 enabled=${String(!enabled)}이면 반대 의도로 재계산하지 않는다`, async () => {
      const current = await setupToggle(enabled);
      const opened = await openToggle(current, enabled);
      current.records.set(initialRule.id, { ...initialRule, enabled: !enabled });
      await current.refetch();
      expect(within(opened.dialog).getByText(/현재 이미/)).toHaveTextContent("창을 닫고 다시 선택하세요");
      expect(within(opened.dialog).getByRole("button", { name: "최신 기준 다시 확인" })).toBeDisabled();
      await rejectCaptured(opened.confirm);
      expect(current.api.bodies(patchPath)).toHaveLength(0);
      expect(current.records.get(initialRule.id)?.enabled).toBe(!enabled);
    });
  }
  for (const mode of ["read_only", "preview_read_only"] as const) {
    it(`${mode} 복구는 원래 확인창·의도 보존, 자동 전송 없이 수동 확인`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      current.update(mode);
      await rejectCaptured(opened.confirm);
      current.update("writable");
      expect(screen.getByRole("dialog")).toBe(opened.dialog);
      expect(current.api.bodies(patchPath)).toHaveLength(0);
      await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
      await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
      expect(current.api.bodies(patchPath)).toEqual([{ enabled: false }]);
      // A permitted follow-up GET can still make the row temporarily disabled.
      await waitFor(() =>
        expect([
          screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 사용" }),
          current.panel,
        ]).toContain(document.activeElement),
      );
    });
  }
  for (const change of ["invalidated", "duplicate", "close", "epoch", "unmount"] as const) {
    it(`${change} 이후 이전 확인 callback은 전송하지 않는다`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      if (change === "invalidated")
        await act(async () => {
          await current.view.client.invalidateQueries({ queryKey: current.queryKey, refetchType: "none" });
        });
      if (change === "duplicate")
        act(() => {
          current.view.client.setQueryData(current.queryKey, { rules: [initialRule, { ...initialRule }] });
        });
      if (change === "close")
        await current.user.click(within(opened.dialog).getByRole("button", { name: "취소" }));
      if (change === "epoch")
        act(() => {
          tokenStore.clearAll();
        });
      if (change === "unmount") current.view.unmount();
      await rejectCaptured(opened.confirm);
      expect(current.api.bodies(patchPath)).toHaveLength(0);
    });
  }
  it("실제 재조회 보류 중에는 확인 잠금, 완료 뒤 확인은 수동", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const read = deferred<{ rules: RoutingRule[] }>();
    current.response.read = () => read.promise;
    await current.user.click(within(opened.dialog).getByRole("button", { name: "목록 다시 조회" }));
    expect(current.view.client.getQueryState(current.queryKey)?.fetchStatus).toBe("fetching");
    await rejectCaptured(opened.confirm);
    expect(current.api.bodies(patchPath)).toHaveLength(0);
    await act(async () => {
      read.resolve({ rules: [initialRule] });
      await read.promise;
    });
    await waitFor(() => expect(within(opened.dialog).getByRole("button", { name: "중지" })).toBeEnabled());
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });
});

describe("전송 중 작업 수명과 성공 이후 조회", () => {
  it("동기 중복 callback은 한 PATCH만 전송한다", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const write = deferred<{ rule: RoutingRule }>();
    current.response.patch = () => write.promise;
    let first!: Promise<unknown>;
    act(() => {
      first = Promise.resolve(opened.confirm(""));
    });
    await waitFor(() => expect(current.api.bodies(patchPath)).toHaveLength(1));
    await rejectCaptured(opened.confirm);
    expect(current.api.bodies(patchPath)).toHaveLength(1);
    await act(async () => {
      write.resolve({ rule: { ...initialRule, enabled: false } });
      await first;
    });
    expect(getToggleToasts().success).toHaveBeenCalledOnce();
  });
  for (const change of ["epoch", "unmount", "read-scope"] as const) {
    for (const result of ["resolve", "reject"] as const) {
      it(`${change} 뒤 이전 PATCH ${result}는 알림·추가 GET을 남기지 않는다`, async () => {
        const current = await setupToggle();
        const opened = await openToggle(current);
        const write = deferred<{ rule: RoutingRule }>();
        current.response.patch = () => write.promise;
        await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
        expect(current.api.bodies(patchPath)).toHaveLength(1);
        if (change === "epoch")
          act(() => {
            tokenStore.clearAll();
          });
        if (change === "unmount") current.view.unmount();
        if (change === "read-scope") current.scopes(["routing:write"]);
        await act(async () => undefined);
        const reads = current.api.calls.filter((call) => call.key.startsWith("GET")).length;
        await act(async () => {
          if (result === "resolve") write.resolve({ rule: { ...initialRule, enabled: false } });
          else write.reject(new AppError("합성 저장 실패", { kind: "http", status: 503 }));
          await write.promise.catch(() => undefined);
        });
        expect(getToggleToasts().success).not.toHaveBeenCalled();
        expect(getToggleToasts().error).not.toHaveBeenCalled();
        expect(current.api.calls.filter((call) => call.key.startsWith("GET"))).toHaveLength(reads);
        expect(screen.queryByText("합성 저장 실패")).not.toBeInTheDocument();
      });
    }
  }
  it("이미 전송한 PATCH 뒤 readonly는 성공을 실패로 재분류하지 않는다", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const write = deferred<{ rule: RoutingRule }>();
    current.response.patch = () => write.promise;
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    current.update("read_only");
    await act(async () => {
      write.resolve({ rule: { ...initialRule, enabled: false } });
      await write.promise;
    });
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    expect(getToggleToasts().success).toHaveBeenCalledOnce();
    expect(getToggleToasts().error).not.toHaveBeenCalled();
    expect(current.api.bodies(patchPath)).toEqual([{ enabled: false }]);
  });
  it("PATCH 성공 뒤 GET 503은 저장 성공 유지·Request ID 표시·재PATCH 없음", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    current.response.read = () => {
      throw new AppError("합성 조회 실패", {
        kind: "http",
        status: 503,
        requestId: "public-after-commit",
      });
    };
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    expect(await screen.findByText(/public-after-commit/)).toBeVisible();
    expect(getToggleToasts().success).toHaveBeenCalledOnce();
    expect(getToggleToasts().error).not.toHaveBeenCalled();
    expect(current.api.bodies(patchPath)).toEqual([{ enabled: false }]);
  });
  it("PATCH 실패는 Request ID를 확인창에 표시하고 자동 재시도하지 않는다", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    current.response.patch = () => {
      throw new AppError("합성 저장 실패", {
        kind: "http",
        status: 503,
        requestId: "public-toggle-write",
      });
    };
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    expect(await within(opened.dialog).findByRole("alert")).toHaveTextContent("public-toggle-write");
    expect(current.api.bodies(patchPath)).toHaveLength(1);
    expect(getToggleToasts().success).not.toHaveBeenCalled();
  });
});

describe("사용 전환 확인의 로컬 초점 복귀", () => {
  it("GET이 보류된 성공 닫기는 panel로 복귀하고 완료 뒤 사용자의 초점을 빼앗지 않는다", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    const read = deferred<{ rules: RoutingRule[] }>();
    current.response.read = () => read.promise;
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    expect(current.view.client.getQueryState(current.queryKey)?.fetchStatus).toBe("fetching");
    await waitFor(() => expect(current.panel).toHaveFocus());
    const chosen = screen.getByRole("button", { name: "새로고침" });
    act(() => {
      chosen.focus();
    });
    await act(async () => {
      read.resolve({ rules: [{ ...initialRule, enabled: false }] });
      await read.promise;
    });
    await waitFor(() =>
      expect(current.view.client.getQueryState(current.queryKey)?.fetchStatus).toBe("idle"),
    );
    expect(chosen).toHaveFocus();
    expect(current.api.bodies(patchPath)).toHaveLength(1);
  });
  for (const reason of ["deleted", "readonly"] as const) {
    it(`${reason} 상태의 취소는 연결되고 focus 가능한 panel로 복귀`, async () => {
      const current = await setupToggle();
      const opened = await openToggle(current);
      if (reason === "deleted") {
        current.records.clear();
        await current.refetch();
      } else current.update("read_only");
      await current.user.click(within(opened.dialog).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(current.panel).toHaveFocus());
      expect(current.api.bodies(patchPath)).toHaveLength(0);
    });
  }
  it("정상 확인 취소는 재렌더로 교체된 동일 원본 규칙의 현재 버튼에 복귀", async () => {
    const current = await setupToggle();
    const opened = await openToggle(current);
    current.update("read_only");
    current.update("writable");
    await current.user.click(within(opened.dialog).getByRole("button", { name: "취소" }));
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "gpt-* → public-model-a 규칙 중지",
        }),
      ).toHaveFocus(),
    );
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });
});

describe("원본 경로와 새 확인창 표시 경계", () => {
  it("빈 패턴은 전체·빈 공급자는 자동 선택으로 표시하되 원문 기준과 enabled-only 본문 유지", async () => {
    const current = await setupToggle(true, true, { match_pattern: "", target_provider: "" });
    const opened = await openToggle(current);
    expect(within(opened.dialog).getByText("전체 (*)")).toBeVisible();
    expect(within(opened.dialog).getByText("자동 선택")).toBeVisible();
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    expect(current.api.bodies(patchPath)).toEqual([{ enabled: false }]);
    expect(current.records.get(initialRule.id)).toMatchObject({ match_pattern: "", target_provider: "" });
  });
  it("표시 기본값은 FEFF 또는 공백 원문을 JS trim으로 재해석하지 않는다", async () => {
    const current = await setupToggle(true, true, { target_provider: "\ufeff ", note: "\npublic-note\n" });
    const opened = await openToggle(current);
    expect(within(opened.dialog).getByText("대상 공급자").nextElementSibling?.textContent).toBe("\ufeff ");
    expect(within(opened.dialog).getByText("메모").nextElementSibling?.textContent).toBe("\npublic-note\n");
    expect(within(opened.dialog).queryByText("자동 선택")).not.toBeInTheDocument();
    expect(current.api.bodies(patchPath)).toHaveLength(0);
  });
  for (const id of ["", ".", "..", "opaque/segment"]) {
    it(`표현 불가 원본 ID ${JSON.stringify(id)}는 사용 전환과 수정 차단`, async () => {
      const current = await setupToggle(true, true, { id });
      const button = screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 중지" });
      expect(button).toBeDisabled();
      expect(screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 수정" })).toBeDisabled();
      expect(current.api.calls.filter((call) => call.key.startsWith("PATCH"))).toHaveLength(0);
    });
  }
  it("원본 FEFF·percent·한글 ID는 trim 없이 정확히 인코딩한 경로에 전송", async () => {
    const current = await setupToggle(true, true, { id: "\ufeffpublic%한글" });
    const opened = await openToggle(current);
    await current.user.click(within(opened.dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(opened.dialog).not.toBeInTheDocument());
    expect(current.api.bodies(current.patchPath)).toEqual([{ enabled: false }]);
    expect(current.patchPath).toBe(`PATCH /admin/routing-rules/${encodeURIComponent("\ufeffpublic%한글")}`);
  });
  it("새 확인창의 runtime prefix 민감값은 표시만 가리고 내부 기준은 원문 유지", async () => {
    const value = `public_rt_${"x".repeat(40)}`;
    const current = await setupToggle(true, true, {
      id: value,
      match_pattern: value,
      target_model: value,
      target_provider: value,
      note: value,
    });
    current.prefixes(["public_rt_"]);
    const masked = "민감정보가 포함될 수 있어 표시하지 않습니다.";
    await current.user.click(screen.getByRole("button", { name: `${masked} → ${masked} 규칙 중지` }));
    const dialog = screen.getByRole("dialog", { name: "라우팅 규칙 중지" });
    expect(within(dialog).getByRole("button", { name: "중지" })).toBeEnabled();
    expect(document.body.outerHTML).not.toContain(value);
    expect(dialog.outerHTML).not.toContain(value);
    expect(within(dialog).getAllByText("민감정보가 포함될 수 있어 표시하지 않습니다.")).toHaveLength(5);
    await current.user.click(within(dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    expect(current.api.bodies(current.patchPath)).toEqual([{ enabled: false }]);
    expect(current.records.get(value)?.target_provider).toBe(value);
  });
});
