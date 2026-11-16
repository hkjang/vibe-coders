import type { AdminStats } from "@/shared/api/schemas";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { OverviewUsageTable } from "./OverviewUsageTable";
import {
  groupIdentity,
  groupLabel,
  ipColumns,
  keyColumns,
  keyIdentity,
  keySearch,
  languageColumns,
  languageIdentity,
  languageLabel,
  modelColumns,
  statusColumns,
  statusIdentity,
  statusLabel,
} from "./overview-usage-columns";

export function OverviewUsageTab({ stats }: { stats: AdminStats | undefined }): React.JSX.Element {
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
      <InlineNotice title="보존된 기록 기준">
        아래 표는 서버에 보존된 기록을 집계합니다. 위 추이 그래프의 기간 선택은 적용되지 않습니다. 검색과
        정렬은 각 표에 수신된 항목 안에서만 동작하며, 표시된 상위 항목의 합계는 전체 사용량과 다를 수
        있습니다.
      </InlineNotice>
      <OverviewUsageTable
        title="상태 분포"
        caption="응답 상태별 요청 수"
        description="보존된 요청 로그의 응답 상태 구성입니다. 비중은 검색 전 수신된 상태별 요청 수의 합계를 기준으로 합니다."
        searchLabel="상태 검색"
        rows={stats.by_status}
        columns={statusColumns(totalStatus)}
        identity={statusIdentity}
        searchText={statusLabel}
        emptyTitle="요청 기록이 없습니다."
        emptyDescription="게이트웨이로 요청이 들어오면 채워집니다."
      />
      <OverviewUsageTable
        title="요청량 상위 API 키"
        caption="요청량 상위 API 키"
        description="요청 수 기준 상위 API 키를 최대 5개 제공합니다. 사용자 수나 전체 API 키 목록이 아닙니다."
        searchLabel="API 키 이름·팀 검색"
        rows={stats.top_users}
        columns={keyColumns}
        identity={keyIdentity}
        searchText={keySearch}
        emptyTitle="API 키 사용 기록이 없습니다."
        emptyDescription="API 키로 요청이 들어오면 채워집니다."
      />
      <OverviewUsageTable
        title="모델별 사용량"
        caption="모델별 요청과 비용"
        description="요청 수 기준 상위 모델을 최대 50개 제공합니다. 비용 정렬도 수신된 모델 안에서만 적용됩니다."
        searchLabel="모델 검색"
        rows={stats.by_model}
        columns={modelColumns}
        identity={groupIdentity}
        searchText={groupLabel}
        emptyTitle="모델 사용 기록이 없습니다."
        emptyDescription="요청이 쌓이면 모델별로 집계됩니다."
      />
      <OverviewUsageTable
        title="클라이언트 IP별 사용량"
        caption="클라이언트 IP별 요청과 비용"
        description="요청 수 기준 상위 클라이언트 IP를 최대 50개 제공합니다."
        searchLabel="클라이언트 IP 검색"
        rows={stats.by_ip}
        columns={ipColumns}
        identity={groupIdentity}
        searchText={groupLabel}
        emptyTitle="IP 기록이 없습니다."
        emptyDescription="요청이 쌓이면 IP별로 집계됩니다."
      />
      <OverviewUsageTable
        title="언어별 사용량"
        caption="언어별 요청 수"
        description="추정된 프로그래밍 언어 중 요청 수 기준 상위 50개입니다. 한 요청에서 여러 언어가 집계될 수 있습니다."
        searchLabel="언어 검색"
        rows={stats.by_language}
        columns={languageColumns}
        identity={languageIdentity}
        searchText={languageLabel}
        emptyTitle="언어 기록이 없습니다."
        emptyDescription="코드가 포함된 요청이 들어오면 채워집니다."
      />
    </div>
  );
}
