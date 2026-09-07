import { useQuery } from "@tanstack/react-query";
import type { RefObject } from "react";

import { httpTone } from "@/features/access/access-format";
import { apiClient } from "@/shared/api/client";
import { withPathParams } from "@/shared/api/domains/access";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { JsonBlock } from "@/shared/components/ui/JsonBlock";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatKRW, formatNumber } from "@/shared/utils/format";

const access = endpoints.domains.access;
const routeId = "access.users";

interface UserDetailSheetProps {
  apiKeyId: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

interface BreakdownRow {
  requests: number;
  cost_krw?: number;
}

function BreakdownTable<Row extends BreakdownRow>({
  caption,
  label,
  field,
  rows,
}: {
  caption: string;
  label: string;
  field: (row: Row) => string;
  rows: ReadonlyArray<Row>;
}): React.JSX.Element {
  if (rows.length === 0) return <p className="access-note">기록된 값이 없습니다.</p>;
  return (
    <div className="data-table-scroll" tabIndex={0} aria-label={`${caption} 표 영역`}>
      <table className="data-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{label}</th>
            <th scope="col">요청</th>
            <th scope="col">비용</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 20).map((row, index) => (
            <tr key={index}>
              <td className="truncate">{field(row) || "—"}</td>
              <td className="cell-number">{formatNumber(row.requests)}</td>
              <td className="cell-number">{formatKRW(row.cost_krw ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UserDetailSheet({
  apiKeyId,
  onClose,
  returnFocusRef,
}: UserDetailSheetProps): React.JSX.Element {
  const detail = useQuery({
    queryKey: ["access", "users", "detail", apiKeyId],
    enabled: apiKeyId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(access.users.detail, { id: apiKeyId }), {
        query: { limit: 100 },
        signal,
        routeId,
      }),
  });

  const data = detail.data;
  const apiKey = (data?.api_key ?? {}) as Record<string, unknown>;

  return (
    <Sheet
      open={apiKeyId !== ""}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={typeof apiKey.name === "string" && apiKey.name ? apiKey.name : "사용자 상세"}
      description="선택한 API 키의 사용량, 모델·IP 분포, 최근 호출입니다."
    >
      {detail.isPending ? <LoadingState label="사용자 상세를 불러오는 중입니다." /> : null}
      {detail.isError ? (
        <InlineNotice tone="danger" title="사용자 상세를 불러오지 못했습니다.">
          {safeAppErrorMessage(detail.error, "잠시 후 다시 시도하세요.")}
          {isAppError(detail.error) && detail.error.requestId ? (
            <span className="request-id"> 요청 ID: {detail.error.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}
      {data ? (
        <div className="access-stack">
          <KeyValueList
            items={[
              { label: "키 ID", value: apiKeyId, mono: true },
              { label: "이름", value: String(apiKey.name ?? "") },
              { label: "소유자", value: String(apiKey.owner ?? "") },
              { label: "팀", value: String(apiKey.team ?? "") },
              { label: "상태", value: String(apiKey.status ?? "") },
              { label: "생성", value: formatDateTime(String(apiKey.created_at ?? "")) },
            ]}
          />
          {data.stats ? <JsonBlock label="사용량 통계" value={data.stats} /> : null}
          {data.advanced ? <JsonBlock label="고급 지표" value={data.advanced} /> : null}
          <SectionCard title="모델별 사용" headingLevel={3}>
            <BreakdownTable
              caption="모델별 사용"
              label="모델"
              field={(row) => row.model}
              rows={data.by_model}
            />
          </SectionCard>
          <SectionCard title="IP별 사용" headingLevel={3}>
            <BreakdownTable caption="IP별 사용" label="IP" field={(row) => row.ip} rows={data.by_ip} />
          </SectionCard>
          <SectionCard title="언어별 사용" headingLevel={3}>
            <BreakdownTable
              caption="언어별 사용"
              label="언어"
              field={(row) => row.language}
              rows={data.by_language}
            />
          </SectionCard>
          <SectionCard title="일별 사용" headingLevel={3}>
            <BreakdownTable caption="일별 사용" label="날짜" field={(row) => row.day} rows={data.daily} />
          </SectionCard>
          <SectionCard title="최근 호출" headingLevel={3}>
            {data.recent.length === 0 ? (
              <p className="access-note">최근 호출 기록이 없습니다.</p>
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="최근 호출 표 영역">
                <table className="data-table">
                  <caption className="sr-only">최근 호출</caption>
                  <thead>
                    <tr>
                      <th scope="col">시각</th>
                      <th scope="col">모델</th>
                      <th scope="col">상태</th>
                      <th scope="col">비용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.recent.slice(0, 30).map((row, index) => (
                      <tr key={`${row.id}-${String(index)}`}>
                        <td>{formatDateTime(row.created_at)}</td>
                        <td className="truncate">{row.model || "—"}</td>
                        <td>
                          <Badge tone={httpTone(row.status_code)}>{row.status_code || "—"}</Badge>
                        </td>
                        <td className="cell-number">{formatKRW(row.cost_krw)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>
        </div>
      ) : null}
    </Sheet>
  );
}
