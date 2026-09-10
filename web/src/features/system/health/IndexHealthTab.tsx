import { useQuery } from "@tanstack/react-query";
import { FileText } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { MigrationSqlDialog } from "@/features/system/health/MigrationSqlDialog";
import { opsRouteId } from "@/features/system/health/OpsHomeTab";
import { bySeverity, opsStatusTone } from "@/features/system/health/ops-status";
import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";

const driftKindLabels: Record<string, string> = {
  mismatched: "정의 불일치",
  missing: "DB에 없음",
  undeclared: "선언에 없음",
};

const driftKindTones: Record<string, "danger" | "warning" | "muted"> = {
  mismatched: "danger",
  missing: "warning",
  undeclared: "muted",
};

/**
 * Index health: what the migrations declare against what this database actually has,
 * plus the add/drop candidates the access statistics suggest.
 *
 * Every SQL string here is shown for an operator to read and decide on — this screen
 * runs no DDL, and neither does the endpoint behind it.
 */
export function IndexHealthTab(): React.JSX.Element {
  const [sqlOpen, setSqlOpen] = useState(false);
  const sqlTriggerRef = useRef<HTMLButtonElement>(null);

  const health = useQuery({
    queryKey: ["system", "ops", "index-health"],
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.system.ops.indexHealth, { routeId: opsRouteId, signal }),
  });

  const summary = health.data?.summary;
  const drift = health.data?.drift;
  const advice = health.data?.advice;
  const adviceItems = useMemo(
    () => [...(advice?.items ?? [])].sort((left, right) => bySeverity(left.severity, right.severity)),
    [advice],
  );

  return (
    <div className="page-stack">
      {health.isError ? (
        <QueryNotice
          error={health.error}
          hasPreviousData={health.data !== undefined}
          label="인덱스 상태"
          onRetry={() => void health.refetch()}
        />
      ) : null}

      <SectionCard
        title="인덱스 상태"
        description={summary?.headline ?? "선언한 인덱스와 이 데이터베이스의 실제 인덱스를 비교합니다."}
        actions={
          <Button ref={sqlTriggerRef} size="small" onClick={() => setSqlOpen(true)}>
            <FileText aria-hidden="true" /> 마이그레이션 SQL 보기
          </Button>
        }
      >
        <StatGrid label="인덱스 상태 요약">
          <StatCard
            label="스키마"
            tone={summary?.in_sync ? "success" : "danger"}
            value={summary?.in_sync ? "일치" : "불일치"}
            hint={drift?.dialect ?? undefined}
          />
          <StatCard label="정의 불일치" value={summary?.mismatched ?? 0} />
          <StatCard label="DB에 없음" value={summary?.missing ?? 0} />
          <StatCard label="선언에 없음" value={summary?.undeclared ?? 0} />
          <StatCard
            label="추천"
            value={summary?.advice_total ?? 0}
            hint={`중요 ${summary?.advice_high ?? 0}건`}
          />
        </StatGrid>

        {health.isPending ? (
          <p className="metric-note">불러오는 중…</p>
        ) : (drift?.items.length ?? 0) === 0 ? (
          <p className="metric-note">
            선언한 인덱스 {drift?.declared_count ?? 0}개가 모두 이 데이터베이스에 그대로 있습니다.
          </p>
        ) : (
          <table className="ops-check-table">
            <caption className="sr-only">인덱스 차이</caption>
            <thead>
              <tr>
                <th scope="col">구분</th>
                <th scope="col">인덱스</th>
                <th scope="col">내용</th>
                <th scope="col">검토할 SQL</th>
              </tr>
            </thead>
            <tbody>
              {(drift?.items ?? []).map((item) => (
                <tr key={`${item.kind ?? ""}-${item.name}`}>
                  <td>
                    <Badge tone={driftKindTones[item.kind ?? ""] ?? "muted"}>
                      {driftKindLabels[item.kind ?? ""] ?? item.kind ?? "-"}
                    </Badge>
                  </td>
                  <td>
                    <span className="mono">{item.name}</span>
                    {item.table ? <div className="metric-note">{item.table}</div> : null}
                  </td>
                  <td className="metric-note">{item.detail ?? ""}</td>
                  <td>{item.fix ? <code className="ops-sql">{item.fix}</code> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <UpdatedAt at={health.dataUpdatedAt} />
      </SectionCard>

      <SectionCard
        title="추가·삭제 후보"
        description="접근 통계가 가리키는 후보입니다. 인덱스는 쓰기 비용과 저장 비용을 만들기 때문에 적용 여부는 운영자가 판단합니다."
      >
        {health.isPending ? (
          <p className="metric-note">불러오는 중…</p>
        ) : adviceItems.length === 0 ? (
          <EmptyState
            title="눈에 띄는 후보가 없습니다."
            description="접근 통계에서 추가하거나 지울 만한 인덱스를 찾지 못했습니다."
          />
        ) : (
          <table className="ops-check-table">
            <caption className="sr-only">인덱스 추가·삭제 후보</caption>
            <thead>
              <tr>
                <th scope="col">중요도</th>
                <th scope="col">구분</th>
                <th scope="col">대상</th>
                <th scope="col">근거</th>
                <th scope="col">검토할 SQL</th>
              </tr>
            </thead>
            <tbody>
              {adviceItems.map((item, index) => (
                <tr key={`${item.table}-${item.index ?? index}`}>
                  <td>
                    <Badge tone={opsStatusTone(item.severity === "high" ? "critical" : item.severity)}>
                      {item.severity === "high" ? "높음" : item.severity === "medium" ? "보통" : "낮음"}
                    </Badge>
                  </td>
                  <td>{item.kind === "drop" ? "삭제 후보" : "추가 후보"}</td>
                  <td>
                    <span className="mono">{item.table}</span>
                    {item.columns?.length ? <span className="mono"> ({item.columns.join(", ")})</span> : null}
                    {item.index ? <div className="metric-note">{item.index}</div> : null}
                  </td>
                  <td className="metric-note">
                    {item.reason ?? ""}
                    {item.evidence ? <div>{item.evidence}</div> : null}
                  </td>
                  <td>{item.sql ? <code className="ops-sql">{item.sql}</code> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {advice?.limitations?.length ? (
          <InlineNotice tone="info" title="이 드라이버가 답할 수 없는 것">
            {advice.limitations.join(" ")}
          </InlineNotice>
        ) : null}
      </SectionCard>

      <MigrationSqlDialog open={sqlOpen} onOpenChange={setSqlOpen} returnFocusRef={sqlTriggerRef} />
    </div>
  );
}
