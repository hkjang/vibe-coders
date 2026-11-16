import { useState } from "react";
import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { testAuth } from "@/test/auth";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { useText2SqlRegistryTransfer } from "./use-text2sql-registry-transfer";
const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth>, readOnly: false }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
beforeEach(() => {
  state.auth = testAuth({ user: { team_id: "alpha" } });
  state.readOnly = false;
});

it.each(["team", "readonly-restore", "scope-restore"])(
  "파일 읽기 도중 %s 전환은 서버 쓰기와 알림을 막는다",
  async (change) => {
    let finish!: (value: string) => void;
    let redraw = () => {};
    const message = vi.fn(),
      success = vi.spyOn(toast, "success");
    const file = Object.assign(new File(["public fixture"], "registry.json"), {
      text: vi.fn(
        () =>
          new Promise<string>((resolve) => {
            finish = resolve;
          }),
      ),
    });
    const api = mockApi({
      "POST /admin/text2sql/registry/import": () => ({
        tables_imported: 1,
        columns_imported: 0,
        table_errors: 0,
        column_errors: 0,
      }),
    });
    function Action() {
      const { importBundle } = useText2SqlRegistryTransfer({ canWrite: true, onMessage: message });
      return <button onClick={() => importBundle.mutate(file)}>가져오기</button>;
    }
    function Host() {
      const [, set] = useState(0);
      redraw = () => set((v) => v + 1);
      return (
        <FeatureAccessHarness featureId="text2sql.overview" readOnly={state.readOnly}>
          <Action />
        </FeatureAccessHarness>
      );
    }
    renderScreen(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "가져오기" }));
    await waitFor(() => expect(finish).toBeTypeOf("function"));
    await userEvent.click(screen.getByRole("button", { name: "가져오기" }));
    expect(file.text).toHaveBeenCalledOnce();
    if (change === "team") state.auth = testAuth({ user: { team_id: "beta" } });
    else if (change === "readonly-restore") state.readOnly = true;
    else state.auth = testAuth({ scopes: ["admin:read"], user: { team_id: "alpha" } });
    act(redraw);
    if (change !== "team") {
      state.readOnly = false;
      state.auth = testAuth({ user: { team_id: "alpha" } });
      act(redraw);
    }
    await act(async () =>
      finish(JSON.stringify({ tables: [{ schema_name: "analytics", table_name: "orders" }] })),
    );
    expect(api.calls).toEqual([]);
    expect(message).not.toHaveBeenCalled();
    expect(success).not.toHaveBeenCalled();
  },
);
