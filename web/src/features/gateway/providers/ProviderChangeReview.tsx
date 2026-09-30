import {
  displayProviderBaseURL,
  type ProviderCatalogRow,
} from "@/features/gateway/providers/provider-catalog";
import type { ProviderWriteBody } from "@/shared/api/domains/gateway";
import { containsPotentialSecret } from "@/shared/security/secrets";

function publicText(value: string | undefined): string {
  if (!value) return "미설정";
  return containsPotentialSecret(value) ? "민감한 값은 비교에 표시하지 않습니다." : value;
}

export function ProviderChangeReview({
  row,
  body,
}: {
  row: ProviderCatalogRow;
  body: ProviderWriteBody;
}): React.JSX.Element {
  const before = row.provider;
  const rows = [
    ["이름", publicText(before.name), publicText(body.name)],
    ["기본 URL", displayProviderBaseURL(before.base_url), displayProviderBaseURL(body.base_url)],
    ["API 키", before.api_key_configured ? "설정됨" : "미설정", body.api_key === undefined ? "유지" : "교체"],
    ["모델 패턴", publicText(before.model_patterns), publicText(body.model_patterns)],
    ["장애 전환 그룹", publicText(before.failover_group), publicText(body.failover_group)],
    [
      "우선순위",
      String(before.priority),
      body.priority === undefined
        ? "저장된 값 유지 (없으면 서버 기본값)"
        : body.priority <= 0
          ? "서버 기본 우선순위"
          : String(body.priority),
    ],
    [
      "제한 시간(ms)",
      String(before.timeout_ms),
      body.timeout_ms === undefined || body.timeout_ms <= 0 ? "서버 기본 제한 시간" : String(body.timeout_ms),
    ],
    ["활성 상태", before.enabled ? "활성" : "비활성", body.enabled ? "활성" : "비활성"],
  ];
  return (
    <>
      <p>
        열었을 때의 공개 설정과 이번에 전송할 내용을 비교합니다. 다른 관리자의 동시 변경을 막지는 않습니다.
      </p>
      <p className="field-description">표를 좌우로 이동해 저장할 내용을 확인하세요.</p>
      <div className="data-table-scroll" role="region" aria-label="공급자 변경 비교 표" tabIndex={0}>
        <table className="data-table provider-review-table" aria-label="공급자 변경 전후 비교">
          <thead>
            <tr>
              <th scope="col">항목</th>
              <th scope="col">변경 전</th>
              <th scope="col">저장할 내용</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, oldValue, nextValue]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                <td>{oldValue}</td>
                <td>{nextValue}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        참조 영향은 조회하지 않았습니다. 관련 호출이 실패할 수 있으며 대체 경로의 성공을 보장하지 않습니다.
      </p>
    </>
  );
}
