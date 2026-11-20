import { act, waitFor } from "@testing-library/react";
import { useLayoutEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCompareAccess, type CompareAccess } from "./use-compare-access";
import { useRunRead } from "./use-run-read";
import { downloadApiFile } from "@/shared/api/download-file";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/shared/api/download-file", () => ({ downloadApiFile: vi.fn() }));
const authentication = vi.hoisted(() => ({
  id: "account_a",
  team: "team_a",
  raw: true,
  scopes: ["admin:read", "admin:write"],
}));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () =>
      testAuth({
        scopes: authentication.scopes,
        rawPromptView: authentication.raw,
        user: { id: authentication.id, team_id: authentication.team },
      }),
  };
});
beforeEach(() => {
  tokenStore.clearAll();
  authentication.id = "account_a";
  authentication.team = "team_a";
  authentication.raw = true;
  authentication.scopes = ["admin:read", "admin:write"];
});
afterEach(() => vi.restoreAllMocks());

function setup(respond: () => unknown = () => ({ common_blocks: [], per_model: [], models: [] })) {
  const api = mockApi({ "GET /admin/chat-test/multi-run/runs/public-run/diff": respond });
  let current!: ReturnType<typeof useRunRead>;
  let update!: (
    next: Partial<{ visible: boolean; owner: string; readOnly: boolean; revision: number }>,
  ) => void;
  function ReadPane({ access }: { access: CompareAccess }) {
    const value = useRunRead("public-run", access);
    useLayoutEffect(() => {
      current = value;
    });
    return null;
  }
  function Owner({ visible }: { visible: boolean }) {
    const access = useCompareAccess(true, "쓰기 권한이 없습니다.");
    return visible ? <ReadPane access={access} /> : null;
  }
  function Host() {
    const [state, setState] = useState({
      visible: true,
      owner: "gateway.chat",
      readOnly: false,
      revision: 0,
    });
    update = (next) => setState((old) => ({ ...old, ...next }));
    return (
      <FeatureAccessContext.Provider
        value={{ featureId: state.owner, permitted: true, readOnly: state.readOnly }}
      >
        <Owner visible={state.visible} />
      </FeatureAccessContext.Provider>
    );
  }
  renderScreen(<Host />);
  return {
    api,
    captured: current.run,
    latest: () => current,
    update: (next: Parameters<typeof update>[0]) => act(() => update(next)),
  };
}

describe("답변 비교의 실제 callback", () => {
  for (const boundary of ["inner unmount", "owner", "epoch", "raw", "scope"] as const) {
    it(`${boundary} 뒤 캡처된 diff callback은 API 0`, async () => {
      const current = setup();
      if (boundary === "inner unmount") current.update({ visible: false });
      if (boundary === "owner") current.update({ owner: "gateway.models" });
      if (boundary === "epoch") act(() => tokenStore.clearAll());
      if (boundary === "raw") {
        authentication.raw = false;
        current.update({ revision: 1 });
      }
      if (boundary === "scope") {
        authentication.scopes = ["admin:write"];
        current.update({ revision: 1 });
      }
      await act(async () => {
        await current.captured("diff");
      });
      expect(current.api.calls).toHaveLength(0);
    });
  }

  it("readonly는 순수 조회를 막지 않고 같은 tick 중복 조회는 1회만 전송한다", async () => {
    let resolve!: (value: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const current = setup(() => response);
    current.update({ readOnly: true });
    let first!: Promise<void>;
    act(() => {
      first = current.captured("diff");
      void current.captured("diff");
    });
    expect(current.api.calls).toHaveLength(1);
    await act(async () => {
      resolve({ common_blocks: [], per_model: [], models: [] });
      await first;
    });
    expect(current.latest().pending).toBe("");
    expect(current.latest().diff).toMatchObject({ common_blocks: [] });
  });
});

describe("actual multi-run export response ownership", () => {
  it.each(["account", "team", "raw permission", "read scope", "feature", "unmount", "logout"])(
    "cancels a stalled body immediately after %s",
    async (boundary) => {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({ cancel });
      const read = vi.spyOn(stream, "getReader");
      const fetch = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(stream, { headers: { "Content-Type": "text/csv" } }));
      const current = setup();
      let pending!: Promise<void>;
      act(() => {
        pending = current.latest().run("export", "csv");
      });
      await waitFor(() => expect(read).toHaveBeenCalledOnce());
      if (boundary === "account") authentication.id = "account_b";
      if (boundary === "team") authentication.team = "team_b";
      if (boundary === "raw permission") authentication.raw = false;
      if (boundary === "read scope") authentication.scopes = ["admin:write"];
      if (boundary === "logout") act(() => tokenStore.clearAll());
      else
        current.update({
          revision: 1,
          ...(boundary === "feature" ? { owner: "gateway.models" } : {}),
          ...(boundary === "unmount" ? { visible: false } : {}),
        });
      await waitFor(() => expect(cancel).toHaveBeenCalledOnce());
      await act(async () => {
        await pending;
      });
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
      expect(downloadApiFile).not.toHaveBeenCalled();
      expect(fetch).toHaveBeenCalledOnce();
      if (boundary !== "unmount") {
        expect(current.latest().pending).toBe("");
        expect(current.latest().error).toBeUndefined();
      }
    },
  );

  it("keeps a captured A callback retired after A to B to A while fresh reads work", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("public", { headers: { "Content-Type": "text/markdown" } }));
    const current = setup();
    const old = current.captured;
    authentication.id = "account_b";
    current.update({ revision: 1 });
    authentication.id = "account_a";
    current.update({ revision: 2 });
    await act(async () => {
      await old("export");
    });
    expect(fetch).not.toHaveBeenCalled();
    await act(async () => {
      await current.latest().run("export");
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(downloadApiFile).toHaveBeenCalledOnce();
  });
});
