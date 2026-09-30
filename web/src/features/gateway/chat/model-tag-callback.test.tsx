import { act, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import type * as FormDialogModule from "@/shared/components/form/FormDialog";
import type * as ConfirmDialogModule from "@/shared/components/ui/ConfirmDialog";
import { describe, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import { edit, modelA, nativeSubmit, review, row, savePath, setup } from "./model-tag-test-harness";

const captured = vi.hoisted(() => ({
  submit: undefined as ((values: unknown) => unknown) | undefined,
  remove: undefined as ((reason: string) => unknown) | undefined,
  form: undefined as ComponentProps<typeof FormDialogModule.FormDialog>["form"] | undefined,
}));
vi.mock("@/shared/components/form/FormDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof FormDialogModule>();
  return {
    ...actual,
    FormDialog: (props: ComponentProps<typeof actual.FormDialog>) => {
      captured.submit = props.onSubmit;
      captured.form = props.form;
      return <actual.FormDialog {...props} />;
    },
  };
});
vi.mock("@/shared/components/ui/ConfirmDialog", async (importOriginal) => {
  const actual = await importOriginal<typeof ConfirmDialogModule>();
  return {
    ...actual,
    ConfirmDialog: (props: ComponentProps<typeof actual.ConfirmDialog>) => {
      captured.remove = props.onConfirm;
      return <actual.ConfirmDialog {...props} />;
    },
  };
});

const values = { model: modelA, good_for: "revised-a", avoid_for: "public-avoid", risk_note: "public-risk" };
describe("모델 태그 렌더된 폼의 캡처 callback 실제 요청 검사", () => {
  for (const change of ["uncheck", "edit-and-restore", "rebase"]) {
    it(`이전 검토 callback도 ${change}로 승인을 폐기한 뒤 POST 0`, async () => {
      const current = await setup();
      const dialog = await edit(current);
      await review(current, dialog);
      const submit = captured.submit;
      if (!submit) throw new Error("no reviewed callback");
      if (change === "uncheck") await current.user.click(within(dialog).getByRole("checkbox"));
      if (change === "edit-and-restore") {
        const input = within(dialog).getByRole("textbox", { name: "적합한 작업" });
        await current.user.type(input, "x");
        await current.user.keyboard("{Backspace}");
        expect(input).toHaveValue("revised-a");
      }
      if (change === "rebase")
        await current.user.click(within(dialog).getByRole("button", { name: "최신 기준 다시 선택" }));
      let rejected = false;
      await act(async () => {
        rejected = await Promise.resolve()
          .then(() => submit(values))
          .then(
            () => false,
            () => true,
          );
      });
      expect.soft(rejected).toBe(true);
      expect(current.api.bodies(savePath)).toHaveLength(0);
    });
  }
  for (const id of [".", ".."]) {
    it(`단독 ${id} ID 삭제는 브라우저 경로 정규화 때문에 UI/직접 callback 모두 DELETE 0`, async () => {
      const current = await setup([row(id, "original-a")]);
      await current.user.click(screen.getByRole("button", { name: "삭제" }));
      const dialog = screen.getByRole("dialog");
      expect.soft(within(dialog).getByRole("button", { name: "삭제" })).toBeDisabled();
      const remove = captured.remove;
      if (!remove) throw new Error("no actual onConfirm callback");
      let rejected = false;
      await act(async () => {
        rejected = await Promise.resolve()
          .then(() => remove(""))
          .then(
            () => false,
            () => true,
          );
      });
      expect.soft(rejected).toBe(true);
      expect(current.api.calls.filter((call) => call.key.startsWith("DELETE"))).toHaveLength(0);
    });
  }
  for (const change of ["readonly", "scope", "epoch", "unmount"]) {
    it(`실제 RHF 검증 완료를 보류한 동안 ${change} 변경 시 검토·POST 0`, async () => {
      const current = await setup();
      const dialog = await edit(current);
      const form = captured.form;
      if (!form) throw new Error("no actual RHF form");
      const original = form.handleSubmit;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const validated = vi.fn();
      form.handleSubmit = (onValid, onInvalid) =>
        original(async (values, event) => {
          validated();
          await gate;
          return onValid(values, event);
        }, onInvalid);
      await current.user.click(within(dialog).getByRole("button", { name: "변경 내용 검토" }));
      expect(validated).toHaveBeenCalledOnce();
      if (change === "readonly") current.update("read_only");
      if (change === "scope") current.update("writable", false);
      if (change === "epoch")
        act(() => {
          tokenStore.clearAll();
        });
      if (change === "unmount") current.view.unmount();
      await act(async () => {
        release();
        await gate;
      });
      expect(screen.queryByRole("heading", { name: "태그 변경 비교" })).not.toBeInTheDocument();
      expect(current.api.bodies(savePath)).toHaveLength(0);
      if (change === "readonly" || change === "scope")
        expect(within(dialog).getByRole("textbox", { name: "적합한 작업" })).toHaveValue("revised-a");
    });
  }
  for (const mode of [
    "readonly",
    "scope",
    "invalidated",
    "changed",
    "deleted",
    "epoch",
    "close",
    "unmount",
  ]) {
    it(`검토한 저장 callback은 ${mode} 후 DOM disabled 우회 호출에도 POST 0`, async () => {
      const current = await setup();
      const dialog = await edit(current);
      await review(current, dialog);
      const submit = captured.submit;
      if (!submit) throw new Error("no actual onSubmit callback");
      if (mode === "readonly") current.update("read_only");
      if (mode === "scope") current.update("writable", false);
      if (mode === "invalidated")
        await act(async () => {
          await current.view.client.invalidateQueries({
            queryKey: ["admin", "model-tags"],
            refetchType: "none",
          });
        });
      if (mode === "changed" || mode === "deleted")
        act(() => {
          current.view.client.setQueriesData(
            { queryKey: ["admin", "model-tags"] },
            { tags: mode === "changed" ? [row(modelA, "concurrent-change")] : [] },
          );
        });
      if (mode === "epoch")
        act(() => {
          tokenStore.clearAll();
        });
      if (mode === "close") {
        await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
        await current.user.click(screen.getByRole("button", { name: "변경 버리기" }));
      }
      if (mode === "unmount") current.view.unmount();
      await act(async () => {
        await expect(Promise.resolve().then(() => submit(values))).rejects.toBeDefined();
      });
      expect(current.api.bodies(savePath)).toHaveLength(0);
    });
  }
  for (const mode of [
    "readonly",
    "scope",
    "invalidated",
    "changed",
    "deleted",
    "epoch",
    "close",
    "unmount",
  ]) {
    it(`고정 삭제 callback은 ${mode} 후 실제 DELETE 0`, async () => {
      const current = await setup();
      const trigger = screen.getAllByRole("button", { name: "삭제" })[0];
      if (!trigger) throw new Error("no delete trigger");
      await current.user.click(trigger);
      const dialog = screen.getByRole("dialog");
      const remove = captured.remove;
      if (!remove) throw new Error("no actual onConfirm callback");
      if (mode === "readonly") current.update("read_only");
      if (mode === "scope") current.update("writable", false);
      if (mode === "invalidated")
        await act(async () => {
          await current.view.client.invalidateQueries({
            queryKey: ["admin", "model-tags"],
            refetchType: "none",
          });
        });
      if (mode === "changed" || mode === "deleted")
        act(() => {
          current.view.client.setQueriesData(
            { queryKey: ["admin", "model-tags"] },
            { tags: mode === "changed" ? [row(modelA, "concurrent-change")] : [] },
          );
        });
      if (mode === "epoch")
        act(() => {
          tokenStore.clearAll();
        });
      if (mode === "close") await current.user.click(within(dialog).getByRole("button", { name: "취소" }));
      if (mode === "unmount") current.view.unmount();
      await act(async () => {
        await expect(Promise.resolve().then(() => remove(""))).rejects.toBeDefined();
      });
      expect(current.api.calls.filter((call) => call.key.startsWith("DELETE"))).toHaveLength(0);
    });
  }
  it("검토 실패/서버 오류에는 재POST하지 않으며 요청 ID를 유지한다", async () => {
    const { AppError } = await import("@/shared/api/error");
    const current = await setup();
    const dialog = await edit(current);
    await review(current, dialog);
    current.response.save = () => {
      throw new AppError("public save failure", { kind: "http", status: 500, requestId: "public-write-id" });
    };
    await nativeSubmit(dialog);
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("public-write-id");
    expect(dialog).toBeInTheDocument();
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
});
