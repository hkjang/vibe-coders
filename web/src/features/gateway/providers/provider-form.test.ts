import { describe, expect, it } from "vitest";

import { numberText, providerFormSchema, providerWriteBody } from "./provider-form";

const valid = {
  name: "public-provider",
  base_url: "https://provider.example.invalid/v1",
  timeout_ms: "30000",
  priority: "10",
  enabled: true,
};

describe("provider integer request contract", () => {
  it.each(["timeout_ms", "priority"] as const)("rejects fractional %s before review", (field) => {
    const result = providerFormSchema.safeParse({ ...valid, [field]: "1.5" });
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: [field], message: expect.stringContaining("정수") }),
      ]),
    );
  });

  it.each([
    ["", undefined],
    ["0", 0],
    ["25", 25],
  ] as const)("preserves omission, zero and positive semantics for %s", (input, expected) => {
    const body = providerWriteBody(
      providerFormSchema.parse({ ...valid, timeout_ms: input, priority: input }),
    );
    expect(body.timeout_ms).toBe(expected);
    expect(body.priority).toBe(expected);
  });

  it("retains decimal validation for SLO ratios", () => {
    expect(numberText("가용성 목표", 1).parse("0.99")).toBe("0.99");
  });
});
