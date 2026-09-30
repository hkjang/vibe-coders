import { describe, expect, expectTypeOf, it, vi } from "vitest";

import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type {
  ModelContractRecord,
  ModelContractRunResponse,
  ModelContractWriteRequest,
  ModelDeprecationWriteRequest,
  ModelGovernanceDeprecation,
  PostAdminModelDeprecationsResponses,
} from "@/shared/api/generated";
import type { ModelContractWriteBody, ModelDeprecationWriteBody } from "@/shared/api/domains/gateway";
import {
  modelContractDeleteSchema,
  modelContractListSchema,
  modelContractRunSchema,
  modelContractSaveSchema,
  modelContractSchema,
  modelDeprecationDeleteSchema,
  modelDeprecationListSchema,
  modelDeprecationSaveSchema,
  modelDeprecationSchema,
  type ModelContract,
  type ModelContractRun,
  type ModelDeprecation,
} from "@/shared/api/domains/model-governance.schemas";

const contract = {
  id: "mcon_public",
  name: "공개 품질 계약",
  task_type: "code",
  min_quality_score: 80,
  min_golden_pass_rate: 0.9,
  min_success_rate: 0.95,
  max_latency_ms: 5000,
  max_avg_cost_krw: 10,
  enabled: false,
  created_by: "admin_public",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
} satisfies ModelContractRecord;
const deprecation = {
  id: "moddep_public",
  model_glob: "old-*",
  replacement: "",
  sunset_date: "",
  message: "",
  created_at: "2026-09-30T00:00:00Z",
  updated_at: "2026-09-30T00:00:00Z",
} satisfies ModelGovernanceDeprecation;
const run = {
  model: "public-model",
  window: "2026-09-01T00:00:00Z",
  replaceable: false,
  note: "관측 지표 비교",
  have_metrics: { quality: false, latency: false, cost: false },
  results: [
    {
      contract_id: contract.id,
      contract_name: contract.name,
      task_type: "code",
      verdict: "no_data",
      replaceable: false,
      checks: [{ dimension: "quality_score", threshold: 80, actual: null, status: "no_data" }],
    },
  ],
  failing_samples: [],
} satisfies ModelContractRunResponse;

