import userEvent from "@testing-library/user-event";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { RequestIOPage } from "./RequestIOPage";
import { requestIODetailSchema } from "@/shared/api/domains/observability.schemas";
import { comparisonRequest, comparisonResponse } from "../requests/request-comparison-fixtures";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
const auth = vi.hoisted(() => ({ team: "first" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ user: { team_id: auth.team } }) };
});
afterEach(() => {
  vi.unstubAllGlobals();
  auth.team = "first";
});
it("retires held list rows and the automatic first selection when the read owner changes", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
  const old = { ...comparisonRequest("old-owner-request"), model: "OLD_OWNER_MODEL" };
  const api = mockApi({
    "GET /admin/requests": () => (auth.team === "first" ? comparisonResponse(old) : comparisonResponse()),
    "GET /admin/requests/io": () => ({
      previews: [],
      capture: { response_text: true, raw_prompts: false, response_max_bytes: 100 },
    }),
    "GET /admin/requests/old-owner-request/io": () =>
      requestIODetailSchema.parse({
        request_id: "old-owner-request",
        input: {},
        output: {},
        capture: {},
      }),
  });
  let refresh = (): void => undefined;
  function Screen() {
    const [, render] = useState(0);
    refresh = () => render((value) => value + 1);
    return (
      <FeatureAccessHarness featureId="observability.io">
        <RequestIOPage />
      </FeatureAccessHarness>
    );
  }
  const { container } = renderScreen(<Screen />, {
    path: "/observability/io",
    route: "/observability/io?live=off",
  });
  await screen.findByText("OLD_OWNER_MODEL");
  await waitFor(() =>
    expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1),
  );
  const list = container.querySelector(".io-list-pane");
  if (!(list instanceof HTMLElement)) throw Error("list missing");
  Object.defineProperty(list, "scrollTop", { value: 100, writable: true });
  fireEvent.scroll(list);
  act(() => {
    auth.team = "second";
    refresh();
  });
  await waitFor(() => expect(api.calls.filter((call) => call.key === "GET /admin/requests").length).toBe(2));
  expect(await screen.findByText("표시할 요청이 없습니다.")).toBeVisible();
  expect(screen.queryByText("OLD_OWNER_MODEL")).toBeNull();
  expect(container.querySelector('.io-row[data-request-id="old-owner-request"]')).toBeNull();
  expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1);
});

it("retires held rows after terminal denial and does not revive them through a failed recovery", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  let mode = "ok";
  const api = mockApi({
    "GET /admin/requests": () => {
      if (mode === "denied") throw apiFailure("denied", 403);
      if (mode === "unavailable") throw apiFailure("unavailable");
      return mode === "ok"
        ? comparisonResponse({ ...comparisonRequest("old-owner-request"), model: "HELD_BEFORE_DENIAL" })
        : comparisonResponse();
    },
    "GET /admin/requests/io": () => ({
      previews: [],
      capture: { response_text: true, raw_prompts: false, response_max_bytes: 100 },
    }),
    "GET /admin/requests/old-owner-request/io": () =>
      requestIODetailSchema.parse({ input: {}, output: {}, capture: {} }),
  });
  const { container } = renderScreen(
    <FeatureAccessHarness featureId="observability.io">
      <RequestIOPage />
    </FeatureAccessHarness>,
    { path: "/observability/io", route: "/observability/io?live=off" },
  );
  const user = userEvent.setup();
  await screen.findByText("HELD_BEFORE_DENIAL");
  await waitFor(() =>
    expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1),
  );
  const list = container.querySelector(".io-list-pane");
  if (!(list instanceof HTMLElement)) throw Error("list missing");
  Object.defineProperty(list, "scrollTop", { value: 100, writable: true });
  fireEvent.scroll(list);
  mode = "denied";
  await user.click(screen.getByRole("button", { name: "지금 새로고침" }));
  await screen.findByText("입출력 조회 권한을 확인하세요.");
  expect(screen.queryByText("HELD_BEFORE_DENIAL")).toBeNull();
  mode = "unavailable";
  await user.click(screen.getByRole("button", { name: "다시 조회" }));
  await screen.findByText("요청 목록을 불러오지 못했습니다.");
  expect(screen.queryByText("HELD_BEFORE_DENIAL")).toBeNull();
  mode = "empty";
  await user.click(screen.getByRole("button", { name: "지금 새로고침" }));
  expect(await screen.findByText("표시할 요청이 없습니다.")).toBeVisible();
  expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1);
});

it("preserves a held list through an ordinary same-owner server outage", async () => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  let fail = false;
  const api = mockApi({
    "GET /admin/requests": () => {
      if (fail) throw apiFailure("temporary outage");
      return comparisonResponse({ ...comparisonRequest("old-owner-request"), model: "SAME_OWNER_HELD" });
    },
    "GET /admin/requests/io": () => ({
      previews: [],
      capture: { response_text: true, raw_prompts: false, response_max_bytes: 100 },
    }),
    "GET /admin/requests/old-owner-request/io": () =>
      requestIODetailSchema.parse({ input: {}, output: {}, capture: {} }),
  });
  const { container, client } = renderScreen(
    <FeatureAccessHarness featureId="observability.io">
      <RequestIOPage />
    </FeatureAccessHarness>,
    { path: "/observability/io", route: "/observability/io?live=off" },
  );
  const user = userEvent.setup();
  await screen.findByText("SAME_OWNER_HELD");
  await waitFor(() =>
    expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1),
  );
  const list = container.querySelector(".io-list-pane");
  if (!(list instanceof HTMLElement)) throw Error("list missing");
  Object.defineProperty(list, "scrollTop", { value: 100, writable: true });
  fireEvent.scroll(list);
  fail = true;
  await user.click(screen.getByRole("button", { name: "지금 새로고침" }));
  await waitFor(() =>
    expect(
      client.getQueryCache().findAll({
        predicate: (query) =>
          query.queryKey[0] === "observability" && query.queryKey[1] === "io" && query.queryKey[2] === "list",
      })[0]?.state.status,
    ).toBe("error"),
  );
  expect(screen.getByText("SAME_OWNER_HELD")).toBeVisible();
  expect(api.calls.filter((call) => call.key.endsWith("/old-owner-request/io")).length).toBe(1);
});
