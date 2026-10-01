import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";

import {
  changeModel,
  deferred,
  expectNoReplacement,
  getEditToasts,
  listPath,
  openEdit,
  patchPath,
  reviewIfPresent,
  saveEdit,
  setupEdit,
  type EditHarness,
} from "./routing-edit-test-harness";

async function reviewedEdit(current: EditHarness) {
  const { dialog } = await openEdit(current);
  await changeModel(current, dialog);
  await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
  expect(within(dialog).getByRole("heading", { name: "변경 전후" })).toBeVisible();
  expect(within(dialog).getByRole("button", { name: "규칙 저장" })).toBeEnabled();
  return { dialog, save: current.capture("규칙 저장") };
}

describe("기존 라우팅 규칙 수정의 검토·실행 경계", () => {
  it("실제 FeatureRoute와 현재 목록을 거쳐 동일 ID를 한 번 PATCH하며 생성·삭제하지 않는다", async () => {
    const current = await setupEdit();
    expect(current.count(listPath)).toBe(1);
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    await reviewIfPresent(current, dialog);
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    expect(current.calls.find((call) => call.key === patchPath)?.body).toMatchObject({
      target_model: "public-model-b",
    });
    expect(current.records.get(current.rule.id)).toMatchObject({
      id: current.rule.id,
      enabled: true,
      created_at: current.rule.created_at,
    });
    expectNoReplacement(current);
  });

  it("변경 내용 검토는 필수이며 검토만으로 PATCH를 보내지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    const review = within(dialog).getByRole("button", { name: "변경 내용 검토" });
    await current.user.click(review);
    expect(within(dialog).getByRole("heading", { name: "변경 전후" })).toBeVisible();
    expect(current.count(patchPath)).toBe(0);
    expectNoReplacement(current);
  });

  it("변경하지 않은 원본은 PATCH하지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    await reviewIfPresent(current, dialog);
    await saveEdit(current, dialog);
    expect(current.count(patchPath)).toBe(0);
    expect(dialog).toHaveTextContent("변경된 내용이 없습니다.");
  });

  it.each([
    ["쓰기 권한 회수", { scopes: ["routing:read"] }],
    ["서버 읽기 전용 전환", { readOnly: true }],
  ] as const)("창을 연 뒤 %s되면 저장 요청을 보내지 않는다", async (_label, update) => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    await reviewIfPresent(current, dialog);
    current.update("scopes" in update ? { scopes: [...update.scopes] } : { readOnly: update.readOnly });
    await saveEdit(current, dialog);
    expect(current.count(patchPath)).toBe(0);
    expectNoReplacement(current);
  });

  it("저장 직전 서버 원본의 비편집 필드가 바뀌면 덮어쓰지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    await reviewIfPresent(current, dialog);
    current.records.set(current.rule.id, { ...current.rule, enabled: false });
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(listPath)).toBeGreaterThan(1));
    expect(current.count(patchPath)).toBe(0);
    expect(current.records.get(current.rule.id)?.enabled).toBe(false);
  });

  it("불명확한 ACK는 성공으로 닫지 않고 수동 목록 조회만 허용한다", async () => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    await changeModel(current, dialog);
    await reviewIfPresent(current, dialog);
    current.response.patch = () => ({});
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    expect(await screen.findByText("저장 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(dialog).toBeInTheDocument();
    const before = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.count(listPath)).toBeGreaterThan(before));
    expect(current.count(patchPath)).toBe(1);
    expectNoReplacement(current);
  });

  it("실제 목록 Query가 재조회 중이면 이전 행의 수정 진입을 막는다", async () => {
    const current = await setupEdit();
    let release!: (value: unknown) => void;
    current.response.read = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    let fetching!: Promise<unknown>;
    act(() => {
      fetching = current.actualListQuery().fetch();
    });
    await waitFor(() => expect(current.count(listPath)).toBe(2));
    await current.user.click(screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 수정" }));
    expect(screen.queryByRole("dialog", { name: "라우팅 규칙 수정" })).not.toBeInTheDocument();
    await act(async () => {
      release({ rules: [current.rule] });
      await fetching;
    });
    current.response.read = undefined;
    await openEdit(current);
    expect(current.count(patchPath)).toBe(0);
  });
});

