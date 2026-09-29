import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { StrictMode, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import { AppError } from "@/shared/api/error";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

interface Values {
  name: string;
  secret: string;
  url: string;
  kind: string;
  enabled: boolean;
}

function FormHarness({
  onSave = () => undefined,
  title = "테스트 편집",
  initialOpen = false,
}: {
  onSave?: (values: Values) => unknown | Promise<unknown>;
  title?: string;
  initialOpen?: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(initialOpen);
  const trigger = useRef<HTMLButtonElement>(null);
  const form = useForm<Values>({
    defaultValues: { name: "", secret: "", url: "", kind: "first", enabled: false },
  });
  return (
    <>
      <button
        ref={trigger}
        onClick={() => {
          form.reset();
          setOpen(true);
        }}
      >
        {title} 열기
      </button>
      <FormDialog
        title={title}
        description="테스트 입력 폼"
        form={form}
        open={open}
        onOpenChange={setOpen}
        onSubmit={onSave}
        returnFocusRef={trigger}
      >
        <label>
          이름
          <input {...form.register("name", { required: "이름을 입력해 주세요." })} />
        </label>
        {form.formState.errors.name ? <p role="alert">{form.formState.errors.name.message}</p> : null}
        <label>
          비밀값
          <input type="password" {...form.register("secret")} />
        </label>
        <label>
          기본 URL
          <input type="url" {...form.register("url")} />
        </label>
        <label>
          유형
          <select {...form.register("kind")}>
            <option value="first">첫 유형</option>
            <option value="second">둘째 유형</option>
          </select>
        </label>
        <label>
          사용
          <input type="checkbox" {...form.register("enabled")} />
        </label>
        <button type="button" onClick={() => form.setValue("name", "예시 단계", { shouldDirty: true })}>
          예시 단계 추가
        </button>
      </FormDialog>
    </>
  );
}

function deferredSave() {
  let resolve: () => void = () => {
    throw new Error("not initialized");
  };
  let reject: (error: unknown) => void = () => {
    throw new Error("not initialized");
  };
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

async function openDirtyForm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
  const input = screen.getByRole("textbox", { name: "이름" });
  await user.type(input, "새 초안");
  return input;
}

function unload(): Event {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event;
}

describe("FormDialog unsaved changes", () => {
  it("works under the existing declarative MemoryRouter and closes pristine forms without a warning", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <FormHarness />
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "테스트 편집 열기" })).toHaveFocus();
    expect(unload().defaultPrevented).toBe(false);
  });

  it.each(["escape", "cancel", "close", "overlay"])(
    "protects a dirty form on %s, preserves the draft and restores focus",
    async (action) => {
      const user = userEvent.setup();
      render(
        <main id="main-content" tabIndex={-1}>
          <FormHarness />
        </main>,
      );
      const input = await openDirtyForm(user);
      if (action === "escape") await user.keyboard("{Escape}");
      else if (action === "overlay") {
        const overlay = document.querySelector<HTMLElement>(".dialog-overlay");
        expect(overlay).not.toBeNull();
        // Real browsers blur the input on the non-focusable overlay first.
        act(() => input.blur());
        if (overlay) await user.click(overlay);
      } else
        await user.click(
          screen.getByRole("button", { name: action === "cancel" ? "취소" : "대화상자 닫기" }),
        );
      const prompt = screen.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
      expect(within(prompt).getByRole("button", { name: "계속 편집" })).toHaveFocus();
      await user.click(within(prompt).getByRole("button", { name: "계속 편집" }));
      expect(input).toHaveValue("새 초안");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      if (action === "escape" || action === "overlay") expect(input).toHaveFocus();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "변경 버리기" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "테스트 편집 열기" })).toHaveFocus();
      expect(unload().defaultPrevented).toBe(false);
    },
  );

  it("treats Escape on the confirmation as keep editing and never exposes or persists the draft", async () => {
    const user = userEvent.setup();
    render(<FormHarness />);
    await openDirtyForm(user);
    const secret = screen.getByLabelText("비밀값");
    await user.type(secret, "private-key-never-store");
    expect(unload().defaultPrevented).toBe(true);
    await user.keyboard("{Escape}");
    const prompt = screen.getByRole("alertdialog");
    expect(prompt).not.toHaveTextContent("private-key-never-store");
    expect((await axe.run(document.body)).violations).toEqual([]);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(secret).toHaveValue("private-key-never-store");
    expect(secret).toHaveFocus();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it("does not warn after values are restored to their defaults", async () => {
    const user = userEvent.setup();
    render(<FormHarness />);
    const input = await openDirtyForm(user);
    await user.clear(input);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("unlocks and focuses the first invalid field after validation without sending a request", async () => {
    const user = userEvent.setup();
    const save = vi.fn();
    render(<FormHarness onSave={save} />);
    await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
    const name = screen.getByRole("textbox", { name: "이름" });
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("이름을 입력해 주세요.");
    await waitFor(() => expect(name).toHaveFocus());
    expect(name).toBeEnabled();
    expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "취소" })).toBeEnabled();
    expect(save).not.toHaveBeenCalled();
    expect(unload().defaultPrevented).toBe(false);
    await user.type(name, "검증 후 편집");
    expect(name).toHaveValue("검증 후 편집");
  });

  it("blocks same-tick duplicate submits and all close attempts while saving, then closes without warning", async () => {
    const user = userEvent.setup();
    const pending = deferredSave();
    const save = vi.fn(() => pending.promise);
    render(<FormHarness onSave={save} />);
    await openDirtyForm(user);
    const form = document.querySelector("form");
    expect(form).not.toBeNull();
    act(() => {
      if (form) {
        fireEvent.submit(form);
        fireEvent.submit(form);
      }
    });
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "대화상자 닫기" }));
    expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(unload().defaultPrevented).toBe(true);
    await act(async () => pending.resolve());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(unload().defaultPrevented).toBe(false);
  });

  it("retains failed drafts and requires confirmation before abandoning them", async () => {
    const user = userEvent.setup();
    const save = vi
      .fn()
      .mockRejectedValue(
        new AppError("untrusted detail", { kind: "http", status: 503, requestId: "req-save" }),
      );
    render(<FormHarness onSave={save} />);
    const input = await openDirtyForm(user);
    await user.click(screen.getByRole("button", { name: "저장" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("req-save");
    expect(input).toHaveValue("새 초안");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("alertdialog")).toBeVisible();
    expect(save).toHaveBeenCalledTimes(1);
  });

  it.each(["resolve", "reject"])(
    "locks native inputs and builder buttons while saving without dropping payload values, then unlocks on %s",
    async (outcome) => {
      const user = userEvent.setup();
      const pending = deferredSave();
      const save = vi.fn<(values: Values) => Promise<void>>().mockReturnValue(pending.promise);
      render(<FormHarness onSave={save} />);
      const name = await openDirtyForm(user);
      const secret = screen.getByLabelText("비밀값");
      const url = screen.getByRole("textbox", { name: "기본 URL" });
      const kind = screen.getByRole("combobox", { name: "유형" });
      const enabled = screen.getByRole("checkbox", { name: "사용" });
      const example = screen.getByRole("button", { name: "예시 단계 추가" });
      await user.type(secret, "public-test-key");
      await user.type(url, "https://api.example/v1");
      await user.selectOptions(kind, "second");
      await user.click(enabled);
      await user.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
      // Native inherited disabling must not become RHF register({ disabled:true }),
      // which would intentionally omit the registered values from the payload.
      expect(save.mock.calls[0]?.[0]).toEqual({
        name: "새 초안",
        secret: "public-test-key",
        url: "https://api.example/v1",
        kind: "second",
        enabled: true,
      });
      for (const control of [name, secret, url, kind, enabled, example]) expect(control).toBeDisabled();
      await user.type(name, "unsubmitted");
      await user.type(secret, "unsubmitted");
      await user.type(url, "/unsubmitted");
      await user.selectOptions(kind, "first");
      await user.click(enabled);
      await user.click(example);
      expect(name).toHaveValue("새 초안");
      expect(secret).toHaveValue("public-test-key");
      expect(url).toHaveValue("https://api.example/v1");
      expect(kind).toHaveValue("second");
      expect(enabled).toBeChecked();
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("save failed"));
      });
      if (outcome === "resolve") {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
      } else {
        expect(name).toHaveValue("새 초안");
        expect(secret).toHaveValue("public-test-key");
        expect(url).toHaveValue("https://api.example/v1");
        expect(screen.getByRole("alert")).toBeVisible();
      }
      const editableName = screen.getByRole("textbox", { name: "이름" });
      expect(editableName).toBeEnabled();
      await user.clear(editableName);
      await user.type(editableName, "다음 편집");
      expect(editableName).toHaveValue("다음 편집");
      await user.selectOptions(screen.getByRole("combobox", { name: "유형" }), "first");
      expect(screen.getByRole("combobox", { name: "유형" })).toHaveValue("first");
      const editableCheckbox = screen.getByRole("checkbox", { name: "사용" });
      expect(editableCheckbox).toBeEnabled();
      await user.click(editableCheckbox);
      expect(editableCheckbox).toHaveProperty("checked", outcome === "resolve");
      await user.click(screen.getByRole("button", { name: "예시 단계 추가" }));
      expect(editableName).toHaveValue("예시 단계");
      await user.keyboard("{Escape}");
      expect(screen.getByRole("alertdialog")).toBeVisible();
    },
  );

  it("drops all confirmation and unload protection immediately on cross-tab logout", async () => {
    const user = userEvent.setup();
    render(<FormHarness />);
    await openDirtyForm(user);
    await user.keyboard("{Escape}");
    act(() =>
      window.dispatchEvent(new StorageEvent("storage", { key: "vibe.app.auth.logout-event", newValue: "1" })),
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unload().defaultPrevented).toBe(false);
  });

  it.each(["resolve", "reject"])(
    "ignores an old submission's %s after security disposal and reopening",
    async (outcome) => {
      const user = userEvent.setup();
      const pending = deferredSave();
      const save = vi
        .fn()
        .mockImplementationOnce(() => pending.promise)
        .mockResolvedValue(undefined);
      render(<FormHarness onSave={save} />);
      await openDirtyForm(user);
      await user.click(screen.getByRole("button", { name: "저장" }));
      act(() => window.dispatchEvent(new Event("vibe:logout")));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
      const input = screen.getByRole("textbox", { name: "이름" });
      expect(input).toBeDisabled();
      await user.type(input, "저장 중 새 편집은 차단");
      expect(input).toHaveValue("");
      expect(screen.getByRole("button", { name: "저장 중" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "취소" })).toBeDisabled();
      await user.keyboard("{Escape}");
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else
          pending.reject(
            new AppError("old failure", { kind: "http", status: 503, requestId: "old-request" }),
          );
      });
      expect(screen.getByRole("dialog")).toBeVisible();
      expect(input).toHaveValue("");
      expect(input).toBeEnabled();
      await user.type(input, "새 세션의 초안");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      expect(screen.queryByText(/old-request/)).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "저장" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "취소" })).toBeEnabled();
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "계속 편집" }));
      await user.click(screen.getByRole("button", { name: "저장" }));
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2));
      expect(save.mock.calls[1]?.[0]).toEqual({
        name: "새 세션의 초안",
        secret: "",
        url: "",
        kind: "first",
        enabled: false,
      });
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await openDirtyForm(user);
      await user.keyboard("{Escape}");
      await user.click(screen.getByRole("button", { name: "변경 버리기" }));
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    },
  );

  it("clears confirmation when authentication disables the provider without a logout event", async () => {
    const user = userEvent.setup();
    const view = render(
      <UnsavedChangesProvider enabled>
        <FormHarness />
      </UnsavedChangesProvider>,
    );
    await openDirtyForm(user);
    await user.keyboard("{Escape}");
    view.rerender(
      <UnsavedChangesProvider enabled={false}>
        <FormHarness />
      </UnsavedChangesProvider>,
    );
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unload().defaultPrevented).toBe(false);
    view.rerender(
      <UnsavedChangesProvider enabled>
        <FormHarness />
      </UnsavedChangesProvider>,
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

function renderDataRouter(
  onSave?: (values: Values) => unknown | Promise<unknown>,
  nextLoader?: () => Promise<void>,
) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <UnsavedChangesProvider blockNavigation>
            <main id="main-content" tabIndex={-1}>
              <Outlet />
            </main>
          </UnsavedChangesProvider>
        ),
        children: [
          {
            path: "/edit",
            element: (
              <>
                <FormHarness onSave={onSave} />
                <FormHarness title="다른 편집" />
              </>
            ),
          },
          { path: "/previous", element: <h1>이전 화면</h1> },
          {
            path: "/next",
            element: <h1>다음 화면</h1>,
            ...(nextLoader ? { loader: nextLoader } : {}),
          },
          {
            path: "/login",
            element: (
              <>
                <h1>로그인</h1>
                <input aria-label="로그인 이메일" autoFocus />
              </>
            ),
          },
        ],
      },
    ],
    { initialEntries: ["/previous", "/edit?tab=one"], initialIndex: 1 },
  );
  const view = render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  );
  return { ...view, router };
}

