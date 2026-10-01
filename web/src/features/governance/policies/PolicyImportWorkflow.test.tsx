import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import type { PolicyImportBody } from "@/shared/api/domains/policy-import";
import { acknowledgement, deferred, importBody, setupImport } from "./policy-import-test-harness";

describe("정책 파일 검토·적용·명시 조회", () => {
  it("한국어 파일 선택 버튼이 연결된 실제 입력을 열고 선택 후 원문 값을 비운다", async () => {
    const h = await setupImport();
    await h.open();
    const input = screen.getByLabelText<HTMLInputElement>("정책 JSON 파일");
    const nativeClick = vi.spyOn(input, "click");
    await h.user.click(screen.getByRole("button", { name: "JSON 파일 선택" }));
    expect(nativeClick).toHaveBeenCalledOnce();
    expect(input).toHaveAttribute("hidden");
    expect(input.labels?.[0]).toHaveTextContent("정책 JSON 파일");
    await h.file();
    expect(input).toHaveValue("");
    expect(screen.getByText(/로컬 형식 확인 완료/)).toBeVisible();
    expect(h.posts()).toHaveLength(0);
  });
  it("서버 계획이 생기면 검토 제목에 초점을 둔 뒤 그 부분을 상단으로 스크롤한다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    await h.plan();
    const heading = screen.getByRole("heading", { name: "서버 계획과 변경 내용" });
    expect(heading).toHaveFocus();
    expect(scroll).toHaveBeenCalledWith({ block: "start" });
    expect(scroll.mock.contexts.at(-1)).toBe(heading);
    expect(h.posts()).toHaveLength(1);
  });
  it("메타데이터의 사용 상태는 한국어로 표시하고 전송 boolean은 그대로 유지한다", async () => {
    const h = await setupImport();
    await h.open();
    const body = { policies: [{ id: "public_policy", name: "적용 후보", enabled: true, rules: null }] };
    await h.file(body);
    await h.plan();
    const table = screen.getByRole("table", { name: "정책 1 메타데이터 전후" });
    const row = within(table).getByRole("row", { name: /사용 상태/ });
    expect(
      within(row)
        .getAllByRole("cell")
        .map((cell) => cell.textContent),
    ).toEqual(["중지", "사용"]);
    expect(h.posts()[0]?.options.body).toEqual(body);
  });
  it.each(["authenticated", "legacy", "open"] as const)(
    "%s 정상 모드의 dry plan·고정 검토·apply와 후속 조회를 구분한다",
    async (mode) => {
      const h = await setupImport();
      h.update({ authMode: mode });
      await h.open();
      await h.file();
      expect(h.posts()).toHaveLength(0);
      await h.plan();
      expect(h.posts()).toHaveLength(1);
      expect(h.posts()[0]?.options).toEqual({ body: importBody, query: { dry_run: "1" } });
      expect(h.exports).toHaveLength(1);
      await h.confirm();
      await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
      await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
      await h.idle();
      expect(h.posts()).toHaveLength(2);
      expect(h.posts()[1]?.options.body).toEqual(importBody);
      expect(h.posts()[1]?.options.query).toBeUndefined();
      expect(h.exports).toHaveLength(3);
      expect(h.view.client.getMutationCache().getAll()).toHaveLength(0);
      expect(
        h.view.client
          .getQueryCache()
          .getAll()
          .some((query) => (JSON.stringify(query.state.data) ?? "").includes("파일의 공개 정책")),
      ).toBe(false);
      await h.user.click(within(h.dialog()).getByRole("button", { name: "닫기" }));
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "정책 가져오기" })).not.toBeInTheDocument(),
      );
      expect(screen.getByRole("button", { name: "정책 가져오기" })).toHaveFocus();
    },
  );
  it("readonly는 로컬 파일 검토만 허용하고 캡처한 서버 계획 callback도 POST0이다", async () => {
    const h = await setupImport();
    h.update({ readOnly: true });
    await h.open();
    await h.file();
    expect(screen.getByText(/로컬 형식 확인 완료/)).toBeVisible();
    const plan = h.capture("서버 계획 확인");
    act(plan);
    await h.idle();
    expect(h.posts()).toHaveLength(0);
    expect(h.exports).toHaveLength(0);
    expect(screen.getByRole("button", { name: "서버 계획 확인" })).toHaveAttribute("aria-disabled", "true");
  });
  it("변경된 파일의 취소는 dirty 확인을 거치고 명시 폐기 후 원래 진입점에 돌아온다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    const originalDialog = h.dialog();
    await h.user.click(within(h.dialog()).getByRole("button", { name: "취소" }));
    await screen.findByRole("alertdialog");
    expect(originalDialog).toBeInTheDocument();
    expect(h.posts()).toHaveLength(0);
    await h.user.click(screen.getByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(originalDialog).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "정책 가져오기" })).toHaveFocus();
  });
  it("파일에 민감값이 있으면 이름/원문 DOM을 보호하고 명시 확인 후 전송값은 보존한다", async () => {
    const h = await setupImport();
    const secret = `vc_sk_${"x".repeat(40)}`;
    const body = {
      policies: [
        {
          id: "public_policy",
          name: secret,
          rules: [{ id: "public_rule", conditions: { access_token: secret } }],
        },
      ],
    };
    await h.open();
    await h.file(body, `${secret}.json`);
    await h.plan();
    await h.confirm();
    expect(h.dialog().outerHTML).not.toContain(secret);
    expect(screen.getByLabelText("정책 JSON 파일")).toHaveValue("");
    expect(screen.getByRole("button", { name: "검토한 정책 적용" })).toHaveAttribute("aria-disabled", "true");
    await h.user.click(screen.getByRole("checkbox", { name: /보호된 값을 표시/ }));
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    expect(h.posts()[1]?.options.body).toEqual(body);
    expect(window.location.href).not.toContain(secret);
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
  });
  it("활성화·기존 규칙 제거는 별도 확인이 없으면 캡처 적용도 전송하지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file({ policies: [{ id: "public_policy", name: "적용 후보", enabled: true, rules: [] }] });
    await h.plan();
    await h.confirm();
    const apply = h.capture("검토한 정책 적용");
    act(apply);
    expect(h.posts()).toHaveLength(1);
    await h.user.click(screen.getByRole("checkbox", { name: /사용 상태인 정책/ }));
    await h.user.click(screen.getByRole("checkbox", { name: /기존 규칙 제거/ }));
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    expect(h.posts()).toHaveLength(2);
  });
  it("latest 전체 원본이 바뀌면 apply 전 POST0이며 이전 승인을 폐기한다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const old = h.capture("검토한 정책 적용");
    h.response.row.description = "외부 변경";
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await h.idle();
    expect(screen.getByText(/현재 정책이 바뀌었습니다/)).toBeVisible();
    act(old);
    expect(h.posts()).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "서버 계획과 변경 내용" })).not.toBeInTheDocument();
  });
  it("동기 중복·pending 취소를 차단하고 확인된 ACK 뒤 GET 실패를 재적용 실패로 바꾸지 않는다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    const held = deferred<unknown>();
    h.response.post = () => held.promise;
    const apply = h.capture("검토한 정책 적용");
    act(() => {
      apply();
      apply();
    });
    await waitFor(() => expect(h.posts()).toHaveLength(2));
    await h.user.click(within(h.dialog()).getByRole("button", { name: "취소" }));
    expect(h.dialog()).toBeVisible();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    h.response.export = () => {
      throw new AppError("public error", { kind: "network" });
    };
    await act(async () => {
      held.resolve(acknowledgement(importBody, false));
      await held.promise;
    });
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    await screen.findByText(/현재 목록 조회를 마치지 못했습니다/);
    expect(screen.queryByText("적용 여부를 확인할 수 없습니다.")).not.toBeInTheDocument();
    act(apply);
    expect(h.posts()).toHaveLength(2);
  });
  it("unknown ACK는 자동 재전송 없이 잠그고 실패/바뀐 GET는 유지, 명시 same GET 뒤 새 계획만 허용한다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    h.response.post = () => ({});
    const old = h.capture("검토한 정책 적용");
    act(old);
    await screen.findByText("적용 여부를 확인할 수 없습니다.");
    await h.idle();
    act(old);
    expect(h.posts()).toHaveLength(2);
    expect(screen.getByLabelText("정책 JSON 파일")).toBeDisabled();
    const originalExport = h.response.export;
    h.response.export = () => {
      throw new AppError("public error", { kind: "network" });
    };
    await h.user.click(screen.getByRole("button", { name: "현재 내용 다시 조회" }));
    await h.idle();
    expect(screen.getByText("적용 여부를 확인할 수 없습니다.")).toBeVisible();
    h.response.export = originalExport;
    h.response.row.description = "달라진 현재값";
    await h.user.click(screen.getByRole("button", { name: "현재 내용 다시 조회" }));
    await h.idle();
    expect(screen.getByText("적용 여부를 확인할 수 없습니다.")).toBeVisible();
    h.response.row.description = "이전 설명";
    await h.user.click(screen.getByRole("button", { name: "현재 내용 다시 조회" }));
    await h.idle();
    await screen.findByText(/현재 원본이 이전과 같음/);
    act(old);
    expect(h.posts()).toHaveLength(2);
    expect(screen.getByRole("button", { name: "서버 계획 확인" })).toBeVisible();
  });
  it("readonly 원문 백업은 정확한 응답 bytes를 다운로드하고 응답 body를 QueryCache에 넣지 않는다", async () => {
    const h = await setupImport();
    h.update({ readOnly: true });
    await h.open();
    const raw =
      '{"version":1,"count":1,"policies":[{"id":"public_policy","name":"공개","description":"","enabled":false,"priority":100,"rollout_percent":100,"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z","rules":[{"id":"r","policy_id":"public_policy","name":"","enabled":false,"priority":100,"conditions":{"future":9007199254740993},"actions":{},"created_at":"2026-10-01T00:00:00Z","updated_at":"2026-10-01T00:00:00Z"}]}]}';
    h.response.export = () => raw;
    const create = vi.fn<(blob: Blob) => string>(() => "blob:public-policy");
    class DownloadURL extends URL {
      static override createObjectURL = create;
      static override revokeObjectURL = vi.fn();
    }
    vi.stubGlobal("URL", DownloadURL);
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    await h.user.click(screen.getByRole("checkbox", { name: /민감값을 포함할 수 있는 원문/ }));
    await h.user.click(screen.getByRole("button", { name: "현재 정책 백업 내려받기" }));
    await h.idle();
    expect(click).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledOnce();
    const blob = create.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob).toBeInstanceOf(Blob);
    if (!blob) throw new Error("missing blob");
    const text = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsText(blob);
    });
    expect(text).toBe(raw);
    expect(h.posts()).toHaveLength(0);
    expect(
      JSON.stringify(
        h.view.client
          .getQueryCache()
          .getAll()
          .map((query) => query.state.data),
      ),
    ).not.toContain("9007199254740993");
  });
  it("백업 파일 재선택으로 그 파일의 대상만 복원하며 파일 밖 정책을 지우지 않는다", async () => {
    const h = await setupImport();
    const backup = JSON.parse(JSON.stringify(h.response.export())) as PolicyImportBody;
    h.response.row.name = "백업 이후 바뀐 이름";
    h.response.rows.push({
      ...structuredClone(h.response.row),
      id: "unrelated_policy",
      name: "백업에 없는 정책",
      rules: [],
    });
    h.response.post = (options) => {
      const body = options.body as PolicyImportBody;
      if (!(options.query as { dry_run?: string } | undefined)?.dry_run) {
        const target = body.policies[0];
        if (!target) throw new Error("missing fixture target");
        h.response.row.name = target.name;
      }
      return acknowledgement(body, (options.query as { dry_run?: string } | undefined)?.dry_run === "1");
    };
    await h.open();
    await h.file(backup, "policy-backup.json");
    await h.plan();
    await h.confirm();
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    expect(h.response.row.name).toBe("이전 공개 정책");
    expect(h.response.rows).toHaveLength(2);
    expect(h.response.rows[1]?.name).toBe("백업에 없는 정책");
    expect(h.posts()[1]?.options.body).toEqual(backup);
  });
  it("확정 적용 뒤 일반 목록 GET으로 갱신하여 창을 닫으면 저장된 이름이 보인다", async () => {
    const h = await setupImport();
    await h.open();
    await h.file();
    await h.plan();
    await h.confirm();
    h.response.post = (options) => {
      h.response.row.name = "파일의 공개 정책";
      return acknowledgement(options.body as PolicyImportBody, false);
    };
    await h.user.click(screen.getByRole("button", { name: "검토한 정책 적용" }));
    await screen.findByText("정책 가져오기 적용 응답을 확인했습니다.");
    await h.idle();
    await h.user.click(within(h.dialog()).getByRole("button", { name: "닫기" }));
    expect(screen.getByRole("table", { name: "AI 정책 목록" })).toHaveTextContent("파일의 공개 정책");
    expect(h.api.calls.filter((call) => call.key === "GET /admin/policies")).toHaveLength(2);
    expect(h.posts()).toHaveLength(2);
  });
  it.each(["http", "contract"] as const)("%s 오류 원문과 민감 Request ID는 표시하지 않는다", async (kind) => {
    const h = await setupImport();
    const secret = `vc_sk_${"q".repeat(40)}`;
    h.response.post = () => {
      throw new AppError(`RAW_SERVER_VALUE_${secret}`, { kind, status: 409, requestId: secret });
    };
    await h.open();
    await h.file();
    await h.user.click(screen.getByRole("button", { name: "서버 계획 확인" }));
    await screen.findByText("확인이 필요합니다.");
    await h.idle();
    expect(h.dialog().outerHTML).not.toContain(secret);
    expect(h.dialog().outerHTML).not.toContain("RAW_SERVER_VALUE");
    expect(screen.getByText(/요청 ID:/)).toHaveTextContent("표시하지 않습니다");
    expect(h.posts()).toHaveLength(1);
  });
});
