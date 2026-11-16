import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatPreciseNumber } from "@/shared/utils/precise-number";

export const unavailableRequestMetricLabels = new Set(["[값 비공개]", "[값 생략]", "공급자 이름 비공개"]);

/** Keep small, nonzero costs visible; exports retain the unrounded API number. */
export function formatRequestMetric(value: number): string {
  return formatPreciseNumber(value);
}

export function visibleRequestCurrency(currency: string, prefixes: readonly string[]): string | undefined {
  if (
    !currency ||
    !currency.trim() ||
    currency.length > 16 ||
    /[\p{Cc}\p{Cf}]/u.test(currency) ||
    unavailableRequestMetricLabels.has(currency) ||
    containsPotentialSecret(currency, prefixes)
  )
    return undefined;
  return currency;
}

export function requestCostText(value: number, currency: string, prefixes: readonly string[]): string {
  const unit = visibleRequestCurrency(currency, prefixes);
  return `${formatRequestMetric(value)} ${unit ?? "(통화 미확인)"}`;
}