describe("모델 관리 API의 확인된 응답과 생성 타입", () => {
  it("현재 Go 계약과 화면 타입을 연결하고 수정 ID 및 201을 보존한다", () => {
    expectTypeOf<ModelContract>().toEqualTypeOf<ModelContractRecord>();
    expectTypeOf<ModelDeprecation>().toEqualTypeOf<ModelGovernanceDeprecation>();
    expectTypeOf<ModelContractRun>().toEqualTypeOf<ModelContractRunResponse>();
    expectTypeOf<ModelContractWriteBody>().toEqualTypeOf<Readonly<ModelContractWriteRequest>>();
    expectTypeOf<ModelDeprecationWriteBody>().toEqualTypeOf<Readonly<ModelDeprecationWriteRequest>>();
    expectTypeOf<keyof PostAdminModelDeprecationsResponses>().toEqualTypeOf<201>();
    const body: ModelContractWriteBody = { id: contract.id, name: "수정", enabled: false, max_latency_ms: 0 };
    expect(body).toMatchObject({ id: contract.id, enabled: false, max_latency_ms: 0 });
  });

  it("명시적 빈 배열과 저장된 0·false·빈 대체 모델을 그대로 보존한다", () => {
    expect(modelContractListSchema.parse({ contracts: [] })).toEqual({ contracts: [] });
    expect(modelDeprecationListSchema.parse({ deprecations: [] })).toEqual({ deprecations: [] });
    expect(modelContractSchema.parse({ ...contract, min_quality_score: 0 })).toMatchObject({
      min_quality_score: 0,
      enabled: false,
    });
    expect(modelDeprecationSchema.parse(deprecation)).toEqual(deprecation);
  });

  it.each([{}, { contracts: null }, { contracts: {} }, { contracts: "[]" }])(
    "계약 목록 미확인을 빈 배열로 바꾸지 않는다: %j",
    (payload) => {
      expect(modelContractListSchema.safeParse(payload).success).toBe(false);
    },
  );
  it.each([{}, { deprecations: null }, { deprecations: {} }, { deprecations: "[]" }])(
    "정책 목록 미확인을 빈 배열로 바꾸지 않는다: %j",
    (payload) => {
      expect(modelDeprecationListSchema.safeParse(payload).success).toBe(false);
    },
  );
  it.each(Object.keys(contract))("계약의 누락/null %s를 추정해 편집하지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(contract).filter(([key]) => key !== field));
    expect(modelContractSchema.safeParse(missing).success).toBe(false);
    expect(modelContractSchema.safeParse({ ...contract, [field]: null }).success).toBe(false);
  });
  it.each(Object.keys(deprecation))("지원 종료 정책의 누락/null %s를 추정하지 않는다", (field) => {
    const missing = Object.fromEntries(Object.entries(deprecation).filter(([key]) => key !== field));
    expect(modelDeprecationSchema.safeParse(missing).success).toBe(false);
    expect(modelDeprecationSchema.safeParse({ ...deprecation, [field]: null }).success).toBe(false);
  });
  it.each(["80", null, undefined, Number.NaN, Number.POSITIVE_INFINITY])(
    "문자·불명·비유한 임계값을 숫자로 바꾸지 않는다: %j",
    (value) => {
      expect(modelContractSchema.safeParse({ ...contract, min_quality_score: value }).success).toBe(false);
    },
  );
  it.each([1.5, Number.MAX_SAFE_INTEGER + 1, "5000"])(
    "지연은 정확히 표현할 수 있는 정수여야 한다: %j",
    (value) => {
      expect(modelContractSchema.safeParse({ ...contract, max_latency_ms: value }).success).toBe(false);
    },
  );
  it("기존 서버의 범위 밖 임계값을 몰래 잘라내지 않는다", () => {
    expect(
      modelContractSchema.parse({ ...contract, min_quality_score: -10, min_success_rate: 7 }),
    ).toMatchObject({ min_quality_score: -10, min_success_rate: 7 });
  });
  it("검증 데이터 부족과 null 실측치를 유지한다", () => {
    expect(modelContractRunSchema.parse(run)).toEqual(run);
    expect(modelContractRunSchema.safeParse({ ...run, results: null }).success).toBe(false);
    expect(modelContractRunSchema.safeParse({ ...run, have_metrics: {} }).success).toBe(false);
    expect(modelContractRunSchema.safeParse({ ...run, replaceable: undefined }).success).toBe(false);
  });
  it("모든 변경 성공 응답의 확인 필드를 요구한다", () => {
    expect(modelContractSaveSchema.parse({ id: contract.id, ok: true })).toEqual({
      id: contract.id,
      ok: true,
    });
    expect(modelContractDeleteSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(modelDeprecationSaveSchema.parse({ deprecation })).toEqual({ deprecation });
    expect(modelDeprecationDeleteSchema.parse({ id: deprecation.id, deleted: true })).toEqual({
      id: deprecation.id,
      deleted: true,
    });
    for (const schema of [
      modelContractSaveSchema,
      modelContractDeleteSchema,
      modelDeprecationSaveSchema,
      modelDeprecationDeleteSchema,
    ]) {
      expect(schema.safeParse({}).success).toBe(false);
      expect(schema.safeParse({ ok: false, deleted: false, deprecation: null }).success).toBe(false);
    }
  });
  it("실제 API 파서의 불완전한 조회 오류에서 요청 ID를 보존한다", async () => {
    const client = new ApiClient({
      fetch: vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ contracts: null }), {
          status: 200,
          headers: { "Content-Type": "application/json", "X-Request-ID": "req_model_contract" },
        }),
      ),
    });
    await expect(client.request(endpoints.domains.gateway.models.contracts.list)).rejects.toMatchObject({
      kind: "contract",
      requestId: "req_model_contract",
    });
  });
});
