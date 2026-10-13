import { describe, expect, it } from "vitest";
import type { AdminModel } from "@/shared/api/schemas";
import { mockApi, apiFailure } from "@/test/api";
import { loadModelExport, modelExportCsv, type ModelExportFilters } from "./model-csv";

const at = "2026-10-14T00:00:00Z";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture value");
  return value;
}
export function exportSnapshot(): Awaited<ReturnType<typeof loadModelExport>> {
  const model: AdminModel = {
    id: "public-model",
    provider: "public-provider",
    provider_ref: "prv_" + "a".repeat(43),
    source: "live",
    stale: false,
    virtual: false,
    shadowed: false,
    shadowed_by: "",
    object: "model",
    owned_by: "private-owner-not-exported",
    created: null,
    fetched_at: at,
    deprecation: null,
  };
  return {
    catalogue: {
      generated_at: at,
      models: [model],
      providers: [],
      partial_failures: [],
      request_id: "private-request-not-exported",
    },
    quality: { categories: [], since: at, models: [] },
    pricing: { effective: {}, versions: [] },
    tags: { tags: [] },
  };
}
const filters: ModelExportFilters = { query: "", provider: "", status: "all", range: "24h" };
const csv = (data = exportSnapshot(), overrides: Partial<ModelExportFilters> = {}) =>
  modelExportCsv(data, { ...filters, ...overrides }, ["corp_"], at);

describe("모델 CSV 투영", () => {
  it("페이지 구분 없이 수신 목록 전체에 필터와 정렬을 적용한다", () => {
    const data = exportSnapshot();
    data.catalogue.models = Array.from({ length: 31 }, (_, i) => ({
      ...required(data.catalogue.models[0]),
      id: `model-${String(i).padStart(2, "0")}`,
    }));
    const result = csv(data, { query: "model-", sort: "model_desc" });
    expect(result.count).toBe(31);
    expect(result.csv.split("\r\n")[1]).toContain("model-30");
    expect(result.csv).toContain("model-00");
    expect(csv(data, { query: "model-01" }).count).toBe(1);
    expect(csv(data, { provider: "prv_" + "b".repeat(43) }).count).toBe(0);
  });
  it("미관측 성공률과 실제 0, 무료 가격과 미등록 가격을 구분한다", () => {
    const data = exportSnapshot();
    data.quality.models = [
      {
        model: "public-model",
        categories: {},
        eval_pass_rate: 0,
        eval_samples: 0,
        golden_pass_rate: 0,
        golden_samples: 0,
        quality_score: 0,
        requests: 0,
        success_rate: 0,
      },
    ];
    data.pricing.effective["public-model"] = {
      input_krw_per_1m: 0,
      output_krw_per_1m: 0,
      cached_input_krw_per_1m: 0,
    };
    const cells = () => required(csv(data).csv.split("\r\n")[1]).split(",");
    expect(cells().slice(5, 11)).toEqual(["0", "0", "", "0", "0", "0"]);
    required(data.quality.models[0]).requests = 1;
    expect(cells()[7]).toBe("0");
    data.pricing.effective = {};
    expect(cells().slice(8, 11)).toEqual(["", "", ""]);
  });
  it("부분 응답과 이전 데이터는 완료된 전체 목록이라고 표현하지 않는다", () => {
    const data = exportSnapshot();
    expect(csv(data).partial).toBe(false);
    required(data.catalogue.models[0]).stale = true;
    expect(csv(data).partial).toBe(true);
    expect(csv(data).csv).toContain("부분 응답 또는 이전 데이터 포함");
  });
  it("허용된 열만 내보내고 사용자 지정 비밀정보와 스프레드시트 수식을 보호한다", () => {
    const data = exportSnapshot();
    required(data.catalogue.models[0]).id = "corp_" + "x".repeat(32);
    required(data.catalogue.models[0]).provider = "=2+2";
    const result = csv(data).csv;
    expect(result).not.toContain("corp_" + "x".repeat(32));
    expect(result).toContain("민감한 값은 표시하지 않습니다.");
    expect(result).toContain("'=2+2");
    expect(result).not.toContain("private-owner");
    expect(result).not.toContain("private-request");
    expect(result).toContain(at);
    expect(result.startsWith("\uFEFF")).toBe(true);
  });
  it("모호한 중복 식별자와 민감한 검색 조건을 거절한다", () => {
    const data = exportSnapshot();
    data.catalogue.models.push({ ...required(data.catalogue.models[0]) });
    expect(() => csv(data)).toThrow("모델 목록을 다시 확인");
    expect(() => csv(exportSnapshot(), { query: "corp_" + "x".repeat(32) })).toThrow("검색 조건을 다시 확인");
  });
  it("네 조회를 모두 새로 수행하고 품질 조회 기간과 취소 신호를 전달한다", async () => {
    const data = exportSnapshot();
    const api = mockApi({
      "GET /admin/models": () => data.catalogue,
      "GET /admin/models/quality": () => data.quality,
      "GET /admin/pricing": () => data.pricing,
      "GET /admin/model-tags": () => data.tags,
    });
    const signal = new AbortController().signal;
    expect(await loadModelExport("7d", signal)).toEqual(data);
    expect(api.calls).toHaveLength(4);
    expect(api.calls.find((call) => call.key.endsWith("quality"))?.options.query).toEqual({ window: "7d" });
    for (const call of api.spy.mock.calls)
      expect(call[1]).toMatchObject({ signal, routeId: "gateway.models" });
  });
  it("일부 조회 실패를 이전 결과로 대체하지 않는다", async () => {
    const data = exportSnapshot();
    mockApi({
      "GET /admin/models": () => data.catalogue,
      "GET /admin/models/quality": () => {
        throw apiFailure("synthetic-failure");
      },
      "GET /admin/pricing": () => data.pricing,
      "GET /admin/model-tags": () => data.tags,
    });
    await expect(loadModelExport("24h", new AbortController().signal)).rejects.toThrow("synthetic-failure");
  });
});
