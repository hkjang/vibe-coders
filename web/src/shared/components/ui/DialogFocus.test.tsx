import { useEffect, useRef, useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { Dialog } from "./Dialog";

function ReplacedPage({ focusError, closed }: { focusError: boolean; closed: () => void }) {
  const [replaced, setReplaced] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const error = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (replaced && focusError) error.current?.focus();
  }, [replaced, focusError]);
  return (
    <main id="main-content" tabIndex={-1}>
      {replaced ? (
        <h1 ref={error} tabIndex={-1}>
          현재 조회가 거부되었습니다.
        </h1>
      ) : (
        <>
          <button ref={trigger}>열 설정</button>
          <Dialog
            open={true}
            onOpenChange={() => undefined}
            onCloseAutoFocus={closed}
            returnFocusRef={trigger}
            title="열 설정"
            description="검사 화면"
          >
            <button onClick={() => setReplaced(true)}>조회 거부</button>
          </Dialog>
        </>
      )}
    </main>
  );
}

it("열었던 화면이 사라지면 오류 안내로 이미 옮긴 포커스를 유지한다", async () => {
  const closed = vi.fn();
  render(<ReplacedPage focusError={true} closed={closed} />);
  await userEvent.click(screen.getByRole("button", { name: "조회 거부" }));
  await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("heading")).toHaveFocus();
});

it("열었던 화면과 별도의 포커스 대상이 모두 사라지면 본문으로 복귀한다", async () => {
  const closed = vi.fn();
  render(<ReplacedPage focusError={false} closed={closed} />);
  await userEvent.click(screen.getByRole("button", { name: "조회 거부" }));
  await waitFor(() => expect(closed).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("main")).toHaveFocus();
});
