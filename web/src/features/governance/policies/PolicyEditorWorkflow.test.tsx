import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "@/shared/api/error";
import { deferred, policy, savePath, setupEditor } from "./policy-editor-test-harness";

function must<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("missing public fixture");
  return value;
}
async function openUnconfirmedEditor() {
  const current = await setupEditor();
  const originalSave = current.response.save;
  current.response.save = () => ({});
  await current.user.click(current.open());
  await current.editName();
  await current.user.click(current.save());
  await screen.findByText("저장 여부를 확인할 수 없습니다.");
  await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
  return { ...current, originalSave };
}
describe("실제 편집·검토·whole-upsert·재조회", () => {
  it("이름 변경을 비교하고 미편집 복수 규칙과 ID·원문을 보존한다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    await current.editName();
    expect(screen.getByRole("region", { name: "정책 편집 읽기 안내" })).toBeVisible();
    expect(screen.getByRole("table", { name: "정책 변경 전후" })).toHaveTextContent("바꾼 초안");
    expect(current.api.bodies(savePath)).toEqual([]);
    await current.user.click(current.save());
    expect(await screen.findByText("비활성 정책을 저장했습니다.")).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "닫기" })).toHaveAttribute("aria-disabled", "false"),
    );
    expect(current.api.bodies(savePath)).toEqual([
      {
        id: policy.id,
        name: "바꾼 초안",
        description: policy.description,
        enabled: false,
        priority: 100,
        rollout_percent: 37,
        rules: policy.rules?.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled,
          priority: rule.priority,
          conditions: rule.conditions,
          actions: rule.actions,
        })),
      },
    ]);
    expect(current.api.bodies("GET /admin/policies")).toHaveLength(3);
    await current.user.click(screen.getByRole("button", { name: "닫기" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });
  it("변경 없는 검토는 POST하지 않는다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(screen.getByText("변경된 내용이 없습니다.")).toBeVisible();
    expect(current.api.bodies(savePath)).toEqual([]);
  });
  it("일반 JSON 편집과 새 규칙 추가를 허용한다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    const first = within(screen.getByRole("group", { name: "규칙 1" }));
    await current.user.clear(first.getByRole("textbox", { name: "조건 JSON" }));
    await current.user.paste('{"model":"changed","future":{"Nested":[1,null]}}');
    await current.user.click(screen.getByRole("button", { name: "규칙 추가" }));
    expect(screen.getByRole("group", { name: "규칙 3" })).toBeVisible();
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await current.user.click(current.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(current.api.bodies(savePath)[0]).toMatchObject({
      rules: [
        { id: "rule_public_one", conditions: { model: "changed", future: { Nested: [1, null] } } },
        { id: "rule_public_two" },
        { name: "", conditions: {}, actions: {} },
      ],
    });
  });
  it("삭제 취소/명시 삭제를 구분하고 마지막 규칙 제거는 추가 확인한다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    for (const name of ["규칙 1", "규칙 2"]) {
      const rule = within(screen.getByRole("group", { name }));
      await current.user.click(rule.getByRole("button", { name: "규칙 삭제" }));
      await current.user.click(rule.getByRole("button", { name: "삭제 취소" }));
      expect(rule.getByRole("textbox", { name: "규칙 이름" })).toBeVisible();
      await current.user.click(rule.getByRole("button", { name: "규칙 삭제" }));
      await current.user.click(rule.getByRole("button", { name: "삭제 확인" }));
    }
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(current.api.bodies(savePath)).toEqual([]);
    expect(screen.getByRole("checkbox", { name: "모든 규칙을 비우는 변경을 확인했습니다" })).toHaveFocus();
    await current.user.click(
      screen.getByRole("checkbox", { name: "모든 규칙을 비우는 변경을 확인했습니다" }),
    );
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    await current.user.click(current.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(current.api.bodies(savePath)[0]).toMatchObject({ rules: [] });
  });
  it("잘못된 JSON의 첫 오류 초점을 유지하고 원문 오류를 출력하지 않는다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    const field = must(screen.getAllByRole("textbox", { name: "조건 JSON" })[0]);
    await current.user.clear(field);
    await current.user.paste("{invalid_public");
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(field).toHaveFocus();
    expect(screen.getByRole("alert")).not.toHaveTextContent("invalid_public");
    expect(current.api.bodies(savePath)).toEqual([]);
  });
  it("보호된 JSON은 배경/입력/비교/속성에 없지만 명시 유지로 원문 전송한다", async () => {
    const marker = `corp_${"synthetic".repeat(6)}`;
    const source = structuredClone(policy);
    must(source.rules?.[0]).conditions = { model: marker };
    const current = await setupEditor(source);
    current.update({ prefixes: ["corp_"] });
    await current.user.click(current.open());
    expect(document.body.innerHTML).not.toContain(marker);
    expect(screen.getByRole("button", { name: "조건 JSON 전체 교체" })).toBeVisible();
    await current.editName();
    expect(document.body.innerHTML).not.toContain(marker);
    await current.user.click(current.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(current.api.bodies(savePath)[0]).toMatchObject({ rules: [{ conditions: { model: marker } }, {}] });
  });
  it("보호 JSON의 전체 교체는 빈 입력부터 시작하며 마스킹 문구를 전송하지 않는다", async () => {
    const source = structuredClone(policy);
    must(source.rules?.[0]).conditions = { password: "synthetic_only" };
    const current = await setupEditor(source);
    await current.user.click(current.open());
    await current.user.click(screen.getByRole("button", { name: "조건 JSON 전체 교체" }));
    const first = within(screen.getByRole("group", { name: "규칙 1" })).getByRole("textbox", {
      name: "조건 JSON",
    });
    expect(first).toHaveValue("");
    await current.user.click(first);
    await current.user.paste('{"model":"replacement"}');
    await current.editName();
    await current.user.click(current.save());
    await screen.findByText("비활성 정책을 저장했습니다.");
    expect(current.api.bodies(savePath)[0]).toMatchObject({
      rules: [{ conditions: { model: "replacement" } }, {}],
    });
  });
  it("현재 접두사가 바뀌면 기존 textarea 원문을 숨기고 옛 검토는 보내지 않는다", async () => {
    const marker = `corp_${"synthetic".repeat(6)}`;
    const source = structuredClone(policy);
    source.description = marker;
    const current = await setupEditor(source);
    await current.user.click(current.open());
    await current.editName();
    const old = current.captureSave();
    current.update({ prefixes: ["corp_"] });
    expect(document.body.innerHTML).not.toContain(marker);
    await act(async () => old());
    expect(current.api.bodies(savePath)).toEqual([]);
  });
  it("확인된 저장 뒤 GET 실패는 저장 실패나 재POST로 바꾸지 않는다", async () => {
    const current = await setupEditor();
    const original = current.response.save;
    current.response.save = (options) => {
      const result = original(options);
      current.response.list = () => {
        throw new AppError("private error", { kind: "http", status: 503, requestId: "public_req" });
      };
      return result;
    };
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    expect(await screen.findByText("저장은 완료했지만 목록을 갱신하지 못했습니다.")).toBeVisible();
    expect(screen.getByText("비활성 정책을 저장했습니다.")).toBeVisible();
    expect(current.api.bodies(savePath)).toHaveLength(1);
    current.response.list = () => ({ policies: current.response.rows });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(screen.queryByText("저장은 완료했지만 목록을 갱신하지 못했습니다.")).not.toBeInTheDocument(),
    );
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("확인된 ACK 뒤 캐시 무효화 오류도 미확정 잠금으로 되돌리지 않는다", async () => {
    const current = await setupEditor();
    const invalidate = vi
      .spyOn(current.view.client, "invalidateQueries")
      .mockRejectedValueOnce(new Error("private cache error"));
    await current.user.click(current.open());
    await current.editName();
    const old = current.captureSave();
    await current.user.click(current.save());
    expect(await screen.findByText("저장은 완료했지만 목록을 갱신하지 못했습니다.")).toBeVisible();
    expect(screen.getByText("비활성 정책을 저장했습니다.")).toBeVisible();
    expect(screen.queryByText("저장 여부를 확인할 수 없습니다.")).not.toBeInTheDocument();
    await act(async () => old());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute(
        "aria-disabled",
        "false",
      ),
    );
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(screen.queryByText("저장은 완료했지만 목록을 갱신하지 못했습니다.")).not.toBeInTheDocument(),
    );
    expect(current.api.bodies(savePath)).toHaveLength(1);
    invalidate.mockRestore();
  });
  it("불명 ACK는 자동 재시도하거나 완료로 닫지 않는다", async () => {
    const current = await setupEditor();
    current.response.save = () => ({});
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    expect(await screen.findByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
    expect(screen.queryByText("비활성 정책을 저장했습니다.")).not.toBeInTheDocument();
    expect(current.dialog()).toBeVisible();
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("미저장 불명 ACK 뒤 수동 조회 전 재클릭도 두 번째 POST를 보내지 않는다", async () => {
    const current = await setupEditor();
    // The response is ambiguous but this fixture deliberately leaves the server
    // baseline unchanged. This is not evidence that a real missing ACK did not commit.
    current.response.save = () => ({});
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    await screen.findByText("저장 여부를 확인할 수 없습니다.");
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
    await current.user.click(current.save());
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("불명 ACK 뒤 캡처 콜백과 다시 편집한 새 검토도 조회 없이 전송하지 않는다", async () => {
    const current = await openUnconfirmedEditor();
    const old = current.captureSave();
    const reads = current.api.bodies("GET /admin/policies").length;
    await act(async () => {
      old();
      old();
    });
    await current.user.click(screen.getByRole("button", { name: "다시 편집" }));
    await current.editName("다시 바꾼 이름");
    expect(current.save()).toHaveAttribute("aria-disabled", "true");
    const next = current.captureSave();
    await act(async () => next());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    expect(current.api.bodies("GET /admin/policies")).toHaveLength(reads);
    expect(screen.getByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
  });
  it("미확정 안내는 수동 조회 중에도 유지되고 동일 원본 성공 뒤 명시 저장만 허용한다", async () => {
    const current = await openUnconfirmedEditor();
    const held = deferred<unknown>();
    current.response.list = () => held.promise;
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.api.bodies("GET /admin/policies")).toHaveLength(3));
    expect(screen.getByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
    expect(current.save()).toHaveAttribute("aria-disabled", "true");
    await act(async () => held.resolve({ policies: [structuredClone(policy)] }));
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-disabled", "false"));
    expect(screen.queryByText("저장 여부를 확인할 수 없습니다.")).not.toBeInTheDocument();
    expect(current.api.bodies(savePath)).toHaveLength(1);
    current.response.list = () => ({ policies: current.response.rows });
    current.response.save = current.originalSave;
    await current.user.click(current.save());
    expect(await screen.findByText("비활성 정책을 저장했습니다.")).toBeVisible();
    expect(current.api.bodies(savePath)).toHaveLength(2);
  });
  for (const response of ["changed", "missing", "failed"] as const) {
    it(`미확정 뒤 ${response} 수동 조회는 저장 잠금과 안내를 해제하지 않는다`, async () => {
      const current = await openUnconfirmedEditor();
      current.response.list = () => {
        if (response === "failed") throw new AppError("private response", { kind: "http", status: 503 });
        return { policies: response === "missing" ? [] : [{ ...policy, description: "다른 원본" }] };
      };
      await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "목록 다시 조회" })).toHaveAttribute("aria-busy", "false"),
      );
      expect(screen.getByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
      expect(current.save()).toHaveAttribute("aria-disabled", "true");
      await act(async () => current.captureSave()());
      expect(current.api.bodies(savePath)).toHaveLength(1);
      expect(document.body.innerHTML).not.toContain("private response");
    });
  }
  it("실제로 저장된 불명 ACK는 수동 조회의 변경 원본 때문에 재저장을 계속 막는다", async () => {
    const current = await setupEditor();
    const original = current.response.save;
    current.response.save = (options) => {
      original(options);
      return {};
    };
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    await screen.findByText("저장 여부를 확인할 수 없습니다.");
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await screen.findByText(/원본이 바뀌었거나 현재 목록이 확정되지 않았습니다/u);
    expect(current.save()).toHaveAttribute("aria-disabled", "true");
    await act(async () => current.captureSave()());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    expect(screen.queryByText("비활성 정책을 저장했습니다.")).not.toBeInTheDocument();
  });
  it("전송 후 오류도 잠그며 readonly 수동 조회 성공은 쓰기 허가를 대신하지 않는다", async () => {
    const current = await setupEditor();
    current.response.save = () => {
      throw new AppError("private upstream", { kind: "http", status: 503, requestId: "public_retry" });
    };
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    await screen.findByText("저장 여부를 확인할 수 없습니다.");
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
    expect(screen.getByText("요청 ID: public_retry")).toBeVisible();
    current.update({ mode: "read_only" });
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() =>
      expect(screen.queryByText("저장 여부를 확인할 수 없습니다.")).not.toBeInTheDocument(),
    );
    expect(current.save()).toHaveAttribute("aria-disabled", "true");
    await act(async () => current.captureSave()());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    expect(current.api.bodies("GET /admin/policies")).toHaveLength(3);
  });
  it("계정이 바뀐 뒤 늦은 동일 원본 조회로 폐기된 저장 콜백을 되살리지 않는다", async () => {
    const current = await openUnconfirmedEditor();
    const old = current.captureSave();
    const held = deferred<unknown>();
    current.response.list = () => held.promise;
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.api.bodies("GET /admin/policies")).toHaveLength(3));
    current.update({ principal: "public_b" });
    await act(async () => held.resolve({ policies: [structuredClone(policy)] }));
    current.update({ principal: "public_a" });
    await act(async () => old());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("서버 available 화면의 읽기 권한 회수 중 미확정 응답도 복구 뒤 잠금과 안내를 유지한다", async () => {
    const current = await setupEditor();
    current.update({ serverAvailable: true });
    const held = deferred<unknown>();
    current.response.save = () => held.promise;
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(current.save());
    await waitFor(() => expect(current.api.bodies(savePath)).toHaveLength(1));
    const originalDialog = current.dialog();
    current.update({ scopes: ["admin:write"] });
    expect(current.dialog()).toBe(originalDialog);
    await act(async () => held.resolve({}));
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-busy", "false"));
    current.update({ scopes: ["security:read", "admin:write"] });
    expect(current.dialog()).toBe(originalDialog);
    expect(screen.getByText("저장 여부를 확인할 수 없습니다.")).toBeVisible();
    await current.user.click(screen.getByRole("button", { name: "다시 편집" }));
    await current.user.click(screen.getByRole("button", { name: "변경 내용 검토" }));
    expect(current.save()).toHaveAttribute("aria-disabled", "true");
    await act(async () => current.captureSave()());
    expect(current.api.bodies(savePath)).toHaveLength(1);
    await current.user.click(screen.getByRole("button", { name: "목록 다시 조회" }));
    await waitFor(() => expect(current.save()).toHaveAttribute("aria-disabled", "false"));
    expect(screen.queryByText("저장 여부를 확인할 수 없습니다.")).not.toBeInTheDocument();
    expect(current.api.bodies(savePath)).toHaveLength(1);
  });
  it("dirty 취소는 계속 편집/명시 폐기를 제공하고 저장하지 않는다", async () => {
    const current = await setupEditor();
    await current.user.click(current.open());
    await current.editName();
    await current.user.click(screen.getByRole("button", { name: "취소" }));
    expect(screen.getByRole("alertdialog")).toBeVisible();
    await current.user.click(screen.getByRole("button", { name: "계속 편집" }));
    expect(current.dialog()).toBeVisible();
    await current.user.click(screen.getByRole("button", { name: "취소" }));
    await current.user.click(screen.getByRole("button", { name: "변경 버리기" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(current.api.bodies(savePath)).toEqual([]);
  });
});
