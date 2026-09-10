import { OverviewTrendPanel } from "@/features/overview/OverviewTrendPanel";
import type { AdminStats } from "@/shared/api/schemas";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDateTime, formatKRW, formatNumber, formatPercent } from "@/shared/utils/format";

interface OverviewUsageTabProps {
  stats: AdminStats | undefined;
}

const statusLabels: Record<string, string> = {
  "2xx": "성공 (2xx)",
  "3xx": "리다이렉트 (3xx)",
  "4xx": "클라이언트 오류 (4xx)",
  quota: "한도 초과",
  "5xx": "서버 오류 (5xx)",
};

/**
 * The breakdowns the legacy dashboard showed but the overview widgets omit:
 * status mix, top keys, and per-model/IP/language usage. All of it comes from
 * the `/admin/stats` response the overview already loads.
 */
export function OverviewUsageTab({ stats }: OverviewUsageTabProps): React.JSX.Element {
  if (!stats) {
    return (
      <EmptyState
        title="사용 현황을 아직 불러오지 못했습니다."
        description="게이트웨이 통계를 불러오면 상태 분포와 사용량 상위 항목이 표시됩니다."
      />
    );
  }

  const totalStatus = stats.by_status.reduce((sum, item) => sum + item.requests, 0);

  return (
    <div className="overview-usage-stack">
      <OverviewTrendPanel />

      <SectionCard title="상태 분포" description="보존된 요청 로그의 응답 상태 구성입니다.">
        {stats.by_status.length === 0 ? (
          <EmptyState title="요청 기록이 없습니다." description="게이트웨이로 요청이 들어오면 채워집니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="상태 분포 표 영역">
            <table className="data-table">
              <caption className="sr-only">응답 상태별 요청 수</caption>
              <thead>
                <tr>
                  <th scope="col">상태</th>
                  <th scope="col">요청</th>
                  <th scope="col">비중</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_status.map((item) => (
                  <tr key={item.class}>
                    <th scope="row">{statusLabels[item.class] ?? item.class}</th>
                    <td className="cell-number">{formatNumber(item.requests)}</td>
                    <td className="cell-number">
                      {formatPercent(totalStatus > 0 ? item.requests / totalStatus : 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="상위 사용자" description="요청량이 많은 API 키입니다.">
        {stats.top_users.length === 0 ? (
          <EmptyState title="사용자 기록이 없습니다." description="API 키로 요청이 들어오면 채워집니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="상위 사용자 표 영역">
            <table className="data-table">
              <caption className="sr-only">요청량 상위 API 키</caption>
              <thead>
                <tr>
                  <th scope="col">이름</th>
                  <th scope="col">팀</th>
                  <th scope="col">요청</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                  <th scope="col">평균 지연</th>
                  <th scope="col">마지막 사용</th>
                </tr>
              </thead>
              <tbody>
                {stats.top_users.map((user) => (
                  <tr key={user.api_key_id}>
                    <th scope="row">{user.name || user.api_key_id}</th>
                    <td>{user.team || "—"}</td>
                    <td className="cell-number">{formatNumber(user.requests)}</td>
                    <td className="cell-number">{formatNumber(user.tokens)}</td>
                    <td className="cell-number">{formatKRW(user.cost_krw)}</td>
                    <td className="cell-number">{formatNumber(user.average_latency_ms)}ms</td>
                    <td>{formatDateTime(user.last_seen)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="모델별 사용량">
        {stats.by_model.length === 0 ? (
          <EmptyState title="모델 사용 기록이 없습니다." description="요청이 쌓이면 모델별로 집계됩니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="모델별 사용량 표 영역">
            <table className="data-table">
              <caption className="sr-only">모델별 요청과 비용</caption>
              <thead>
                <tr>
                  <th scope="col">모델</th>
                  <th scope="col">요청</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                  <th scope="col">평균 지연</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_model.map((item) => (
                  <tr key={item.key}>
                    <th scope="row">{item.key || "(미상)"}</th>
                    <td className="cell-number">{formatNumber(item.requests)}</td>
                    <td className="cell-number">{formatNumber(item.tokens)}</td>
                    <td className="cell-number">{formatKRW(item.cost_krw)}</td>
                    <td className="cell-number">{formatNumber(item.average_latency_ms)}ms</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="클라이언트 IP별 사용량">
        {stats.by_ip.length === 0 ? (
          <EmptyState title="IP 기록이 없습니다." description="요청이 쌓이면 IP별로 집계됩니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="IP별 사용량 표 영역">
            <table className="data-table">
              <caption className="sr-only">클라이언트 IP별 요청과 비용</caption>
              <thead>
                <tr>
                  <th scope="col">IP</th>
                  <th scope="col">요청</th>
                  <th scope="col">토큰</th>
                  <th scope="col">비용</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_ip.map((item) => (
                  <tr key={item.key}>
                    <th scope="row" className="mono">
                      {item.key || "(미상)"}
                    </th>
                    <td className="cell-number">{formatNumber(item.requests)}</td>
                    <td className="cell-number">{formatNumber(item.tokens)}</td>
                    <td className="cell-number">{formatKRW(item.cost_krw)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard title="언어별 사용량" description="요청 본문에서 추정한 프로그래밍 언어 분포입니다.">
        {stats.by_language.length === 0 ? (
          <EmptyState title="언어 기록이 없습니다." description="코드가 포함된 요청이 들어오면 채워집니다." />
        ) : (
          <div className="data-table-scroll" tabIndex={0} aria-label="언어별 사용량 표 영역">
            <table className="data-table">
              <caption className="sr-only">언어별 요청 수</caption>
              <thead>
                <tr>
                  <th scope="col">언어</th>
                  <th scope="col">요청</th>
                  <th scope="col">평균 신뢰도</th>
                </tr>
              </thead>
              <tbody>
                {stats.by_language.map((item) => (
                  <tr key={item.language}>
                    <th scope="row">{item.language || "(미상)"}</th>
                    <td className="cell-number">{formatNumber(item.requests)}</td>
                    <td className="cell-number">{formatPercent(item.average_confidence)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
    </div>
  );
}