describe("one data-router blocker", () => {
  it.each(["path", "query", "hash", "back"])(
    "protects %s navigation; keep editing resets it and discard proceeds exactly once",
    async (kind) => {
      const user = userEvent.setup();
      const { router } = renderDataRouter();
      await openDirtyForm(user);
      const navigate = () =>
        kind === "back"
          ? router.navigate(-1)
          : router.navigate(
              kind === "path" ? "/next" : kind === "query" ? "/edit?tab=two" : "/edit?tab=one#section",
            );
      await act(async () => {
        await navigate();
      });
      expect(router.state.location.pathname + router.state.location.search).toBe("/edit?tab=one");
      expect(router.state.blockers.size).toBe(1);
      await user.click(screen.getByRole("button", { name: "계속 편집" }));
      expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue("새 초안");
      await waitFor(() => expect(screen.getByRole("textbox", { name: "이름" })).toHaveFocus());
      await act(async () => {
        await navigate();
      });
      await user.click(screen.getByRole("button", { name: "변경 버리기" }));
      await waitFor(() =>
        expect(
          router.state.location.pathname + router.state.location.search + router.state.location.hash,
        ).toBe(
          kind === "back"
            ? "/previous"
            : kind === "path"
              ? "/next"
              : kind === "query"
                ? "/edit?tab=two"
                : "/edit?tab=one#section",
        ),
      );
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      await waitFor(() => expect(document.getElementById("main-content")).toHaveFocus());
      expect(unload().defaultPrevented).toBe(false);
    },
  );

  it("waits for the destination loader before focusing main after a confirmed discard", async () => {
    const user = userEvent.setup();
    const loading = deferredSave();
    const { router } = renderDataRouter(undefined, () => loading.promise);
    await openDirtyForm(user);
    await act(async () => {
      await router.navigate("/next");
    });
    const main = document.getElementById("main-content");
    if (!main) throw new Error("Expected main landmark");
    const focusMain = vi.spyOn(main, "focus");
    await user.click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(router.state.navigation.state).toBe("loading");
    expect(router.state.location.pathname).toBe("/edit");
    expect(focusMain).not.toHaveBeenCalled();
    await act(async () => loading.resolve());
    expect(await screen.findByRole("heading", { name: "다음 화면" })).toBeVisible();
    await waitFor(() => expect(main).toHaveFocus());
    expect(focusMain).toHaveBeenCalledTimes(1);
  });

  it("cancels an approved navigation's pending focus when security redirects to login", async () => {
    const user = userEvent.setup();
    const loading = deferredSave();
    const { router } = renderDataRouter(undefined, () => loading.promise);
    await openDirtyForm(user);
    await act(async () => {
      await router.navigate("/next");
    });
    await user.click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(router.state.navigation.state).toBe("loading");
    await act(async () => {
      window.dispatchEvent(new Event("vibe:logout"));
      await router.navigate("/login", { replace: true });
    });
    const loginInput = await screen.findByRole("textbox", { name: "로그인 이메일" });
    await waitFor(() => expect(loginInput).toHaveFocus());
    await act(async () => loading.resolve());
    expect(router.state.location.pathname).toBe("/login");
    expect(loginInput).toHaveFocus();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("blocks route disposal while a mutation is pending and cancels its stale target after success", async () => {
    const user = userEvent.setup();
    const pending = deferredSave();
    const { router } = renderDataRouter(() => pending.promise);
    await openDirtyForm(user);
    await user.click(screen.getByRole("button", { name: "저장" }));
    await act(async () => {
      await router.navigate("/next");
    });
    expect(screen.getByRole("button", { name: "변경 버리기" })).toBeDisabled();
    expect(screen.getByRole("alertdialog")).toHaveTextContent("저장 중에는");
    await act(async () => pending.resolve());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/edit");
    await act(async () => {
      await router.navigate("/next");
    });
    expect(await screen.findByRole("heading", { name: "다음 화면" })).toBeVisible();
  });

  it.each(["resolve", "reject"])(
    "releases the same-instance route guard after the old security-disposed flight's %s",
    async (outcome) => {
      const user = userEvent.setup();
      const pending = deferredSave();
      const { router } = renderDataRouter(() => pending.promise);
      await openDirtyForm(user);
      await user.click(screen.getByRole("button", { name: "저장" }));
      act(() => window.dispatchEvent(new Event("vibe:logout")));
      const input = await openDirtyForm(user);
      expect(input).toBeDisabled();
      expect(input).toHaveValue("");
      await act(async () => {
        await router.navigate("/edit?tab=two");
      });
      expect(screen.getByRole("button", { name: "변경 버리기" })).toBeDisabled();
      await act(async () => {
        if (outcome === "resolve") pending.resolve();
        else pending.reject(new Error("old failure"));
      });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
      expect(router.state.location.search).toBe("?tab=one");
      expect(input).toBeEnabled();
      await user.type(input, "새 초안");
      await act(async () => {
        await router.navigate("/edit?tab=two");
      });
      expect(screen.getByRole("button", { name: "변경 버리기" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "계속 편집" }));
      expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue("새 초안");
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => {
        await router.navigate("/edit?tab=two");
      });
      await user.click(screen.getByRole("button", { name: "변경 버리기" }));
      expect(router.state.location.search).toBe("?tab=two");
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(unload().defaultPrevented).toBe(false);
    },
  );

  it("cancels the stale blocked destination if the draft becomes clean", async () => {
    const user = userEvent.setup();
    const { router } = renderDataRouter();
    const input = await openDirtyForm(user);
    await act(async () => {
      await router.navigate("/next");
    });
    // A form reset/data refresh can run while the confirmation is open.
    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(router.state.location.pathname).toBe("/edit");
    expect(unload().defaultPrevented).toBe(false);
    await act(async () => {
      await router.navigate("/next");
    });
    expect(await screen.findByRole("heading", { name: "다음 화면" })).toBeVisible();
  });

  it("protects two open dirty forms with one blocker and discards both on a query change", async () => {
    const user = userEvent.setup();
    const router = createMemoryRouter(
      [
        {
          path: "/edit",
          element: (
            <UnsavedChangesProvider blockNavigation>
              <FormHarness initialOpen />
              <FormHarness initialOpen title="다른 편집" />
            </UnsavedChangesProvider>
          ),
        },
      ],
      { initialEntries: ["/edit"] },
    );
    render(
      <StrictMode>
        <RouterProvider router={router} />
      </StrictMode>,
    );
    const inputs = screen.getAllByLabelText("이름");
    const [first, second] = inputs;
    if (!first || !second) throw new Error("Expected two mounted forms");
    fireEvent.change(first, { target: { value: "첫 초안" } });
    fireEvent.change(second, { target: { value: "둘째 초안" } });
    await act(async () => {
      await router.navigate("/edit?tab=two");
    });
    expect(router.state.blockers.size).toBe(1);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(inputs[0]).toHaveValue("첫 초안");
    expect(inputs[1]).toHaveValue("둘째 초안");
    await act(async () => {
      await router.navigate("/edit?tab=two");
    });
    await user.click(screen.getByRole("button", { name: "변경 버리기" }));
    expect(router.state.location.search).toBe("?tab=two");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(unload().defaultPrevented).toBe(false);
  });

  it("session expiry cancels a blocked destination and cannot revive the old draft or prompt", async () => {
    const user = userEvent.setup();
    const { router } = renderDataRouter();
    await openDirtyForm(user);
    await act(async () => {
      await router.navigate("/next");
    });
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await act(async () => {
      window.dispatchEvent(new Event("vibe:logout"));
      await router.navigate("/login", { replace: true });
    });
    expect(await screen.findByRole("heading", { name: "로그인" })).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(unload().defaultPrevented).toBe(false);
    await act(async () => {
      await router.navigate("/edit");
    });
    await user.click(screen.getByRole("button", { name: "테스트 편집 열기" }));
    expect(screen.getByRole("textbox", { name: "이름" })).toHaveValue("");
  });

  it("unmounts registrations without leaking blockers into the next route", async () => {
    const user = userEvent.setup();
    const { router, unmount } = renderDataRouter();
    await openDirtyForm(user);
    unmount();
    expect(unload().defaultPrevented).toBe(false);
    expect(router.state.blockers.size).toBe(0);
  });
});
