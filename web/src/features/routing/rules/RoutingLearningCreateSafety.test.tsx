import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import {
  approved,
  createAndSettle,
  createPath,
  deferred,
  discard,
  expectNoOtherWrites,
  fetchLearningPositive,
  impactLabel,
  invoke,
  learningPath,
  learningToasts,
  listPath,
  manualSettled,
  openRecommendation,
  recommendation,
  rereview,
  setupLearning,
  storedCreatedAt,
  successMessage,
  zeroCreatedAt,
} from "./routing-learning-create-test-harness";

describe("학습 추천 생성 실제 경로의 구간·영향 동의", () => {
  it("정상 대조: 실제 학습 GET과 명시 동의를 거쳐 정확한 8필드 POST 한 번을 보낸다", async () => {
    const current = await setupLearning();
    const { dialog } = await approved(current);
    expect(current.count(createPath)).toBe(0);
    await createAndSettle(current, dialog);
    expect(current.calls.find((call) => call.key === learningPath)?.query).toEqual({ window: "7d" });
    expect(current.calls.filter((call) => call.key === createPath).map((call) => call.body)).toEqual([
      {
        match_pattern: "*",
        target_model: recommendation.recommended_model,
        target_provider: "",
        min_complexity: 0,
        max_complexity: 33,
        priority: 100,
        enabled: true,
        note: "학습 추천 적용 (coding/low)",
      },
    ]);
    expect(current.records.size).toBe(1);
    expect(current.records.get("learned_rule_1")?.created_at).toBe(storedCreatedAt);
    expect(learningToasts().success).toHaveBeenCalledWith(successMessage);
    expect(current.publishedLists.at(-1)).toEqual({ rules: [...current.records.values()] });
    expect(dialog).toBeInTheDocument();
    expectNoOtherWrites(current);
  });

  it.each([
    ["low", 0, 33],
    ["medium", 34, 66],
    ["high", 67, 100],
  ] as const)("%s 추천의 실제 POST 복잡도는 서버 학습 구간 %i..%i와 일치한다", async (bucket, min, max) => {
    const current = await setupLearning({ bucket });
    const { dialog } = await approved(current);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
    expect(current.calls.find((call) => call.key === createPath)?.body).toMatchObject({
      min_complexity: min,
      max_complexity: max,
    });
    expectNoOtherWrites(current);
  });

  it("알 수 없는 추천 구간은 전체 0..100 범위로 넓혀 생성하지 않는다", async () => {
    const current = await setupLearning({ bucket: "future-unknown" });
    const label = `${current.selected.recommended_model} 추천을 규칙으로 적용`;
    await current.user.click(screen.getByRole("button", { name: label }));
    // Exercise the real closure too, not only the native disabled attribute.
    await invoke(current.capture(label));
    expect(screen.queryByRole("dialog", { name: "학습 추천으로 규칙 만들기" })).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(0);
    expect(learningToasts().success).not.toHaveBeenCalled();
    expectNoOtherWrites(current);
  });

  it("라우팅 영향에 명시 동의하지 않은 실제 확인과 callback은 POST 하지 않는다", async () => {
    const current = await setupLearning();
    const { dialog } = await openRecommendation(current);
    expect(within(dialog).getByRole("checkbox", { name: impactLabel })).not.toBeChecked();
    await current.user.click(within(dialog).getByRole("button", { name: "규칙 만들기" }));
    await invoke(current.capture("규칙 만들기"));
    expect(current.count(createPath)).toBe(0);
    expectNoOtherWrites(current);
  });

  it("열린 추천 확인창에서 쓰기 권한을 회수하면 실제 확인 클릭도 POST 하지 않는다", async () => {
    const current = await setupLearning();
    const { dialog, captured } = await approved(current);
    current.update({ scopes: ["routing:read"] });
    expect(screen.getByText("라우팅 변경 권한(routing:write)이 없어 조회만 할 수 있습니다.")).toBeVisible();
    expect(dialog).toBeInTheDocument();
    await current.user.click(within(dialog).getByRole("button", { name: "규칙 만들기" }));
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    expectNoOtherWrites(current);
  });

  it("서버 저장 뒤 빈 ACK는 성공 toast나 자동 닫기로 처리하지 않는다", async () => {
    const current = await setupLearning();
    current.response.create = () => ({});
    const { dialog } = await approved(current);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
    expect(current.records.size).toBe(1);
    expect(learningToasts().success).not.toHaveBeenCalled();
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(dialog).toBeInTheDocument();
    expectNoOtherWrites(current);
  });
});

