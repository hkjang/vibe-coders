export const warehouseTabs = ["insights", "pipeline", "metrics"] as const;
export type WarehouseTab = (typeof warehouseTabs)[number];

export const dwWindows = ["7d", "30d", "90d"] as const;
export type DwWindow = (typeof dwWindows)[number];

export const dwBuckets = ["day", "week"] as const;
export type DwBucket = (typeof dwBuckets)[number];

export const dwDimensions = ["model", "provider", "project", "cost_center"] as const;
export type DwDimension = (typeof dwDimensions)[number];

export const dwOrders = ["cost", "requests", "tokens", "errors"] as const;
export type DwOrder = (typeof dwOrders)[number];

export const dwWindowLabels: Record<DwWindow, string> = {
  "7d": "최근 7일",
  "30d": "최근 30일",
  "90d": "최근 90일",
};

export const dwBucketLabels: Record<DwBucket, string> = { day: "일별", week: "주별" };

export const dwDimensionLabels: Record<DwDimension, string> = {
  model: "모델",
  provider: "공급자",
  project: "프로젝트",
  cost_center: "비용센터",
};

export const dwOrderLabels: Record<DwOrder, string> = {
  cost: "비용순",
  requests: "요청순",
  tokens: "토큰순",
  errors: "오류순",
};

export const metricSensitivities = ["internal", "public", "restricted"] as const;
export const metricSensitivityLabels: Record<string, string> = {
  internal: "내부용",
  public: "공개",
  restricted: "제한",
};

/** Narrows a URL query value to one of `options`, falling back to `fallback`. */
export function oneOf<Value extends string>(
  value: string | null,
  options: readonly Value[],
  fallback: Value,
): Value {
  return (options as readonly string[]).includes(value ?? "") ? (value as Value) : fallback;
}

/** Positive integer from a URL query value, clamped to `[1, max]`. */
export function positiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}
