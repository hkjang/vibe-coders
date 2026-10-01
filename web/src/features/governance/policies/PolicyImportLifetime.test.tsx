import { act, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { tokenStore } from "@/shared/auth/token-store";
import type { PolicyImportBody } from "@/shared/api/domains/policy-import";
import { acknowledgement, deferred, importBody, setupImport } from "./policy-import-test-harness";

describe("정책 가져오기 현재 주체·승인·조회 수명", () => {
  it.each(["scope", "readonly", "prefix"])(
    "%s 회수/복구 뒤 old apply callback은 재사용되지 않는다",
    async (kind) => {
      const h = await setupImport();
      await h.open();
      await h.file();
      await h.plan();
      await h.confirm();
      const old = h.capture("검토한 정책 적용");
      if (kind === "scope") h.update({ scopes: ["security:read", "admin:read"] });
      if (kind === "readonly") h.update({ readOnly: true });
      if (kind === "prefix") h.update({ prefixes: ["changed_"] });
      act(old);
      expect(h.posts()).toHaveLength(1);
      h.update({
        scopes: ["security:read", "admin:read", "admin:write"],
        readOnly: false,
        prefixes: ["vc_sk_", "vc_sa_"],
      });
      act(old);
      expect(h.posts()).toHaveLength(1);
      expect(screen.getByText(/권한 또는 표시 보호 기준이 바뀌었습니다/)).toBeVisible();
    },
  );
  it("현재 입력 확인 문구가 바뀌면 old ready callback은 전송하지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const old = h.capture("검토한 정책 적용");
    await h.user.clear(screen.getByRole("textbox", { name: "확인 문구" }));
    act(old);
    expect(h.posts()).toHaveLength(1);
    expect(h.exports).toHaveLength(1);
  });
  it("검토 폐기 후 파일 A→B→A도 이전 approval identity를 되살리지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const old = h.capture("검토한 정책 적용");
    await h.user.click(screen.getByRole("button", { name: "다시 검토" }));
    await h.file({ policies: [{ id: "public_policy", name: "파일 B" }] }, "b.json");
    await h.file(importBody, "a.json");
    await h.plan();
    await h.confirm();
    act(old);
    expect(h.posts()).toHaveLength(2);
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    expect(h.posts()).toHaveLength(3);
  });
  it("fresh GET가 pending인 동안 write가 회수되면 POST 적용0이다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const held = deferred<unknown>();
    const baseline = h.response.export();
    h.response.export = () => held.promise;
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await waitFor(() => expect(h.exports).toHaveLength(2));
    h.update({ readOnly: true });
    await act(async () => {
      held.resolve(baseline);
      await held.promise;
    });
    await h.idle();
    expect(h.posts()).toHaveLength(1);
  });
  it("이미 보낸 적용의 정상 ACK는 write회수 뒤에도 성공이며 추가 적용은 없다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const held = deferred<unknown>();
    h.response.post = () => held.promise;
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await waitFor(() => expect(h.posts()).toHaveLength(2));
    h.update({ readOnly: true });
    await act(async () => {
      held.resolve(acknowledgement(importBody, false));
      await held.promise;
    });
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    await h.idle();
    expect(h.posts()).toHaveLength(2);
  });
  it.each(["owner", "read", "epoch", "mode"])(
    "%s 수명 폐기 후 late plan 결과·raw file은 새 창에 나타나지 않는다",
    async (boundary) => {
      const h = await setupImport();
      await h.open();
      await h.file();
      const held = deferred<unknown>();
      h.response.post = () => held.promise;
      await h.user.click(screen.getByRole("button", { name: "서버 계획 확인" }));
      await waitFor(() => expect(h.posts()).toHaveLength(1));
      if (boundary === "owner") {
        h.update({ principal: "public_b" });
        h.update({ principal: "public_a" });
      }
      if (boundary === "read") {
        h.update({ scopes: ["admin:write"] });
        h.update({ scopes: ["security:read", "admin:write"] });
      }
      if (boundary === "epoch") act(() => tokenStore.clearAll());
      if (boundary === "mode") h.update({ authMode: "legacy" });
      expect(screen.queryByRole("dialog", { name: "정책 가져오기" })).not.toBeInTheDocument();
      await h.open();
      await act(async () => {
        held.resolve(acknowledgement(importBody, true));
        await held.promise;
      });
      expect(screen.queryByText(/로컬 형식 확인 완료/)).not.toBeInTheDocument();
      expect(screen.queryByRole("heading", { name: "서버 계획과 변경 내용" })).not.toBeInTheDocument();
      expect(h.posts()).toHaveLength(1);
    },
  );
  it("새 B plan이 이미 pending인 상태에서 old A finally는 B 진행 표시를 지우지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    const old = deferred<unknown>();
    const next = deferred<unknown>();
    let calls = 0;
    h.response.post = () => (++calls === 1 ? old.promise : next.promise);
    await h.user.click(screen.getByRole("button", { name: "서버 계획 확인" }));
    await waitFor(() => expect(h.posts()).toHaveLength(1));
    h.update({ principal: "public_b" });
    await h.open();
    await h.file();
    await h.user.click(screen.getByRole("button", { name: "서버 계획 확인" }));
    await waitFor(() => expect(h.posts()).toHaveLength(2));
    await act(async () => {
      old.resolve(acknowledgement(importBody, true));
      await old.promise;
    });
    expect(screen.getByText("정책 기준을 확인 중입니다.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "서버 계획과 변경 내용" })).not.toBeInTheDocument();
    await act(async () => {
      next.resolve(acknowledgement(importBody, true));
      await next.promise;
    });
    await screen.findByRole("heading", { name: "서버 계획과 변경 내용" });
  });
  it("current prefix 변경으로 새로 민감해진 파일명·표시를 즉시 가리고 이전 검토는 무효화한다", async () => {
    const h = await setupImport();
    const name = `private_${"a".repeat(32)}`;
    const body = { policies: [{ id: "public_policy", name, rules: null }] };
    await h.open();
    await h.file(body, `${name}.json`);
    await h.plan();
    expect(h.dialog().textContent).toContain(name);
    h.update({ prefixes: ["private_"] });
    expect(h.dialog().outerHTML).not.toContain(name);
    expect(screen.getByText(/권한 또는 표시 보호 기준이 바뀌었습니다/)).toBeVisible();
    expect(h.posts()).toHaveLength(1);
  });
  it.each(["owner ABA", "read", "mode"])(
    "%s 폐기 후 held 원문 백업은 download0이며 새 현재 창의 정상 백업만 1이다",
    async (boundary) => {
      const h = await setupImport();
      await h.open();
      const held = deferred<unknown>();
      const original = h.response.export;
      const response = original();
      h.response.export = () => held.promise;
      const create = vi.fn<(blob: Blob) => string>(() => "blob:public-safe-current");
      class DownloadURL extends URL {
        static override createObjectURL = create;
        static override revokeObjectURL = vi.fn();
      }
      vi.stubGlobal("URL", DownloadURL);
      const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
      await h.user.click(screen.getByRole("checkbox", { name: /민감값을 포함할 수 있는 원문/ }));
      await h.user.click(screen.getByRole("button", { name: "현재 정책 백업 내려받기" }));
      await waitFor(() => expect(h.exports).toHaveLength(1));
      if (boundary === "owner ABA") {
        h.update({ principal: "public_b" });
        h.update({ principal: "public_a" });
      }
      if (boundary === "read") {
        h.update({ scopes: ["admin:write"] });
        h.update({ scopes: ["security:read", "admin:write"] });
      }
      if (boundary === "mode") h.update({ authMode: "legacy" });
      expect(h.exports[0]?.signal?.aborted).toBe(true);
      await h.open();
      await act(async () => {
        held.resolve(response);
        await held.promise;
      });
      expect(create).not.toHaveBeenCalled();
      expect(click).not.toHaveBeenCalled();
      h.response.export = original;
      await h.user.click(screen.getByRole("checkbox", { name: /민감값을 포함할 수 있는 원문/ }));
      await h.user.click(screen.getByRole("button", { name: "현재 정책 백업 내려받기" }));
      await h.idle();
      expect(h.exports).toHaveLength(2);
      expect(create).toHaveBeenCalledOnce();
      expect(click).toHaveBeenCalledOnce();
      expect(h.posts()).toHaveLength(0);
    },
  );
  it("ACK 후 held 일반 목록 응답은 owner 폐기 후 새 cache에 게시하지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const held = deferred<unknown>();
    h.response.list = () => held.promise;
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    await waitFor(() =>
      expect(h.api.calls.filter((call) => call.key === "GET /admin/policies")).toHaveLength(2),
    );
    h.update({ principal: "public_b" });
    // Controlled new-owner cache sentinel; this does not claim the existing list's
    // shared query key gained a new whole-page lifetime boundary.
    act(() => h.view.client.setQueryData(["governance", "policies"], { policies: [] }));
    await act(async () => {
      held.resolve({ policies: [{ ...h.response.row, name: "LATE_OLD_OWNER" }] });
      await held.promise;
    });
    expect(h.view.client.getQueryData(["governance", "policies"])).toEqual({ policies: [] });
    expect(screen.queryByText("LATE_OLD_OWNER")).not.toBeInTheDocument();
  });
  it("실제 기존 Query의 오래된 refetch가 import 후 새 목록을 덮어쓰지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const old = deferred<unknown>();
    const oldRows = structuredClone(h.response.rows);
    let reads = 0;
    h.response.list = () => (++reads === 1 ? old.promise : { policies: structuredClone(h.response.rows) });
    const query = h.view.client.getQueryCache().find({ queryKey: ["governance", "policies"], exact: true });
    if (!query) throw new Error("actual policy list query missing");
    // The actual mounted observer's queryFn and key; no invented query or mocked
    // cancellation. Simulates an already admitted ordinary list refetch.
    let oldFlight: Promise<unknown> | undefined;
    act(() => {
      oldFlight = query.fetch().catch(() => undefined);
    });
    await waitFor(() =>
      expect(h.api.calls.filter((call) => call.key === "GET /admin/policies")).toHaveLength(2),
    );
    h.response.post = (options) => {
      h.response.row.name = "최신 저장 목록";
      return acknowledgement(options.body as PolicyImportBody, false);
    };
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    await h.idle();
    expect(h.view.client.getQueryData(["governance", "policies"])).toMatchObject({
      policies: [{ name: "최신 저장 목록" }],
    });
    await act(async () => {
      old.resolve({ policies: oldRows });
      await old.promise;
      await oldFlight;
    });
    expect(h.view.client.getQueryData(["governance", "policies"])).toMatchObject({
      policies: [{ name: "최신 저장 목록" }],
    });
    expect(h.posts()).toHaveLength(2);
  });
});
