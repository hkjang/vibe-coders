import { act, screen, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useMemo, useRef, useState } from "react";
import { expect, it, vi } from "vitest";
import { RequestIOPanel } from "./RequestIOPanel";
import { requestIODetailSchema } from "@/shared/api/domains/observability.schemas";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});
function detail(raw = false, allowed = true) {
  return requestIODetailSchema.parse({
    request_id: "same-request",
    status_code: 200,
    masked: !raw,
    raw_allowed: allowed,
    input: {
      state: "captured",
      messages: [
        { role: "user", text: raw ? "PRIVATE_OLD_PRINCIPAL" : "MASKED_CURRENT", original_kept: true },
      ],
    },
    output: { state: "missing" },
    capture: {},
  });
}
function setup(rawResult?: () => Promise<ReturnType<typeof detail>>) {
  let reader = false;
  let changeOwner = (): void => undefined;
  const api = mockApi({
    "GET /admin/requests/same-request/io": ({ query }) => {
      const raw = (query as { reveal?: string } | undefined)?.reveal === "raw";
      return raw && rawResult ? rawResult() : detail(raw, !reader);
    },
  });
  function Screen() {
    const [owner, setOwner] = useState(1);
    const [, render] = useState(0);
    const current = useRef(owner);
    current.current = owner;
    const scope = useMemo(() => ({ id: owner, isCurrent: () => current.current === owner }), [owner]);
    changeOwner = () => {
      reader = true;
      setOwner(owner + 1);
    };
    return (
      <>
        <button
          onClick={() => {
            reader = true;
            setOwner(owner + 1);
          }}
        >
          다른 조회 사용자
        </button>
        <button onClick={() => render((n) => n + 1)}>같은 사용자 갱신</button>
        <RequestIOPanel requestId="same-request" readScope={scope} />
      </>
    );
  }
  const view = renderScreen(<Screen />);
  return { ...view, api, user: userEvent.setup(), changeOwner: () => act(changeOwner) };
}
async function reveal(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  const dialog = await screen.findByRole("dialog", { name: "이 요청의 원문을 볼까요?" });
  await user.click(within(dialog).getByRole("button", { name: "원문 보기" }));
  await screen.findByText("PRIVATE_OLD_PRINCIPAL");
}
it("retires confirmed raw data for the same request when its read owner changes", async () => {
  const { user, api } = setup();
  await reveal(user);
  await user.click(screen.getByRole("button", { name: "다른 조회 사용자" }));
  await waitFor(() => expect(api.calls.filter((call) => !call.options.query).length).toBe(2));
  expect(await screen.findByText("MASKED_CURRENT")).toBeVisible();
  expect(screen.queryByText("PRIVATE_OLD_PRINCIPAL")).toBeNull();
  expect(screen.queryByRole("button", { name: "원문 보기" })).toBeNull();
  expect(api.calls.filter((call) => call.options.query).length).toBe(1);
});
it("keeps an explicitly revealed value through an ordinary same-owner rerender", async () => {
  const { user, api } = setup();
  await reveal(user);
  await user.click(screen.getByRole("button", { name: "같은 사용자 갱신" }));
  expect(screen.getByText("PRIVATE_OLD_PRINCIPAL")).toBeVisible();
  expect(api.calls.filter((call) => call.options.query).length).toBe(1);
});

it("closes an unconfirmed raw reveal when the read owner changes without a raw GET", async () => {
  const { user, api, changeOwner } = setup();
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  await screen.findByRole("dialog", { name: "이 요청의 원문을 볼까요?" });
  changeOwner();
  expect(await screen.findByText("MASKED_CURRENT")).toBeVisible();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((call) => call.options.query).length).toBe(0);
});
it("discards an old confirmed raw response arriving after a new owner reads the same ID", async () => {
  let finish: (value: ReturnType<typeof detail>) => void = () => {};
  const pending = new Promise<ReturnType<typeof detail>>((done) => {
    finish = done;
  });
  const { user, api, changeOwner } = setup(() => pending);
  await user.click(await screen.findByRole("button", { name: "원문 보기" }));
  const dialog = await screen.findByRole("dialog", { name: "이 요청의 원문을 볼까요?" });
  await user.click(within(dialog).getByRole("button", { name: "원문 보기" }));
  await waitFor(() => expect(api.calls.filter((call) => call.options.query).length).toBe(1));
  changeOwner();
  expect(await screen.findByText("MASKED_CURRENT")).toBeVisible();
  await act(async () => {
    finish(detail(true));
    await pending;
  });
  expect(screen.queryByText("PRIVATE_OLD_PRINCIPAL")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(api.calls.filter((call) => call.options.query).length).toBe(1);
});
