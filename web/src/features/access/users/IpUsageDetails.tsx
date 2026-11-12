import type { RefObject } from "react";
import { Link } from "react-router";
import type { IpDay, IpGroup, IpLanguage, IpRecent } from "@/shared/api/domains/ip-usage.schemas";
import { LoadingState } from "@/shared/components/state/PageStates";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { StatCard, StatGrid } from "@/shared/components/ui/StatCard";
import { Tabs, TabPanel } from "@/shared/components/ui/Tabs";
import { useTabParam } from "@/shared/hooks/use-tab-param";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { IpUsageTable, type IpColumn } from "./IpUsageTable";
import { ipCost, ipIdentityLabel, ipLatency, ipNumber } from "./ip-usage-model";
import { useIpDetail } from "./use-ip-usage";
import { useIpLinks } from "./use-ip-links";

const tabs = [
  { id: "summary", label: "요약·추이" },
  { id: "distribution", label: "모델·키" },
  { id: "requests", label: "최근 요청" },
] as const;
const ids = tabs.map((tab) => tab.id);
const groups: readonly IpColumn<IpGroup>[] = [
  { id: "key", header: "구분", value: (row) => row.key, cell: (row) => row.key || "미확인" },
  { id: "requests", header: "요청 수", value: (row) => row.requests, cell: (row) => ipNumber(row.requests) },
  { id: "tokens", header: "토큰 수", value: (row) => row.tokens, cell: (row) => ipNumber(row.tokens) },
  { id: "cost", header: "비용 (원)", value: (row) => row.cost_krw, cell: (row) => ipCost(row.cost_krw) },
  {
    id: "latency",
    header: "평균 지연 (ms)",
    value: (row) => row.average_latency_ms,
    cell: (row) => ipLatency(row.average_latency_ms),
  },
];
const days: readonly IpColumn<IpDay>[] = [
  { id: "date", header: "집계일 (서울)", value: (row) => row.date },
  { id: "requests", header: "요청 수", value: (row) => row.requests, cell: (row) => ipNumber(row.requests) },
  { id: "tokens", header: "토큰 수", value: (row) => row.tokens, cell: (row) => ipNumber(row.tokens) },
  { id: "cost", header: "비용 (원)", value: (row) => row.cost_krw, cell: (row) => ipCost(row.cost_krw) },
];
const languages: readonly IpColumn<IpLanguage>[] = [
  { id: "language", header: "언어", value: (row) => row.language || "미확인" },
  { id: "requests", header: "요청 수", value: (row) => row.requests, cell: (row) => ipNumber(row.requests) },
  {
    id: "confidence",
    header: "평균 신뢰도",
    value: (row) => row.average_confidence,
    cell: (row) =>
      row.average_confidence === undefined ? "미확인" : formatNumber(row.average_confidence, 3),
  },
];
function MissingCollection() {
  return (
    <InlineNotice tone="warning">
      이 항목의 집계가 응답에 없습니다. 기록 없음과 구분하여 다시 조회하세요.
    </InlineNotice>
  );
}

