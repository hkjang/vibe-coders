import type { RefObject } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { Sheet } from "@/shared/components/ui/Sheet";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Badge } from "@/shared/components/ui/Badge";
import { severityTone } from "@/features/access/access-format";
import { formatDateTime } from "@/shared/utils/format";
import { useMeReceiptQuery } from "./use-me-queries";
import { meBoolean, meCost, meLabel, meLatency, meNumber, validMePathID } from "./me-console-model";
import { MePartial, MeQueryContent } from "./me-console-ui";

export function MeReceiptSheet({
  selected,
  close,
  trigger,
}: {
  selected: string;
  close: () => void;
  trigger: RefObject<HTMLElement | null>;
}) {
  const { credentialPrefixes } = useAuth();
  const valid = validMePathID(selected, credentialPrefixes);
  const receipt = useMeReceiptQuery(selected, Boolean(selected) && valid);
  const data = receipt.data;
  const partial = data?.partial_failures ?? [];
  return (
    <Sheet
      open={Boolean(selected)}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      returnFocusRef={trigger}
      size="wide"
      title="요청 영수증"
      scrollLabel="영수증 상세 내용"
      description="본인 요청의 모델, 라우팅, 정책, 토큰과 비용입니다. 원문 질문·응답은 포함하지 않습니다."
    >
      {!valid ? (
        <InlineNotice tone="warning">
          요청 ID를 확인하세요. 비밀값은 주소나 조회 조건으로 사용할 수 없습니다.
        </InlineNotice>
      ) : (
        <MeQueryContent query={receipt} label="요청 영수증">
          {data ? (
            <div className="access-stack">
              <MePartial failures={partial} />
              <KeyValueList
                items={[
                  { label: "요청 ID", value: data.request_id, mono: true },
                  { label: "시각", value: formatDateTime(data.created_at) },
                  { label: "엔드포인트", value: data.endpoint, mono: true },
                  { label: "모델", value: data.model },
                  { label: "공급자", value: data.provider },
                  { label: "상태 코드", value: data.status_code ?? "—" },
                  { label: "종료 사유", value: data.finish_reason },
                  { label: "지연", value: meLatency(data.latency_ms) },
                  { label: "비용", value: meCost(data.cost_krw) },
                  { label: "캐시 적중", value: meBoolean(data.cache_hit) },
                  { label: "차단", value: meBoolean(partial.includes("policy") ? undefined : data.blocked) },
                ]}
              />
              <SectionCard title="토큰" headingLevel={3}>
                <KeyValueList
                  items={[
                    { label: "입력", value: meNumber(data.tokens?.prompt) },
                    { label: "출력", value: meNumber(data.tokens?.completion) },
                    { label: "합계", value: meNumber(data.tokens?.total) },
                    { label: "캐시", value: meNumber(data.tokens?.cached) },
                  ]}
                />
              </SectionCard>
              <SectionCard title="라우팅" headingLevel={3}>
                {partial.includes("routing") ? (
                  <p>라우팅 정보를 확인하지 못했습니다.</p>
                ) : data.routing ? (
                  <KeyValueList
                    items={[
                      { label: "요청 모델", value: data.routing.requested_model },
                      { label: "선택 모델", value: data.routing.selected_model },
                      { label: "선택 공급자", value: data.routing.selected_provider },
                      { label: "선택 사유", value: data.routing.reason },
                      { label: "위험 등급", value: meLabel(data.routing.risk_tier) },
                      { label: "복잡도 등급", value: meLabel(data.routing.complexity_tier) },
                      { label: "장애 전환 경로", value: data.routing.fallback_path.join(" → ") || "—" },
                    ]}
                  />
                ) : (
                  <p>저장된 라우팅 결정이 없습니다.</p>
                )}
              </SectionCard>
              <SectionCard title="정책 판정" headingLevel={3}>
                {partial.includes("policy") ? (
                  <p>정책 판정을 확인하지 못했습니다.</p>
                ) : data.policy.length ? (
                  <ul className="access-list">
                    {data.policy.map((row, index) => (
                      <li key={index}>
                        <span className="access-list-title">
                          <Badge tone={severityTone(row.decision)}>{meLabel(row.decision)}</Badge>
                          {row.rule}
                        </span>
                        <span className="access-list-detail">{row.reason}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>저장된 비허용 판정이 없습니다. 허용 판정은 이 목록에서 생략됩니다.</p>
                )}
              </SectionCard>
              <SectionCard title="MCP 도구와 스킬" headingLevel={3}>
                {partial.includes("tools") ? (
                  <p>도구 사용 이력을 확인하지 못했습니다.</p>
                ) : (
                  <KeyValueList
                    items={[
                      { label: "MCP 사용", value: meBoolean(data.mcp_used) },
                      {
                        label: "MCP 도구",
                        value:
                          data.mcp_tools
                            .map((tool) => `${tool.server}/${tool.tool}${tool.error ? " (오류)" : ""}`)
                            .join(", ") || "—",
                      },
                      { label: "스킬 사용", value: meBoolean(data.skill_used) },
                      { label: "스킬", value: data.skills.join(", ") || "—" },
                    ]}
                  />
                )}
              </SectionCard>
              {data.note ? <p className="access-note">{data.note}</p> : null}
            </div>
          ) : null}
        </MeQueryContent>
      )}
    </Sheet>
  );
}
