import { describe, expect, it } from "vitest";

import {
  buildModelRows,
  filterModelRows,
  modelRowKey,
  modelStatus,
  uniqueModelProviders,
} from "@/features/gateway/models/model-catalog";
import type { AdminModel, AdminModelsResponse } from "@/shared/api/schemas";

const baseModel = {
  created: 1_700_000_000,
  deprecation: null,
  fetched_at: "2026-09-02T00:00:00Z",
  id: "shared/model",
  object: "model",
  owned_by: "vendor",
  provider: "openai",
  shadowed: false,
  shadowed_by: "",
  source: "live",
  stale: false,
  virtual: false,
} satisfies AdminModel;

function catalogue(models: readonly AdminModel[]): AdminModelsResponse {
  return {
    generated_at: "2026-09-02T00:00:00Z",
    models: [...models],
    partial_failures: [],
    providers: [
      {
        fetched_at: "2026-09-02T00:00:00Z",
        model_count: 1,
        provider: "openai",
        source: "live",
        stale: false,
        status: "ok",
      },
      {
        fetched_at: "2026-09-02T00:00:00Z",
        model_count: 1,
        provider: "anthropic",
        source: "live",
        stale: false,
        status: "ok",
      },
    ],
    request_id: "req-models",
  };
}

describe("model catalog", () => {
  it("keeps duplicate model IDs distinct by provider and source", () => {
    const anthropic = { ...baseModel, provider: "anthropic" } satisfies AdminModel;
    const virtual = { ...baseModel, source: "agent_route", virtual: true } satisfies AdminModel;
    const rows = buildModelRows(catalogue([baseModel, anthropic, virtual]));

    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((row) => modelRowKey(row.model))).size).toBe(3);
    expect(rows.map((row) => `${row.model.provider}/${row.model.id}`)).toEqual([
      "openai/shared/model",
      "anthropic/shared/model",
      "openai/shared/model",
    ]);
  });

  it("assigns safe lifecycle precedence including shadow metadata", () => {
    const deprecated = {
      ...baseModel,
      deprecation: {
        action: "warn",
        id: "dep-1",
        message: "migrate",
        model_glob: "shared/*",
        replacement: "new-model",
        retired: false,
        sunset_date: "2026-10-01",
        sunset_reached: false,
      },
    } satisfies AdminModel;

    expect(modelStatus(baseModel)).toBe("available");
    expect(modelStatus({ ...baseModel, virtual: true })).toBe("virtual");
    expect(modelStatus({ ...baseModel, stale: true, virtual: true })).toBe("stale");
    expect(modelStatus(deprecated)).toBe("deprecated");
    expect(modelStatus({ ...deprecated, deprecation: { ...deprecated.deprecation, retired: true } })).toBe(
      "retired",
    );
    expect(modelStatus({ ...baseModel, shadowed: true, shadowed_by: "agent-route-priority" })).toBe(
      "shadowed",
    );
  });

  it("joins enrichments by model while filtering by provider, status, and guidance text", () => {
    const anthropic = { ...baseModel, provider: "anthropic", stale: true } satisfies AdminModel;
    const source = catalogue([baseModel, anthropic]);
    const rows = buildModelRows(
      source,
      {
        categories: [],
        models: [
          {
            categories: {},
            eval_pass_rate: 0.8,
            eval_samples: 5,
            golden_pass_rate: 0.9,
            golden_samples: 10,
            model: "shared/model",
            quality_score: 88,
            requests: 20,
            success_rate: 0.95,
          },
        ],
        since: "2026-09-01T00:00:00Z",
      },
      {
        effective: {
          "openai/shared/model": {
            cached_input_krw_per_1m: 150,
            input_krw_per_1m: 1_500,
            output_krw_per_1m: 2_500,
          },
          "shared/model": {
            cached_input_krw_per_1m: 100,
            input_krw_per_1m: 1_000,
            output_krw_per_1m: 2_000,
          },
        },
        versions: [],
      },
      [
        {
          avoid_for: "regulated data",
          good_for: "analysis",
          model: "shared/model",
          risk_note: "review output",
          updated_at: "2026-09-02T00:00:00Z",
          updated_by: "admin",
        },
      ],
    );

    expect(rows.every((row) => row.quality?.quality_score === 88)).toBe(true);
    expect(rows[0]?.price?.input_krw_per_1m).toBe(1_500);
    expect(rows[1]?.price?.input_krw_per_1m).toBe(1_000);
    expect(filterModelRows(rows, "regulated", "anthropic", "stale")).toEqual([rows[1]]);
    expect(uniqueModelProviders(source)).toEqual(["anthropic", "openai"]);
  });
});
