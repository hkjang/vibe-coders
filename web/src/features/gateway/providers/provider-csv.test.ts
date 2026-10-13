import { describe, expect, it } from "vitest";
import type { Provider } from "@/shared/api/schemas";
import { mockApi } from "@/test/api";
import { providerExportCsv, loadProviderExport } from "./provider-csv";

export const exportProvider = (index: number, extra: Partial<Provider> = {}): Provider => ({
  name: `공개 공급자 ${index}`,
  provider_ref: `prv_${String(index).padStart(43, "x")}`,
  base_url: "https://public.example.invalid/v1",
  api_key_configured: true,
  timeout_ms: 1000,
  enabled: true,
  model_patterns: "public-*",
  failover_group: "public",
  priority: index + 1,
  created_at: "2026-01-01T00:00:00Z",
  ...extra,
});
const emptySlo = { slos: [], evaluations: [], since: "2026-10-14T00:00:00Z" };
const filters = { query: "", status: "all", range: "24h" } as const;

describe("공급자 CSV 투영", () => {
  it("전체 수신 목록에 필터·정렬을 적용하고 페이지 제한을 두지 않는다", () => {
    const providers = Array.from({ length: 31 }, (_, index) =>
      exportProvider(index, { enabled: index < 25 }),
    );
    const result = providerExportCsv(
      { providers: { providers }, slo: emptySlo },
      { ...filters, status: "enabled", sort: "priority_desc" },
      [],
      "2026-10-14T00:00:00.000Z",
    );
    expect(result.count).toBe(25);
    expect(result.csv.startsWith("\uFEFF공급자,")).toBe(true);
    const lines = result.csv.trim().split("\r\n");
    expect(lines).toHaveLength(26);
    expect(lines[1]).toContain("공개 공급자 24,");
    expect(lines.at(-1)).toContain("공개 공급자 0,");
    expect(result.csv).not.toContain("공개 공급자 25,");
    expect(result.csv).toContain("2026-10-14T00:00:00.000Z");
    expect(
      providerExportCsv(
        { providers: { providers }, slo: emptySlo },
        { ...filters, query: "공개 공급자 30" },
        [],
        "time",
      ).count,
    ).toBe(1);
  });
  it("화면과 같은 마스킹·상태를 사용하고 비밀 원문이나 추가 필드를 출력하지 않는다", () => {
    const provider = {
      ...exportProvider(0, {
        base_url:
          "https://public-user:public-password@public.example.invalid/v1?api_key=private-value#fragment",
        model_patterns: "=2+2",
        failover_group: "corp_" + "x".repeat(32),
      }),
      api_key: "never-export-this-value",
    };
    const result = providerExportCsv(
      { providers: { providers: [provider] }, slo: emptySlo },
      filters,
      ["corp_"],
      "time",
    );
    for (const secret of [
      "public-user",
      "public-password",
      "private-value",
      "fragment",
      "corp_" + "x".repeat(32),
      "never-export-this-value",
    ])
      expect(result.csv).not.toContain(secret);
    expect(result.csv).toContain("'=2+2");
    expect(result.csv).toContain("민감한 값은 표시하지 않습니다.");
    expect(result.csv).toContain("설정됨");
    expect(result.csv).toContain("상태 미확인");
  });
  it("중복 참조는 모호한 목록으로 거절한다", () => {
    expect(() =>
      providerExportCsv(
        { providers: { providers: [exportProvider(1), exportProvider(1)] }, slo: emptySlo },
        filters,
        [],
        "time",
      ),
    ).toThrow();
  });
  it("운영 상태 필터와 지연은 같은 SLO 표시 기준을 적용한다", () => {
    const providers = [exportProvider(0), exportProvider(1)];
    const metric = { target: 100, actual: 75, breached: false, enforced: true };
    const evaluations = providers.map((provider, index) => ({
      provider: provider.name,
      provider_ref: provider.provider_ref,
      enabled: true,
      requests: 1,
      breached: index === 1,
      metrics: { availability: metric, p95_latency_ms: metric, error_rate: metric, fallback_rate: metric },
    }));
    const result = providerExportCsv(
      { providers: { providers }, slo: { ...emptySlo, evaluations } },
      { ...filters, status: "degraded" },
      [],
      "time",
    );
    expect(result.count).toBe(1);
    expect(result.csv).toContain("공개 공급자 1,");
    expect(result.csv).not.toContain("공개 공급자 0,");
    expect(result.csv).toContain(",75,");
  });
  it("라우팅 조회는 권한을 전달받았을 때만 추가한다", async () => {
    const api = mockApi({
      "GET /admin/providers": () => ({ providers: [] }),
      "GET /admin/providers/slo": () => emptySlo,
      "GET /admin/routing/health": () => ({}),
    });
    await loadProviderExport("24h", true, new AbortController().signal);
    expect(api.calls.map((call) => call.key)).toEqual([
      "GET /admin/providers",
      "GET /admin/providers/slo",
      "GET /admin/routing/health",
    ]);
    expect(api.calls[2]?.options.query).toEqual({ window: "24h", threshold: 70 });
  });
  it("필수 읽기를 새로 호출하고 라우팅 권한 없이는 라우팅 조회를 하지 않는다", async () => {
    const api = mockApi({
      "GET /admin/providers": () => ({ providers: [] }),
      "GET /admin/providers/slo": () => emptySlo,
    });
    const snapshot = await loadProviderExport("7d", false, new AbortController().signal);
    expect(snapshot.routing).toBeUndefined();
    expect(api.calls.map((call) => call.key)).toEqual(["GET /admin/providers", "GET /admin/providers/slo"]);
    expect(api.calls[1]?.options.query).toEqual({ window: "7d" });
  });
});
