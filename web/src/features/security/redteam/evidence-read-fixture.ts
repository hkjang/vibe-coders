import type { EvidenceRead } from "@/shared/api/domains/redteam-evidence-read";

export function evidenceReadFixture(reveal = false, resultId = "public-result"): EvidenceRead {
  return {
    evidence: {
      id: `evidence-${resultId}`,
      result_id: resultId,
      masked_prompt: "마스킹된 요청",
      masked_response: "마스킹된 응답",
      ...(reveal ? { raw_prompt: "원본 요청 내용", raw_response: "원본 응답 내용" } : {}),
      tool_calls: reveal ? [{ name: "공개 도구", arguments: { text: "원본 인수" } }] : [],
      headers_summary: { provider: "public-provider", model: "public-model" },
      export_hash: "public-hash",
      created_at: "2026-11-17T00:00:00Z",
    },
    masked: !reveal,
    raw_allowed: true,
    raw_available: true,
    tool_call_count: 1,
  };
}