describe("실제 추천 Query와 승인 세대", () => {
  it("정상 추천 재조회도 이전 동의를 퇴역시키며 명시 재검토와 새 동의만 생성한다", async () => {
    const current = await setupLearning();
    const { dialog, captured } = await approved(current);
    await fetchLearningPositive(current);
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    expect(within(dialog).getByRole("button", { name: "규칙 만들기" })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
    await rereview(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("정상 Query.fetch 뒤 최신 행 callback도 React 알림 전 새 pending에서는 창을 열지 않는다", async () => {
    const current = await setupLearning();
    const query = await fetchLearningPositive(current);
    const trigger = screen.getByRole("button", {
      name: `${current.selected.recommended_model} 추천을 규칙으로 적용`,
    });
    act(() => trigger.focus());
    const open = current.capture(`${current.selected.recommended_model} 추천을 규칙으로 적용`);
    const held = deferred<unknown>();
    current.response.learning = () => held.promise;
    const before = current.count(learningPath);
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = query.fetch().catch(() => undefined);
      expect(query.state.fetchStatus).toBe("fetching");
      void open();
    });
    try {
      expect(current.count(learningPath)).toBe(before + 1);
      expect(
        screen.getByRole("button", { name: `${current.selected.recommended_model} 추천을 규칙으로 적용` }),
      ).toBe(trigger);
      expect(trigger).toHaveFocus();
      expect(screen.queryByRole("dialog", { name: "학습 추천으로 규칙 만들기" })).not.toBeInTheDocument();
      expect(current.count(createPath)).toBe(0);
    } finally {
      current.response.learning = undefined;
      await act(async () => {
        held.resolve(current.report);
        await pending;
      });
    }
    const { dialog } = await approved(current);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("같은 timestamp의 실제 cache 성공 A→B→A는 기존 검토 callback을 부활시키지 않는다", async () => {
    const current = await setupLearning();
    const query = await fetchLearningPositive(current);
    const { dialog, captured } = await approved(current);
    const original = query.state.data;
    const timestamp = query.state.dataUpdatedAt;
    const count = query.state.dataUpdateCount;
    act(() => {
      query.setData(
        { ...current.report, recommendations: [{ ...current.selected, samples: 81 }] },
        { updatedAt: timestamp, manual: true },
      );
      query.setData(original, { updatedAt: timestamp, manual: true });
      void captured();
    });
    expect(query.state.dataUpdatedAt).toBe(timestamp);
    expect(query.state.dataUpdateCount).toBe(count + 2);
    expect(query.state.data).toEqual(original);
    expect(current.count(createPath)).toBe(0);
    await rereview(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("실제 pending 취소가 동일 data/count로 돌아와도 승인 serial은 퇴역한다", async () => {
    const current = await setupLearning();
    const query = await fetchLearningPositive(current);
    const { dialog, captured } = await approved(current);
    const data = query.state.data;
    const count = query.state.dataUpdateCount;
    const held = deferred<unknown>();
    current.response.learning = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = query.fetch().catch(() => undefined);
    });
    expect(query.state.fetchStatus).toBe("fetching");
    await act(async () => {
      await current.view.client.cancelQueries({ queryKey: query.queryKey, exact: true });
    });
    expect(query.state.fetchStatus).toBe("idle");
    expect(query.state.data).toBe(data);
    expect(query.state.dataUpdateCount).toBe(count);
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    current.response.learning = undefined;
    await act(async () => {
      held.resolve(current.report);
      await pending;
    });
    await rereview(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it.each(["since", "recommendation"] as const)(
    "%s 변경은 기존 창에서 다른 추천으로 재승인하지 않는다",
    async (field) => {
      const current = await setupLearning();
      const { dialog, captured } = await approved(current);
      current.response.learning = () =>
        field === "since"
          ? { ...current.report, since: "2026-09-26T00:00:00Z" }
          : {
              ...current.report,
              recommendations: [{ ...current.selected, recommended_model: "different-public-model" }],
            };
      await fetchLearningPositive(current);
      await invoke(captured);
      await current.user.click(within(dialog).getByRole("button", { name: "생성 내용 다시 검토" }));
      expect(current.count(createPath)).toBe(0);
      expect(within(dialog).getByRole("button", { name: "규칙 만들기" })).toHaveAttribute(
        "aria-disabled",
        "true",
      );
      expect(dialog).toHaveTextContent("원래 추천이나 집계 기준이 변경되었습니다.");
    },
  );

  it("기간 URL 7d→30d→7d 왕복은 옛 창·Query를 폐기하고 새 조회만 승인한다", async () => {
    const current = await setupLearning();
    const original = current.actualLearningQuery();
    const { dialog, captured } = await approved(current);
    const refresh = current.capture("추천 다시 조회");
    // Programmatic history/URL boundary, not a forced click behind the modal.
    current.navigate("/routing/rules/learning?window=30d");
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await waitFor(() => expect(current.actualLearningQuery().state.status).toBe("success"));
    expect(current.calls.filter((call) => call.key === learningPath).at(-1)?.query).toEqual({
      window: "30d",
    });
    current.navigate("/routing/rules/learning?window=7d");
    await waitFor(() => expect(current.actualLearningQuery().state.status).toBe("success"));
    expect(current.actualLearningQuery()).not.toBe(original);
    const reads = current.count(learningPath);
    await invoke(captured);
    await invoke(refresh);
    expect(current.count(learningPath)).toBe(reads);
    expect(current.count(createPath)).toBe(0);
    const second = await approved(current);
    await createAndSettle(current, second.dialog);
    expect(current.count(createPath)).toBe(1);
  });
});

describe("현재 권한·주체와 추천 창의 수명", () => {
  it.each([
    ["쓰기 권한", { scopes: ["routing:read"] }, { scopes: ["routing:read", "routing:write"] }],
    ["읽기 전용", { readOnly: true }, { readOnly: false }],
    [
      "표시 보호 기준",
      { prefixes: ["vc_sk_", "vc_sa_", "custom_private_"] },
      { prefixes: ["vc_sk_", "vc_sa_"] },
    ],
  ])("%s 왕복은 창을 유지하되 이전 동의를 영구 퇴역시킨다", async (_label, next, restore) => {
    const current = await setupLearning();
    const { dialog, captured } = await approved(current);
    current.update(next);
    expect(dialog).toBeInTheDocument();
    current.update(restore);
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    await rereview(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it.each([
    ["계정", { userId: "operator-b" }, { userId: "operator-a" }],
    ["팀", { teamId: "team-b" }, { teamId: "team-a" }],
    ["역할", { role: "readonly_admin", roles: ["readonly_admin"] }, { role: "admin", roles: ["admin"] }],
    ["소유 기능", { owner: "routing.preview" }, { owner: "routing.rules" }],
    ["인증 모드", { mode: "legacy" as const }, { mode: "authenticated" as const }],
    ["읽기 권한", { scopes: ["routing:write"] }, { scopes: ["routing:read", "routing:write"] }],
    ["기능 접근", { permitted: false }, { permitted: true }],
  ])("%s A→B→A는 옛 창·조회 callback을 폐기하고 새 현재 추천만 허용한다", async (_label, next, restore) => {
    const current = await setupLearning();
    const original = current.actualLearningQuery();
    const { dialog, captured } = await approved(current);
    const refresh = current.capture("추천 다시 조회");
    const listRefresh = current.capture("목록 다시 조회");
    current.update(next);
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    current.update(restore);
    await waitFor(() => expect(current.actualLearningQuery().state.status).toBe("success"));
    expect(current.actualLearningQuery()).not.toBe(original);
    const reportReads = current.count(learningPath);
    const reads = current.count(listPath);
    await invoke(captured);
    await invoke(refresh);
    await invoke(listRefresh);
    expect(current.count(createPath)).toBe(0);
    expect(current.count(learningPath)).toBe(reportReads);
    expect(current.count(listPath)).toBe(reads);
    const second = await approved(current);
    await createAndSettle(current, second.dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("session epoch 변경은 옛 검토를 새 인증으로 전송하지 않는다", async () => {
    const current = await setupLearning();
    const { dialog, captured } = await approved(current);
    act(() => tokenStore.clearAll());
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    expect(learningToasts().success).not.toHaveBeenCalled();
  });

  it("held 추천 GET 뒤 주체 왕복은 늦은 이전 응답을 현재 Query에 게시하지 않는다", async () => {
    const current = await setupLearning();
    const original = await fetchLearningPositive(current);
    const held = deferred<unknown>();
    current.response.learning = () => held.promise;
    let pending: Promise<unknown> = Promise.resolve();
    act(() => {
      pending = original.fetch().catch(() => undefined);
    });
    expect(original.state.fetchStatus).toBe("fetching");
    current.response.learning = undefined;
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(current.actualLearningQuery().state.status).toBe("success"));
    current.update({ userId: "operator-a" });
    await waitFor(() => expect(current.actualLearningQuery().state.status).toBe("success"));
    const latest = current.actualLearningQuery();
    expect(latest).not.toBe(original);
    const reads = current.count(learningPath);
    await act(async () => {
      held.resolve({
        ...current.report,
        recommendations: [{ ...current.selected, recommended_model: "retired-model" }],
      });
      await pending;
    });
    expect(current.actualLearningQuery()).toBe(latest);
    expect(latest.state.data).toEqual(current.report);
    expect(current.count(learningPath)).toBe(reads);
    expect(screen.queryByText("retired-model")).not.toBeInTheDocument();
    const { dialog } = await approved(current);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it.each(["legacy", "open"] as const)(
    "실제 FeatureRoute의 %s 모드도 현재 read/write 정상 양성을 유지한다",
    async (mode) => {
      const current = await setupLearning({}, { mode });
      const { dialog } = await approved(current);
      await createAndSettle(current, dialog);
      expect(current.count(createPath)).toBe(1);
      expect(learningToasts().success).toHaveBeenCalledWith(successMessage);
    },
  );

  it("처음부터 readonly이면 학습 조회는 정상이고 추천 callback은 생성창을 열지 않는다", async () => {
    const current = await setupLearning({}, { readOnly: true });
    expect(current.count(learningPath)).toBe(1);
    expect(screen.getByTestId("learning-access")).toHaveTextContent("routing.rules:true:routing.rules");
    await invoke(current.capture(`${current.selected.recommended_model} 추천을 규칙으로 적용`));
    expect(screen.queryByRole("dialog", { name: "학습 추천으로 규칙 만들기" })).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(0);
  });
});

describe("추천 생성 ACK와 후속 조회", () => {
  it.each([
    ["필수 rule 누락", () => ({})],
    ["빈 ID", (rule: object) => ({ rule: { ...rule, id: "" } })],
    ["검토와 다른 값", (rule: object) => ({ rule: { ...rule, priority: 71 } })],
  ])("%s 뒤 수동 GET으로도 같은 창 POST 잠금을 해제하지 않는다", async (_label, reply) => {
    const current = await setupLearning();
    current.response.create = reply;
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    current.records.clear();
    const reads = current.count(listPath);
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    expect(current.count(listPath)).toBe(reads + 1);
    expect(current.publishedLists.at(-1)).toEqual({ rules: [] });
    await invoke(captured);
    await invoke(current.capture("규칙 만들기"));
    expect(current.count(createPath)).toBe(1);
    expect(learningToasts().success).not.toHaveBeenCalled();
    expectNoOtherWrites(current);
  });

  it("전송 뒤 HTTP 오류와 수동 조회 실패는 미확정을 유지하고 요청 ID 원문을 숨긴다", async () => {
    const current = await setupLearning();
    const marker = `vc_sk_${"s".repeat(48)}`;
    const failure = () => {
      throw new AppError("합성 오류", { kind: "http", status: 503, requestId: marker });
    };
    current.response.create = failure;
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    current.response.read = failure;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    await invoke(captured);
    expect(current.count(createPath)).toBe(1);
    expect(within(dialog).getByText("생성 여부를 확인하지 못했습니다.")).toBeVisible();
    expect(document.body.outerHTML).not.toContain(marker);
    expect(learningToasts().success).not.toHaveBeenCalled();
  });

  it("zero-time ACK 뒤 GET 실패는 생성 실패가 아니며 수동 GET만 복구한다", async () => {
    const current = await setupLearning();
    current.response.create = (rule) => {
      expect(rule.created_at).toBe(zeroCreatedAt);
      current.response.read = () => {
        throw new AppError("합성 후속 오류", { kind: "http", status: 503 });
      };
      return { rule };
    };
    const { dialog, captured } = await approved(current);
    await createAndSettle(current, dialog);
    expect(within(dialog).getByText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.")).toBeVisible();
    expect(within(dialog).queryByText("생성 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(learningToasts().success).toHaveBeenCalledWith(successMessage);
    await invoke(captured);
    current.response.read = undefined;
    await current.user.click(within(dialog).getByRole("button", { name: "목록 다시 조회" }));
    await manualSettled(dialog);
    expect(current.publishedLists.at(-1)).toEqual({ rules: [...current.records.values()] });
    expect(current.count(createPath)).toBe(1);
    expect(learningToasts().success).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["쓰기 회수", { scopes: ["routing:read"] }],
    ["readonly", { readOnly: true }],
  ])("전송 뒤 %s에도 현재 read의 유효 ACK는 성공이며 동기 중복은 POST1이다", async (_label, update) => {
    const current = await setupLearning();
    const held = deferred<unknown>();
    let reply: unknown;
    current.response.create = (rule) => {
      reply = { rule };
      return held.promise;
    };
    const { dialog, captured } = await approved(current);
    await act(async () => {
      void captured();
      void captured();
      await Promise.resolve();
    });
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    current.update(update);
    await invoke(captured);
    await act(async () => {
      held.resolve(reply);
    });
    await manualSettled(dialog);
    expect(learningToasts().success).toHaveBeenCalledWith(successMessage);
    expect(within(dialog).queryByText("생성 여부를 확인하지 못했습니다.")).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(1);
  });

  it("늦은 POST ACK는 새 주체가 실제 조회한 규칙 목록·알림을 바꾸지 않는다", async () => {
    const current = await setupLearning();
    const held = deferred<unknown>();
    let reply: unknown;
    current.response.create = (rule) => {
      reply = { rule };
      return held.promise;
    };
    const { dialog, captured } = await approved(current);
    await invoke(captured);
    await waitFor(() => expect(current.count(createPath)).toBe(1));
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    current.records.clear();
    await current.user.click(screen.getByRole("tab", { name: "라우팅 규칙" }));
    await screen.findByRole("table", { name: "복잡도 기반 라우팅 규칙 목록" });
    await waitFor(() => expect(current.actualListQuery().state.data).toEqual({ rules: [] }));
    const reads = current.count(listPath);
    await act(async () => {
      held.resolve(reply);
    });
    expect(current.count(listPath)).toBe(reads);
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    expect(learningToasts().success).not.toHaveBeenCalled();
  });

  it("확정 ACK 후 늦은 GET도 새 주체의 실제 목록을 덮지 않는다", async () => {
    const current = await setupLearning();
    const held = deferred<unknown>();
    current.response.read = () => held.promise;
    const { dialog, captured } = await approved(current);
    const before = current.count(listPath);
    await invoke(captured);
    await waitFor(() => expect(current.count(listPath)).toBe(before + 1));
    expect(learningToasts().success).toHaveBeenCalledWith(successMessage);
    const oldRows = [...current.records.values()];
    current.update({ userId: "operator-b" });
    await waitFor(() => expect(dialog).not.toBeInTheDocument());
    current.response.read = undefined;
    current.records.clear();
    await current.user.click(screen.getByRole("tab", { name: "라우팅 규칙" }));
    await screen.findByRole("table", { name: "복잡도 기반 라우팅 규칙 목록" });
    await waitFor(() => expect(current.actualListQuery().state.data).toEqual({ rules: [] }));
    const reads = current.count(listPath);
    const notices = learningToasts().success.mock.calls.length;
    await act(async () => {
      held.resolve({ rules: oldRows });
    });
    expect(current.actualListQuery().state.data).toEqual({ rules: [] });
    expect(current.count(listPath)).toBe(reads);
    expect(learningToasts().success).toHaveBeenCalledTimes(notices);
  });
});

describe("추천 표시·폐기 경계", () => {
  it("최초 추천 검토 초점은 제목에 놓이고 Tab은 실제 영향 동의로 이동한다", async () => {
    const current = await setupLearning();
    const { dialog } = await openRecommendation(current);
    const heading = within(dialog).getByRole("heading", { name: "생성 내용 검토" });
    await waitFor(() => expect(heading).toHaveFocus());
    const impact = within(dialog).getByRole("checkbox", { name: impactLabel });
    expect(impact).not.toBeChecked();
    await current.user.tab();
    expect(impact).toHaveFocus();
    await current.user.tab();
    const refresh = within(dialog).getByRole("button", { name: "추천 다시 조회" });
    expect(refresh).toHaveFocus();
    await fetchLearningPositive(current);
    expect(within(dialog).getByRole("button", { name: "추천 다시 조회" })).toBe(refresh);
    expect(refresh).toHaveFocus();
    const query = current.actualLearningQuery();
    const held = deferred<unknown>();
    current.response.learning = () => held.promise;
    const reads = current.count(learningPath);
    try {
      await current.user.click(refresh);
      await waitFor(() => expect(current.count(learningPath)).toBe(reads + 1));
      expect(query.state.fetchStatus).toBe("fetching");
      expect(refresh).toHaveAttribute("aria-busy", "true");
      expect(within(dialog).getByRole("button", { name: "추천 다시 조회" })).toBe(refresh);
      expect(refresh).toHaveFocus();
    } finally {
      current.response.learning = undefined;
      await act(async () => {
        held.resolve(current.report);
      });
    }
    await waitFor(() => expect(query.state.fetchStatus).toBe("idle"));
    expect(query.state.status).toBe("success");
    expect(within(dialog).getByRole("button", { name: "추천 다시 조회" })).toBe(refresh);
    expect(refresh).toHaveFocus();
    expect(current.count(createPath)).toBe(0);
    expectNoOtherWrites(current);
  });

  it("현재 prefix의 추천 모델·근거는 DOM에 원문을 표시하거나 POST하지 않는다", async () => {
    const marker = `custom_private_${"s".repeat(48)}`;
    const current = await setupLearning(
      { recommended_model: marker, rationale: marker },
      { prefixes: ["custom_private_"] },
    );
    expect(document.body.outerHTML).not.toContain(marker);
    const trigger = within(screen.getByRole("table", { name: "학습된 모델 추천" })).getByRole("button", {
      name: /추천을 규칙으로 적용/u,
    });
    await current.user.click(trigger);
    expect(current.count(createPath)).toBe(0);
    expect(screen.queryByRole("dialog", { name: "학습 추천으로 규칙 만들기" })).not.toBeInTheDocument();
  });

  it("실제 strict report 오류는 기존 추천을 새 성공으로 승인하지 않고 정상 재조회로 복구한다", async () => {
    const current = await setupLearning();
    const query = current.actualLearningQuery();
    const { dialog, captured } = await approved(current);
    current.response.learning = () => ({ ...current.report, min_samples: null });
    await act(async () => {
      await query.fetch().catch(() => undefined);
    });
    expect(query.state.status).toBe("error");
    await invoke(captured);
    expect(current.count(createPath)).toBe(0);
    current.response.learning = undefined;
    await fetchLearningPositive(current);
    await rereview(current, dialog);
    await createAndSettle(current, dialog);
    expect(current.count(createPath)).toBe(1);
  });

  it("동의 후 취소는 초안을 유지하거나 명시 폐기하며 옛 callback은 새 창을 바꾸지 않는다", async () => {
    const current = await setupLearning();
    const first = await approved(current);
    const close = current.capture("취소");
    const refresh = current.capture("목록 다시 조회");
    await current.user.click(within(first.dialog).getByRole("button", { name: "취소" }));
    const confirmation = await screen.findByRole("alertdialog");
    await current.user.click(within(confirmation).getByRole("button", { name: "계속 편집" }));
    await waitFor(() => expect(confirmation).not.toBeInTheDocument());
    expect(within(first.dialog).getByRole("checkbox", { name: impactLabel })).toBeChecked();
    await discard(current, first.dialog);
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: `${current.selected.recommended_model} 추천을 규칙으로 적용` }),
      ).toHaveFocus(),
    );
    const second = await approved(current);
    const reads = current.count(listPath);
    await invoke(first.captured);
    await invoke(refresh);
    await invoke(close);
    expect(second.dialog).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(current.count(createPath)).toBe(0);
    expect(current.count(listPath)).toBe(reads);
  });
});