describe("라우팅 수정의 요청 수명과 확정 상태", () => {
  it("동일 원본을 수동 조회해도 이전 검토는 비활성화하고 다시 검토한 뒤에만 저장한다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    const reads = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    expect(within(dialog).getByRole("button", { name: "규칙 저장" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    expect(dialog).toHaveTextContent("검토한 목록 기준이 바뀌었습니다. 다시 편집으로 돌아가 검토하세요.");
    expect(current.count(patchPath)).toBe(0);
    await current.user.click(within(dialog).getByRole("button", { name: "다시 편집" }));
    await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
  });

  it("실제 편집 Query가 pending이 된 직후 예전 수동 조회 callback은 GET을 중복하지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await openEdit(current);
    const matches = current.view.client
      .getQueryCache()
      .findAll()
      .filter((query) => query.queryKey[0] === "routing" && query.queryKey[1] === "edit-review");
    expect(matches).toHaveLength(1);
    const own = matches[0];
    if (!own) throw new Error("Actual mounted edit Query missing");
    const firstReads = current.count(listPath);
    await act(async () => {
      await own.fetch();
    });
    expect(current.count(listPath)).toBe(firstReads + 1);
    expect(own.state.status).toBe("success");
    expect(own.state.fetchStatus).toBe("idle");
    const refresh = current.capture("목록 다시 조회");
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const before = current.count(listPath);
    let pending: Promise<unknown> = Promise.resolve();
    await act(async () => {
      pending = own.fetch().catch(() => undefined);
      // Query.fetch mutates the actual cache synchronously. This intentionally
      // invokes the old rendered callback before React receives its notification.
      expect(own.state.fetchStatus).toBe("fetching");
      void refresh();
      await Promise.resolve();
    });
    try {
      expect(current.count(listPath)).toBe(before + 1);
      expect(current.count(patchPath)).toBe(0);
    } finally {
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [current.rule] });
        await pending;
      });
    }
    await waitFor(() => expect(own.state.fetchStatus).toBe("idle"));
    expect(within(dialog).getByRole("button", { name: "변경 내용 검토" })).toBeEnabled();
  });

  it("변경한 필드만 PATCH하고 전송 후 바뀐 비편집 필드 ACK는 정상 성공으로 인정한다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    current.response.patch = (saved) => {
      const concurrent = { ...saved, enabled: false, note: "다른 운영자의 메모" };
      current.records.set(saved.id, concurrent);
      return { rule: concurrent };
    };
    await saveEdit(current, dialog);
    expect(await screen.findByText("라우팅 규칙을 저장했습니다.")).toBeVisible();
    expect(current.calls.find((call) => call.key === patchPath)?.body).toEqual({
      target_model: "public-model-b",
    });
    expect(screen.queryByText("저장 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expectNoReplacement(current);
  });

  it("저장 직전 GET이 보류된 동안 캡처한 저장을 연속 호출해도 PATCH는 한 번이다", async () => {
    const current = await setupEdit();
    const { save } = await reviewedEdit(current);
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const reads = current.count(listPath);
    act(() => {
      void save();
      void save();
    });
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    expect(current.count(patchPath)).toBe(0);
    current.response.read = undefined;
    await act(async () => {
      held.resolve({ rules: [current.rule] });
    });
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    expectNoReplacement(current);
  });

  it.each(["write", "readonly"] as const)(
    "%s 회수 후 복구해도 예전 검토 callback은 부활하지 않는다",
    async (boundary) => {
      const current = await setupEdit();
      const { save } = await reviewedEdit(current);
      if (boundary === "write") current.update({ scopes: ["routing:read"] });
      else current.update({ readOnly: true });
      current.update({ scopes: ["routing:read", "routing:write"], readOnly: false });
      await act(async () => {
        await save();
      });
      expect(current.count(patchPath)).toBe(0);
      expectNoReplacement(current);
    },
  );

  it("다시 편집한 뒤 예전 검토 callback은 이전 값을 저장하지 않는다", async () => {
    const current = await setupEdit();
    const { dialog, save } = await reviewedEdit(current);
    await current.user.click(within(dialog).getByRole("button", { name: "다시 편집" }));
    await current.user.type(within(dialog).getByRole("textbox", { name: "대상 모델" }), "-new");
    await act(async () => {
      await save();
    });
    expect(current.count(patchPath)).toBe(0);
    expect(within(dialog).getByRole("textbox", { name: "대상 모델" })).toHaveValue("public-model-b-new");
  });

  it.each(["owner", "principal", "session"] as const)(
    "보류된 저장 전 조회의 %s 수명을 폐기하면 늦은 결과는 PATCH하지 않는다",
    async (boundary) => {
      const current = await setupEdit();
      const { save } = await reviewedEdit(current);
      const held = deferred<unknown>();
      current.response.read = () => held.promise;
      const reads = current.count(listPath);
      act(() => {
        void save();
      });
      await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
      if (boundary === "owner") {
        current.update({ owner: "routing.other" });
        current.update({ owner: "routing.rules" });
      } else if (boundary === "principal") {
        current.update({ userId: "operator-b" });
        current.update({ userId: "operator-a" });
      } else act(() => tokenStore.clearAll());
      current.response.read = undefined;
      await act(async () => {
        held.resolve({ rules: [current.rule] });
      });
      expect(current.count(patchPath)).toBe(0);
      expect(getEditToasts().success).not.toHaveBeenCalled();
    },
  );

  it("확정 ACK 뒤 목록 GET 실패는 저장 실패나 재전송으로 바뀌지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    current.response.patch = (saved) => {
      current.response.read = () => {
        throw new AppError("합성 조회 실패", { kind: "http", status: 503 });
      };
      return { rule: saved };
    };
    await saveEdit(current, dialog);
    expect(await screen.findByText("저장은 완료했지만 목록을 다시 조회하지 못했습니다.")).toBeVisible();
    expect(current.count(patchPath)).toBe(1);
    expect(screen.queryByText("저장 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    current.response.read = undefined;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(within(dialog).getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-busy",
        "false",
      ),
    );
    await waitFor(() =>
      expect(
        screen.queryByText("저장은 완료했지만 목록을 다시 조회하지 못했습니다."),
      ).not.toBeInTheDocument(),
    );
    expect(current.count(patchPath)).toBe(1);
  });

  it("PATCH 뒤 시작한 실제 목록의 오래된 GET은 확정 후 새 목록을 덮어쓰지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    const ack = deferred<unknown>();
    current.response.patch = () => ack.promise;
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    const parent = current.actualListQuery();
    const oldRead = deferred<unknown>();
    current.response.read = () => oldRead.promise;
    const reads = current.count(listPath);
    let oldFetch: Promise<unknown> = Promise.resolve();
    act(() => {
      oldFetch = parent.fetch().catch(() => undefined);
    });
    await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
    expect(parent.state.fetchStatus).toBe("fetching");
    current.response.read = undefined;
    await act(async () => {
      ack.resolve({ rule: current.records.get(current.rule.id) });
    });
    await waitFor(() =>
      expect(parent.state.data).toMatchObject({ rules: [{ target_model: "public-model-b" }] }),
    );
    await act(async () => {
      oldRead.resolve({ rules: [current.rule] });
      await oldFetch;
    });
    expect(parent.state.data).toMatchObject({ rules: [{ target_model: "public-model-b" }] });
    expect(current.count(patchPath)).toBe(1);
  });

  it("전송 뒤 쓰기 권한만 회수되어도 유효 ACK는 저장 완료로 남는다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    const ack = deferred<unknown>();
    current.response.patch = () => ack.promise;
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    current.update({ scopes: ["routing:read"] });
    await act(async () => {
      ack.resolve({ rule: current.records.get(current.rule.id) });
    });
    expect(await screen.findByText("라우팅 규칙을 저장했습니다.")).toBeVisible();
    expect(screen.queryByText("저장 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(current.count(patchPath)).toBe(1);
  });

  it("전송 뒤 창 수명이 끝나면 늦은 ACK는 새 GET·캐시 게시·성공 알림을 만들지 않는다", async () => {
    const current = await setupEdit();
    const { dialog } = await reviewedEdit(current);
    const ack = deferred<unknown>();
    current.response.patch = () => ack.promise;
    await saveEdit(current, dialog);
    await waitFor(() => expect(current.count(patchPath)).toBe(1));
    const parent = current.actualListQuery();
    const before = parent.state.data;
    const reads = current.count(listPath);
    current.view.unmount();
    await act(async () => {
      ack.resolve({ rule: current.records.get(current.rule.id) });
    });
    expect(current.count(listPath)).toBe(reads);
    expect(parent.state.data).toBe(before);
    expect(getEditToasts().success).not.toHaveBeenCalled();
  });

  it.each(["same", "failed"] as const)(
    "불명확 ACK 뒤 %s 수동 조회도 같은 창의 저장 잠금을 해제하지 않는다",
    async (outcome) => {
      const current = await setupEdit();
      const { dialog, save } = await reviewedEdit(current);
      current.response.patch = () => {
        current.records.set(current.rule.id, current.rule);
        return {};
      };
      await saveEdit(current, dialog);
      expect(await screen.findByText("저장 여부를 확인하지 못했습니다.")).toBeVisible();
      if (outcome === "failed")
        current.response.read = () => {
          throw new AppError("조회 불가", { kind: "http", status: 503 });
        };
      const reads = current.count(listPath);
      await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
      await waitFor(() => expect(current.count(listPath)).toBe(reads + 1));
      // Wait for the read to settle: flight pending must not accidentally prove
      // the distinct permanent sent-unconfirmed guard.
      await waitFor(() =>
        expect(within(dialog).getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
          "aria-busy",
          "false",
        ),
      );
      await act(async () => {
        await save();
      });
      expect(current.count(patchPath)).toBe(1);
      expect(dialog).toHaveTextContent("이 창에서는 다시 저장하지 않습니다.");
    },
  );

  it("엄격한 최초 GET의 누락 필드는 기본값으로 검토하거나 저장하지 않는다", async () => {
    const current = await setupEdit();
    const incomplete: Partial<typeof current.rule> = { ...current.rule };
    delete incomplete.note;
    current.response.read = () => ({ rules: [incomplete] });
    await current.user.click(screen.getByRole("button", { name: "gpt-* → public-model-a 규칙 수정" }));
    const dialog = await screen.findByRole("dialog", { name: "라우팅 규칙 수정" });
    await waitFor(() => expect(current.count(listPath)).toBeGreaterThan(1));
    await waitFor(() =>
      expect(within(dialog).queryByText("원본 규칙을 확인하고 있습니다.")).not.toBeInTheDocument(),
    );
    expect(within(dialog).queryByRole("button", { name: "규칙 저장" })).not.toBeInTheDocument();
    expect(current.count(patchPath)).toBe(0);
  });
});
