import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { AlertRule } from "@/shared/api/domains/governance";
import { alertRuleConfiguration } from "./alert-rule-configuration";
import { catalogRecordCurrent } from "./policy-catalog-key";

const baseline: AlertRule = {
  id: "public-alert",
  name: "공개 알림",
  metric: "errors",
  threshold: 1,
  scope: "global",
  scope_value: "*",
  window_seconds: 300,
  enabled: true,
  webhook_url: "https://public.invalid/hook",
  note: "공개 메모",
  created_at: "2026-01-01T00:00:00Z",
};
const key = ["governance", "alerts", "public-owner"] as const;
function setup(rows: AlertRule[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  client.setQueryData(key, { rules: rows });
  return {
    client,
    current: () => catalogRecordCurrent(client, key, "rules", baseline, alertRuleConfiguration),
  };
}
describe("알림 규칙의 설정과 측정 상태 구분", () => {
  it.each([
    { last_value: 14 },
    { last_fired_at: "2026-10-14T00:00:00Z" },
    { last_value: 0, last_fired_at: null },
  ])("측정 상태만 바뀌면 설정은 같다: %j", (observation) => {
    const c = setup([{ ...baseline, ...observation }]);
    expect(c.current()).toBe(true);
    // Other catalog consumers retain full-record matching by default.
    expect(catalogRecordCurrent(c.client, key, "rules", baseline)).toBe(false);
    c.client.clear();
  });
  it.each([
    ["id", "another"],
    ["name", "다른 알림"],
    ["metric", "tokens"],
    ["threshold", 7],
    ["scope", "team"],
    ["scope_value", "public-team"],
    ["window_seconds", 600],
    ["enabled", false],
    ["webhook_url", "https://public.invalid/changed"],
    ["note", "다른 메모"],
    ["created_at", "2026-10-14T00:00:00Z"],
    ["future_configuration", { nested: [1, false] }],
  ])("%s 변경은 측정값 갱신과 함께 와도 검토를 잠근다", (field, value) => {
    const c = setup([{ ...baseline, last_value: 14, [field]: value }]);
    expect(c.current()).toBe(false);
    c.client.clear();
  });
  it("알 수 없는 중첩 설정 필드는 측정 필드와 이름이 같아도 보존한다", () => {
    expect(alertRuleConfiguration({ ...baseline, future: { last_value: 1 } })).not.toBe(
      alertRuleConfiguration({ ...baseline, future: { last_value: 2 } }),
    );
  });
  it.each([{ rows: [] }, { rows: [baseline, { ...baseline, last_value: 14 }] }])(
    "없거나 중복된 ID는 거절한다",
    ({ rows }) => {
      const c = setup(rows);
      expect(c.current()).toBe(false);
      c.client.clear();
    },
  );
  it("무효화된 캐시는 같은 설정이어도 거절한다", () => {
    const c = setup([baseline]);
    void c.client.invalidateQueries({ queryKey: key });
    expect(c.current()).toBe(false);
    c.client.clear();
  });
  it("조회 중과 조회 실패에는 비교가 같아도 실행할 수 없다", async () => {
    const c = setup([baseline]);
    let reject!: (error: Error) => void;
    const pending = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const request = c.client.fetchQuery({ queryKey: key, queryFn: () => pending });
    expect(c.current()).toBe(false);
    reject(new Error("공개 조회 실패"));
    await expect(request).rejects.toThrow();
    expect(c.current()).toBe(false);
    c.client.clear();
  });
});
