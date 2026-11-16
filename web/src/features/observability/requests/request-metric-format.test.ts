import { describe, expect, it } from "vitest";
import { formatRequestMetric, requestCostText, visibleRequestCurrency } from "./request-metric-format";

describe("recorded request costs", () => {
  it("keeps the recorded currency and small nonzero values without exchange conversion", () => {
    expect(requestCostText(0.000123, "USD", [])).toBe("0.000123 USD");
    expect(requestCostText(1234.56, "KRW", [])).toBe("1,234.56 KRW");
    expect(requestCostText(0.00000012, "EUR", [])).toBe("1.2000e-7 EUR");
    expect(requestCostText(0, "JPY", [])).toBe("0 JPY");
    expect(requestCostText(1_000_000_000_000_000, "KRW", [])).toBe("1,000,000,000,000,000 KRW");
  });
  it.each(["", " ", "USD\n", "\u202eUSD", "[값 비공개]", `corp_${"s".repeat(32)}`])(
    "does not expose unusable currency %s",
    (currency) => {
      expect(visibleRequestCurrency(currency, ["corp_"])).toBeUndefined();
      expect(requestCostText(1, currency, ["corp_"])).toBe("1 (통화 미확인)");
    },
  );
  it("preserves safe custom recorded units without claiming an ISO currency conversion", () => {
    expect(requestCostText(12, "credits", [])).toBe("12 credits");
  });
  it("does not render a missing number as zero", () => {
    expect(formatRequestMetric(Number.NaN)).toBe("확인 불가");
    expect(formatRequestMetric(Number.POSITIVE_INFINITY)).toBe("확인 불가");
    expect(formatRequestMetric(-0)).toBe("0");
  });
});
