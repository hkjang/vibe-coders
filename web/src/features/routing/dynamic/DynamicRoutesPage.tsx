import { ArrowRight, Plus, RefreshCw, Route } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";

import type { DynamicRoute } from "@/shared/api/domains/routing-dynamic";
import { PageHeader } from "@/shared/components/page/PageHeader";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

import { DynamicRouteCreateDialog } from "./DynamicRouteCreateDialog";
import { DynamicRouteEditor } from "./DynamicRouteEditor";
import { dynamicRoutesKey, useDynamicRouteList, useDynamicRouteWrites } from "./use-dynamic-routes";
import "./dynamic-routes.css";

export const dynamicRoutesBasePath = "/routing/dynamic";

const stateBadges: Readonly<
  Record<DynamicRoute["state"], { label: string; tone: "success" | "warning" | "muted" | "danger" }>
> = {
  live: { label: "배포됨", tone: "success" },
  live_with_draft: { label: "배포됨 · 새 버전 대기", tone: "warning" },
  not_deployed: { label: "미배포", tone: "muted" },
  disabled: { label: "사용 중지", tone: "danger" },
};

export function DynamicRouteStateBadge({ route }: { route: DynamicRoute }): React.JSX.Element {
  const badge = stateBadges[route.state];
  return <Badge tone={badge.tone}>{badge.label}</Badge>;
}

/** /routing/dynamic lists routes; /routing/dynamic/<id> opens one in the editor. */
export function DynamicRoutesPage(): React.JSX.Element {
  const location = useLocation();
  const rest = location.pathname.startsWith(dynamicRoutesBasePath)
    ? location.pathname.slice(dynamicRoutesBasePath.length).replace(/^\/+|\/+$/gu, "")
    : "";
  if (rest !== "") return <DynamicRouteEditor key={rest} id={decodeURIComponent(rest)} />;
  return <DynamicRouteList />;
}

function DynamicRouteList(): React.JSX.Element {
  const list = useDynamicRouteList();
  const writes = useDynamicRouteWrites();
  const client = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const createRef = useRef<HTMLButtonElement>(null);
  const routes = list.data?.routes ?? [];

  return (
    <div className="page-stack dynamic-routes">
      <PageHeader
        title="동적 라우팅"
        description="조건·비율·한도·폴백을 흐름으로 엮은 경로를 만들고, 버전별로 배포하고 되돌립니다. 클라이언트는 모델 이름만 dynamic/<경로 이름>으로 바꾸면 됩니다."
        status="preview"
        readOnly={!writes.access.allowed}
        actions={
          <>
            <Button onClick={() => void client.invalidateQueries({ queryKey: [...dynamicRoutesKey] })}>
              <RefreshCw aria-hidden="true" /> 새로고침
            </Button>
            <Button
              ref={createRef}
              variant="primary"
              disabled={!writes.access.allowed}
              title={writes.access.reason}
              onClick={() => setCreating(true)}
            >
              <Plus aria-hidden="true" /> 새 경로
            </Button>
          </>
        }
      />

      <InlineNotice tone="info" title="호출 방법">
        <code>{'"model": "dynamic/<경로 이름>"'}</code>으로 호출하고, 분기에 쓸 값은{" "}
        <code>X-Vibe-Metadata</code>(또는 Cloudflare 호환 <code>cf-aig-metadata</code>) 헤더에 JSON으로 실어
        보냅니다. 응답의 <code>X-Dynamic-Route-Path</code> 헤더가 실제로 지난 경로를 알려 줍니다.
      </InlineNotice>

      {list.isError ? (
        <InlineNotice tone="danger" title="경로 목록을 불러오지 못했습니다.">
          {safeAppErrorMessage(list.error, "잠시 후 다시 시도하세요.")}
        </InlineNotice>
      ) : null}

      <SectionCard
        title="경로"
        description={
          list.isPending
            ? "불러오는 중…"
            : `${formatNumber(routes.length)}개 · 트래픽은 최근 24시간 기준입니다.`
        }
      >
        {!list.isPending && routes.length === 0 && !list.isError ? (
          <EmptyState
            icon={<Route aria-hidden="true" />}
            title="아직 동적 경로가 없습니다."
            description="장애 대비 폴백, A/B 분배, 요금제별 분기, 사용자별 비용 한도 같은 템플릿에서 시작할 수 있습니다."
            actions={
              writes.access.allowed ? (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  <Plus aria-hidden="true" /> 첫 경로 만들기
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {routes.length > 0 ? (
          <div className="data-table-scroll" tabIndex={0} aria-label="동적 경로 표 영역">
            <table className="data-table">
              <caption className="sr-only">동적 경로 목록</caption>
              <thead>
                <tr>
                  <th scope="col">경로</th>
                  <th scope="col">상태</th>
                  <th scope="col">버전</th>
                  <th scope="col">요청(24시간)</th>
                  <th scope="col">실패·폴백</th>
                  <th scope="col">최근 변경</th>
                  <th scope="col">
                    <span className="sr-only">열기</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {routes.map((route) => (
                  <tr key={route.id}>
                    <th scope="row">
                      <Link
                        className="dr-route-link"
                        to={`${dynamicRoutesBasePath}/${encodeURIComponent(route.id)}`}
                      >
                        {route.name}
                      </Link>
                      <code className="dr-call-model">{route.call_model}</code>
                      {route.description ? <span className="dr-route-desc">{route.description}</span> : null}
                    </th>
                    <td>
                      <DynamicRouteStateBadge route={route} />
                    </td>
                    <td>
                      {route.deployed_version > 0 ? `v${route.deployed_version} 배포` : "배포 없음"}
                      {route.latest_version > route.deployed_version ? (
                        <span className="dr-muted"> · 최신 v{route.latest_version}</span>
                      ) : null}
                    </td>
                    <td>{formatNumber(route.traffic_24h.requests)}</td>
                    <td>
                      {formatNumber(route.traffic_24h.failures)} · {formatNumber(route.traffic_24h.fallbacks)}
                    </td>
                    <td>
                      <time dateTime={route.updated_at}>{formatDateTime(route.updated_at)}</time>
                    </td>
                    <td>
                      <Link
                        className="button button-ghost button-small"
                        to={`${dynamicRoutesBasePath}/${encodeURIComponent(route.id)}`}
                        aria-label={`${route.name} 열기`}
                      >
                        열기 <ArrowRight aria-hidden="true" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
      </SectionCard>

      <DynamicRouteCreateDialog
        open={creating}
        onOpenChange={setCreating}
        returnFocusRef={createRef}
        writes={writes}
        onCreated={(id) => void navigate(`${dynamicRoutesBasePath}/${encodeURIComponent(id)}`)}
      />
    </div>
  );
}
