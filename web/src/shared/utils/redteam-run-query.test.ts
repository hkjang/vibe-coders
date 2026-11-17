import { describe, expect, it } from "vitest";
import { readRunQuery, runTimestamp, validRunSort, validRunRef, validRunWindow } from "./redteam-run-query";
import {
  locationStateWithSensitiveRejections,
  rejectedSensitiveQuery,
  sanitizeAppRouteSearch,
} from "@/shared/security/app-route-query";
import {
  statusLabel,
  decisionLabel,
  remediationLabel,
  stopReasonLabel,
} from "@/features/security/redteam/redteam-ui";

describe("실행 이력 주소 계약", () => {
  it("페이지, 상세 및 원본 조건을 보존한다", () => {
    const input =
      "?tab=runs&runs_page=5&runs_size=25&runs_source_result_id=원본-결과&runs_sort=risk_score:desc,created_at:asc&run=rtrun_1";
    const safe = sanitizeAppRouteSearch("/app/redteam", input);
    expect(safe.rejectedKeys).toEqual([]);
    const result = readRunQuery(new URLSearchParams(safe.search), []);
    expect(result.valid).toBe(true);
    expect(result.query).toMatchObject({
      offset: 100,
      limit: 25,
      source_result_id: "원본-결과",
      sort: "risk_score:desc,created_at:asc",
    });
    expect(result.selected).toBe("rtrun_1");
  });
  it.each([
    "runs_page=0",
    "runs_page=01",
    "runs_page=40002",
    "runs_size=10",
    "runs_size=025",
    "runs_status=no",
    "runs_mode=active",
    "runs_kind=all",
    "runs_review_id=a&runs_review_id=b",
    "run=a&run=b",
    "runs_run_id=../x",
    "runs_sort=id:desc,id:asc",
    "runs_from=2026-11-01T00:00:00Z",
    "runs_from=2026-02-30T00:00:00Z&runs_to=2026-03-02T00:00:00Z",
  ])("잘못된 조건을 전체 조회로 바꾸지 않는다: %s", (input) => {
    expect(readRunQuery(new URLSearchParams(input), []).valid).toBe(false);
  });
  it("민감한 식별자를 주소에서 제거하고 거부 표식만 남긴다", () => {
    const safe = sanitizeAppRouteSearch(
      "/app/redteam",
      "?tab=runs&runs_source_result_id=sk-proj-veryprivatecredentialvalue",
      [],
    );
    expect(safe.search).not.toContain("private");
    expect(
      rejectedSensitiveQuery(
        locationStateWithSensitiveRejections(null, safe.sensitiveKeys),
        "runs_source_result_id",
      ),
    ).toBe(true);
    expect(
      validRunRef("private_prefix_0123456789abcdef0123456789abcdef0123456789abcdef", ["private_prefix_"]),
    ).toBe(false);
    expect(validRunRef("한글-결과:1")).toBe(true);
  });
  it("나노초와 시간대를 비교하고 불가능한 날짜를 거부한다", () => {
    expect(validRunWindow("2026-11-01T00:00:00.000000001Z", "2026-11-01T00:00:00.000000002Z")).toBe(true);
    expect(validRunWindow("2026-11-01T00:00:00.000000002Z", "2026-11-01T00:00:00.000000001Z")).toBe(false);
    expect(validRunWindow("2026-11-01T09:00:00+09:00", "2026-11-01T00:00:00Z")).toBe(false);
    expect(runTimestamp("2026-02-29T00:00:00Z")).toBeUndefined();
    expect(runTimestamp("2028-02-29T00:00:00Z")).toBeDefined();
  });
  it("정렬은 허용된 세 항목까지, 알 수 없는 판정은 텍스트로 보인다", () => {
    expect(validRunSort("id:asc,cost_krw:desc,status:asc")).toBe(true);
    for (const value of [
      "id:DESC",
      "id:asc,id:desc",
      "id:asc,status:asc,cost_krw:asc,risk_score:asc",
      "id:asc;drop",
    ])
      expect(validRunSort(value)).toBe(false);
    for (const value of ["constructor", "__proto__", "toString"]) {
      expect(statusLabel(value)).toBe(value);
      expect(decisionLabel(value)).toBe(value);
      expect(remediationLabel(value)).toBe(value);
      expect(typeof stopReasonLabel(value)).toBe("string");
    }
  });
});
