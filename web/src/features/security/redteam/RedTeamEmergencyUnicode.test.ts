import { describe, expect, it, vi } from "vitest";
import { ApiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

// Exercise the production decoder and pinned Zod schema, not mockApi's bypass.
const cases = [
  { label: "ASCII", unit: "a", count: 1000 },
  { label: "한글", unit: "가", count: 1000 },
  { label: "이모지", unit: "😀", count: 1000 },
  { label: "보충 한자", unit: "𠀀", count: 1000 },
  { label: "결합 문자", unit: "e\u0301", count: 500 },
];

describe("레드팀 응답 사유의 유니코드 경계", () => {
  for (const { label, unit, count } of cases)
    it.each([false, true])(`${label}: 초과=%s 응답을 실제 클라이언트로 검증한다`, async (overflow) => {
      const reason = unit.repeat(count + (overflow ? 1 : 0));
      const acknowledgment = {
        enabled: true,
        reason,
        scope: "responding_process",
        instance_ref: "process_0123456789abcdef",
        review_token: "2".repeat(32),
        observed_at: "2026-11-17T03:00:00Z",
      };
      const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(acknowledgment));
      const client = new ApiClient({ fetch });
      const result = client.request(endpoints.domains.redteam.killSwitch.set, {
        body: { enabled: true, reason, expected_review_token: "1".repeat(32) },
        retryUnauthorized: false,
      });
      if (overflow) await expect(result).rejects.toMatchObject({ kind: "contract" });
      else await expect(result).resolves.toEqual(acknowledgment);
      expect(fetch).toHaveBeenCalledOnce();
    });
});
