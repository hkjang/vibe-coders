import { Link, useLocation } from "react-router";
import { useAuth } from "@/app/auth/AuthProvider";
import type { IpSummary } from "@/shared/api/domains/ip-usage.schemas";
import { ErrorState, LoadingState, PermissionDenied } from "@/shared/components/state/PageStates";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useReturnFocus } from "@/shared/hooks/use-return-focus";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { sanitizeAppRouteSearch } from "@/shared/security/app-route-query";
import { formatDateTime } from "@/shared/utils/format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { IpUsageTable, type IpColumn } from "./IpUsageTable";
import { IpUsageDetails } from "./IpUsageDetails";
import {
  ipCost,
  ipIdentityLabel,
  ipLatency,
  ipNumber,
  ipRouteId,
  sumIpMetric,
  validIpIdentity,
} from "./ip-usage-model";
import { useIpList } from "./use-ip-usage";
import { useIpLinks } from "./use-ip-links";
import "./ip-usage.css";

export function IpsTab() {
  const owner = useFeatureReadOwner(ipRouteId, "ip-usage-read", ["observability:read"]);
  if (!owner.readable) return <PermissionDenied permission="admin:read" />;
  if (owner.denied)
    return (
      <ErrorState
        title="IP 사용량 조회 권한을 다시 확인하세요."
        message="이전 목록·상세·내보내기는 표시하지 않습니다."
        onRetry={owner.restart}
      />
    );
  return <IpUsageContent key={owner.id} owner={owner} />;
}
function IpUsageContent({ owner }: { owner: FeatureReadOwner }) {
  const ips = useIpList(owner);
  const auth = useAuth();
  const location = useLocation();
  const [params, update] = useSearchState();
  const focus = useReturnFocus();
  const links = useIpLinks();
  const requested = params.getAll("ip");
  const ip =
    requested.length === 1 && validIpIdentity(requested[0] ?? "", auth.credentialPrefixes)
      ? (requested[0] ?? "")
      : "";
  const invalidSelection = requested.length > 0 && !ip;
  const rows = ips.data?.ips;
  const detailHref = (ip: string) => {
    const next = new URLSearchParams(params);
    next.set("ip", ip);
    return (
      location.pathname +
      sanitizeAppRouteSearch(location.pathname, next.toString(), auth.credentialPrefixes).search
    );
  };
  const columns: readonly IpColumn<IpSummary>[] = [
    {
      id: "ip",
      header: "접속 IP",
      value: (row) => row.ip,
      cell: (row) => (
        <Link to={detailHref(row.ip)} onClick={(event) => focus.remember(event.currentTarget)}>
          {ipIdentityLabel(row.ip)}
        </Link>
      ),
    },
    {
      id: "keys",
      header: "사용 키 수",
      value: (row) => row.distinct_keys,
      cell: (row) => ipNumber(row.distinct_keys),
    },
    {
      id: "requests",
      header: "요청 수",
      value: (row) => row.requests,
      cell: (row) => ipNumber(row.requests),
    },
    { id: "tokens", header: "토큰 수", value: (row) => row.tokens, cell: (row) => ipNumber(row.tokens) },
    { id: "cost", header: "비용 (원)", value: (row) => row.cost_krw, cell: (row) => ipCost(row.cost_krw) },
    {
      id: "latency",
      header: "평균 지연 (ms)",
      value: (row) => row.average_latency_ms,
      cell: (row) => ipLatency(row.average_latency_ms),
    },
    {
      id: "last_seen",
      header: "최근 사용",
      value: (row) => row.last_seen,
      cell: (row) => formatDateTime(row.last_seen),
    },
  ];
  const legacyHref = links.legacyHref();
  return (
    <div className="access-stack">
      <InlineNotice tone="info" title="IP 차단 기능은 서버에 없습니다.">
        허용 IP는 API 키를 발급할 때 지정할 수 있습니다. 이미 발급한 키의 허용 IP를 바꾸려면 새 키를
        발급하세요.
      </InlineNotice>
      {invalidSelection ? (
        <InlineNotice tone="warning" title="상세 IP 주소를 확인하세요.">
          올바른 IPv4·IPv6 주소 또는 IP 미기록 항목을 선택하세요.
        </InlineNotice>
      ) : null}
      {ips.isPending && !rows ? <LoadingState label="IP 사용량을 불러오는 중입니다." /> : null}
      {ips.isError ? (
        <QueryNotice
          error={ips.error}
          hasData={Boolean(rows)}
          label="IP 목록"
          onRetry={() => void ips.refetch()}
        />
      ) : null}
      {ips.data?.excluded ? (
        <InlineNotice tone="warning">
          유효한 주소로 확인할 수 없는 과거 IP 그룹 {ipNumber(ips.data.excluded)}개를 제외했습니다. 아래
          합계는 표시된 그룹의 값입니다.
        </InlineNotice>
      ) : null}
      {rows ? (
        <>
          <StatGrid label="조회된 IP 사용량 요약">
            <StatCard label="조회된 IP 그룹" value={ipNumber(rows.length)} hint="최대 200개" />
            <StatCard
              label="조회된 그룹의 요청"
              value={ipNumber(sumIpMetric(rows, (row) => row.requests))}
              hint="전체 트래픽 합계가 아닙니다."
            />
            <StatCard label="조회된 그룹의 토큰" value={ipNumber(sumIpMetric(rows, (row) => row.tokens))} />
            <StatCard label="조회된 그룹의 비용" value={ipCost(sumIpMetric(rows, (row) => row.cost_krw))} />
          </StatGrid>
          <SectionCard
            title="IP별 사용량"
            description="보관된 전체 기간에서 요청 수가 많은 상위 200개 IP까지 조회합니다. IP를 선택하면 상세 사용 내역을 확인할 수 있습니다."
            actions={
              legacyHref ? (
                <a className="button button-secondary button-default" href={legacyHref}>
                  기존 관리자에서 보기
                </a>
              ) : undefined
            }
          >
            <IpUsageTable
              id="ips"
              caption="IP별 사용량"
              rows={rows}
              columns={columns}
              owner={owner}
              loading={ips.isFetching}
              getRowId={(row) => row.ip}
              onRowClick={(row) => {
                if (!owner.isCurrent()) return;
                focus.rememberActive();
                update({ ip: row.ip }, { replace: false });
              }}
              getRowActionLabel={(row) => `${ipIdentityLabel(row.ip)} 상세 열기`}
            />
            <UpdatedAt at={ips.dataUpdatedAt} />
          </SectionCard>
        </>
      ) : null}
      {ip ? (
        <IpUsageDetails
          key={ip}
          owner={owner}
          ip={ip}
          returnFocusRef={focus.returnFocusRef}
          onClose={() => update({ ip: undefined }, { replace: false })}
        />
      ) : null}
    </div>
  );
}
