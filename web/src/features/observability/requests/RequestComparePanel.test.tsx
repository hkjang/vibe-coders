import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FilterSuggestions } from "./FilterSuggestions";
import { RequestComparePanel } from "./RequestComparePanel";
import { comparisonRequest as row, comparisonResponse as response } from "./request-comparison-fixtures";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessContext } from "@/shared/feature-access/context";

const auth = vi.hoisted(() => ({ id: "reader", scopes: ["admin:read"], prefixes: ["corp_"] }));
vi.mock("@/app/auth/AuthProvider", () => ({
  useAuth: () => ({
    mode: "authenticated",
    credentialPrefixes: auth.prefixes,
    user: { id: auth.id, role: "admin", team_id: "team", scopes: auth.scopes },
  }),
}));
beforeEach(() => {
  auth.id = "reader";
  auth.scopes = ["admin:read"];
  auth.prefixes = ["corp_"];
});
afterEach(() => vi.restoreAllMocks());
function panel(assertSelected = () => undefined) {
  return (
    <FeatureAccessContext.Provider
      value={{ featureId: "observability.requests", permitted: true, readOnly: true }}
    >
      <RequestComparePanel request={row("req-a")} assertSelected={assertSelected} />
    </FeatureAccessContext.Provider>
  );
}
async function compare(user: ReturnType<typeof userEvent.setup>, id = "req-b") {
  await user.clear(screen.getByLabelText("비교할 요청 ID"));
  await user.type(screen.getByLabelText("비교할 요청 ID"), id);
  await user.click(screen.getByRole("button", { name: "비교" }));
}
const safeApi = () =>
  mockApi({
    "GET /admin/requests": ({ query }) => response(row(String((query as { request_id: string }).request_id))),
  });
describe("RequestComparePanel", () => {
  it("compares safe metadata without calling the legacy raw-detail endpoint", async () => {
    const api = safeApi();
    const user = userEvent.setup();
    renderScreen(panel());
    expect(api.calls).toHaveLength(0);
    await compare(user);
    const table = await screen.findByRole("table", { name: "두 요청의 운영 지표 비교" });
    expect(within(table).getByText("model-b")).toBeVisible();
    expect(within(table).getAllByText("(값이 다름)")).toHaveLength(2);
    expect(api.calls.map((c) => c.key)).toEqual(["GET /admin/requests", "GET /admin/requests"]);
  });
  it("rejects configured secrets before network and focuses the invalid field", async () => {
    const api = safeApi();
    const user = userEvent.setup();
    renderScreen(panel());
    await compare(user, "corp_" + "a".repeat(32));
    expect(screen.getByRole("alert")).toHaveTextContent("비밀정보로 보이는 값");
    expect(screen.getByLabelText("비교할 요청 ID")).toHaveFocus();
    expect(api.calls).toHaveLength(0);
  });
  it("removes the old comparison during a fresh read and failed retry, then permits explicit recovery", async () => {
    let fail = false;
    const api = mockApi({
      "GET /admin/requests": ({ query }) => {
        if (fail) throw apiFailure("private database content", 403, "safe-id");
        return response(row(String((query as { request_id: string }).request_id)));
      },
    });
    const user = userEvent.setup();
    renderScreen(panel());
    await compare(user);
    await screen.findByRole("table");
    fail = true;
    await user.click(screen.getByRole("button", { name: "비교" }));
    expect(await screen.findByText("두 요청을 비교하지 못했습니다.")).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.queryByText("private database content")).not.toBeInTheDocument();
    expect(screen.getByText("요청 ID: safe-id")).toBeVisible();
    expect(api.calls).toHaveLength(3);
    fail = false;
    await user.click(screen.getByRole("button", { name: "비교" }));
    await screen.findByRole("table");
    expect(api.calls).toHaveLength(5);
  });
  it("retires prior-account inputs and cached results on identity change", async () => {
    safeApi();
    const user = userEvent.setup();
    let refresh = () => undefined;
    function Host() {
      const [, rerender] = useReducer((value: number) => value + 1, 0);
      refresh = () => {
        rerender();
        return undefined;
      };
      return panel();
    }
    renderScreen(<Host />);
    await compare(user);
    await screen.findByRole("table");
    auth.id = "another-reader";
    act(() => refresh());
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("비교할 요청 ID")).toHaveValue("");
  });
  it("rechecks the parent selection before any read", async () => {
    const api = safeApi();
    const user = userEvent.setup();
    renderScreen(
      panel(() => {
        throw Error("retired");
      }),
    );
    await compare(user);
    expect(api.calls).toHaveLength(0);
  });
  it("blocks duplicate submission while loading and rejects late replies after unmount", async () => {
    let finish: (value: ReturnType<typeof response>) => void = () => undefined;
    const pending = new Promise<ReturnType<typeof response>>((resolve) => {
      finish = resolve;
    });
    const api = mockApi({ "GET /admin/requests": () => pending });
    const user = userEvent.setup();
    const current = renderScreen(panel());
    await compare(user);
    await user.click(screen.getByRole("button", { name: "비교" }));
    expect(api.calls).toHaveLength(1);
    current.unmount();
    await act(async () => {
      finish(response(row("req-a")));
      await pending;
    });
    expect(api.calls).toHaveLength(1);
  });
});
describe("FilterSuggestions", () => {
  it("offers values observed by the gateway", async () => {
    const api = mockApi({ "GET /admin/suggest": () => ({ field: "model", values: ["model-a", "model-b"] }) });
    const { container } = renderScreen(<FilterSuggestions enabled field="model" id="models" />);
    await vi.waitFor(() => expect(container.querySelectorAll("#models option")).toHaveLength(2));
    expect(api.calls[0]?.options.query).toEqual({ field: "model" });
  });
});