export function IpUsageDetails({
  ip,
  owner,
  onClose,
  returnFocusRef,
}: {
  ip: string;
  owner: FeatureReadOwner;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const detail = useIpDetail(owner, ip);
  const links = useIpLinks();
  const [tab, setTab] = useTabParam(ids, "summary", "ip_view");
  const data = detail.data;
  const requestColumns: readonly IpColumn<IpRecent>[] = [
    {
      id: "id",
      header: "요청 ID",
      value: (row) => row.id,
      cell: (row) => {
        const href = links.requestHref(ip, row.id);
        return href ? <Link to={href}>{row.id}</Link> : <span className="mono">{row.id}</span>;
      },
    },
    {
      id: "created",
      header: "요청 시각",
      value: (row) => row.created_at,
      cell: (row) => formatDateTime(row.created_at),
    },
    { id: "model", header: "모델", value: (row) => row.model || "미확인" },
    {
      id: "status",
      header: "응답 코드",
      value: (row) => row.status_code,
      cell: (row) => (
        <Badge
          tone={
            row.status_code === undefined || row.status_code === 0
              ? "muted"
              : row.status_code >= 400
                ? "danger"
                : "success"
          }
        >
          {row.status_code === undefined || row.status_code === 0 ? "미확인" : row.status_code}
        </Badge>
      ),
    },
    {
      id: "latency",
      header: "지연 (ms)",
      value: (row) => row.latency_ms,
      cell: (row) => ipLatency(row.latency_ms),
    },
    {
      id: "tokens",
      header: "토큰 수",
      value: (row) => row.total_tokens,
      cell: (row) => ipNumber(row.total_tokens),
    },
    {
      id: "cost",
      header: "비용 (원)",
      value: (row) => row.estimated_cost,
      cell: (row) => ipCost(row.estimated_cost),
    },
  ];
  const requestHref = links.requestHref(ip),
    legacyHref = links.legacyHref(ip);
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      returnFocusRef={returnFocusRef}
      size="wide"
      scrollLabel="IP 사용량 상세 내용"
      title={ipIdentityLabel(ip)}
      description="선택한 IP의 사용량, 일별 추이, 모델·키 분포와 최근 요청입니다."
      footer={
        <>
          <Button onClick={() => void detail.refetch()} disabled={detail.isFetching}>
            다시 조회
          </Button>
          {requestHref ? (
            <Link className="button button-secondary button-default" to={requestHref}>
              요청 탐색기
            </Link>
          ) : null}
          {legacyHref ? (
            <a className="button button-secondary button-default" href={legacyHref}>
              기존 관리자에서 보기
            </a>
          ) : null}
        </>
      }
    >
      <div className="access-stack ip-usage-summary">
        {detail.isPending ? <LoadingState label="IP 상세를 불러오는 중입니다." /> : null}
        {detail.isError ? (
          <QueryNotice
            error={detail.error}
            hasData={Boolean(data)}
            label="IP 상세"
            onRetry={() => void detail.refetch()}
          />
        ) : null}
        {data ? (
          <>
            <StatGrid label="선택 IP 사용량">
              <StatCard label="요청 수" value={ipNumber(data.stats.requests)} />
              <StatCard label="토큰 수" value={ipNumber(data.stats.tokens)} />
              <StatCard label="누적 비용" value={ipCost(data.stats.cost_krw)} />
              <StatCard label="사용 키 수" value={ipNumber(data.stats.distinct_keys)} />
            </StatGrid>
            <p className="access-note">
              보관된 전체 기간 · 평균 지연 {ipLatency(data.stats.average_latency_ms)} · 최근 사용{" "}
              {formatDateTime(data.stats.last_seen)}
            </p>
            <UpdatedAt at={detail.dataUpdatedAt} />
            <Tabs
              items={tabs}
              value={tab}
              onChange={setTab}
              ariaLabel="IP 상세 영역"
              panelIdPrefix="ip-detail"
            />
            <TabPanel id={tab} panelIdPrefix="ip-detail" key={tab} className="access-stack">
              {tab === "summary" ? (
                <>
                  <SectionCard
                    headingLevel={3}
                    title="일별 사용량"
                    description="서울 시간 기준으로 요청이 기록된 최근 60개 날짜까지 표시합니다. 기록이 없는 날은 포함하지 않습니다."
                  >
                    {data.daily ? (
                      <IpUsageTable
                        id="ip_days"
                        caption="일별 사용량"
                        rows={data.daily}
                        columns={days}
                        owner={owner}
                        loading={detail.isFetching}
                      />
                    ) : (
                      <MissingCollection />
                    )}
                  </SectionCard>
                  <SectionCard
                    headingLevel={3}
                    title="언어별 사용량"
                    description="요청 수가 많은 최대 50개 언어입니다. 여러 언어를 포함한 요청은 중복될 수 있습니다."
                  >
                    {data.by_language ? (
                      <IpUsageTable
                        id="ip_languages"
                        caption="언어별 사용량"
                        rows={data.by_language}
                        columns={languages}
                        owner={owner}
                        loading={detail.isFetching}
                      />
                    ) : (
                      <MissingCollection />
                    )}
                  </SectionCard>
                </>
              ) : null}
              {tab === "distribution" ? (
                <>
                  <SectionCard
                    headingLevel={3}
                    title="모델별 사용량"
                    description="요청 수가 많은 최대 50개 모델입니다."
                  >
                    {data.by_model ? (
                      <IpUsageTable
                        id="ip_models"
                        caption="모델별 사용량"
                        rows={data.by_model}
                        columns={groups.map((column) =>
                          column.id === "key" ? { ...column, header: "모델" } : column,
                        )}
                        owner={owner}
                        loading={detail.isFetching}
                      />
                    ) : (
                      <MissingCollection />
                    )}
                  </SectionCard>
                  <SectionCard
                    headingLevel={3}
                    title="API 키별 사용량"
                    description="요청 수가 많은 최대 50개 키 ID입니다. 비밀 키 값은 표시하지 않습니다."
                  >
                    {data.by_key ? (
                      <IpUsageTable
                        id="ip_keys"
                        caption="API 키별 사용량"
                        rows={data.by_key}
                        columns={groups.map((column) =>
                          column.id === "key" ? { ...column, header: "키 ID" } : column,
                        )}
                        owner={owner}
                        loading={detail.isFetching}
                      />
                    ) : (
                      <MissingCollection />
                    )}
                  </SectionCard>
                </>
              ) : null}
              {tab === "requests" ? (
                <SectionCard
                  headingLevel={3}
                  title="최근 요청"
                  description="선택한 IP의 최근 100건까지 표시합니다. 요청 ID를 선택하면 조회 권한에 따라 요청 탐색기로 이동합니다."
                >
                  {data.recent ? (
                    <IpUsageTable
                      id="ip_requests"
                      caption="IP 최근 요청"
                      rows={data.recent}
                      columns={requestColumns}
                      owner={owner}
                      loading={detail.isFetching}
                      getRowId={(row) => row.id}
                    />
                  ) : (
                    <MissingCollection />
                  )}
                </SectionCard>
              ) : null}
            </TabPanel>
          </>
        ) : null}
      </div>
    </Sheet>
  );
}
