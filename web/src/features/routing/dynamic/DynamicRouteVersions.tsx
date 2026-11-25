import { FileDown, History, Rocket, Undo2 } from "lucide-react";
import { useRef, useState } from "react";

import type {
  DynamicRoute,
  DynamicRouteGraph,
  DynamicRouteVersion,
} from "@/shared/api/domains/routing-dynamic";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { formatDateTime } from "@/shared/utils/format";

import {
  dynamicRouteErrorMessage,
  loadDynamicRouteVersion,
  type useDynamicRouteWrites,
} from "./use-dynamic-routes";

interface VersionsProps {
  route: DynamicRoute;
  versions: readonly DynamicRouteVersion[];
  writes: ReturnType<typeof useDynamicRouteWrites>;
  dirty: boolean;
  onLoad: (graph: DynamicRouteGraph, version: number) => void;
}

/**
 * Every save is a version. Deploying one makes it serve traffic; deploying an
 * older one is the rollback, and it takes effect on this replica at once and on
 * the others within five seconds.
 */
export function DynamicRouteVersions({
  route,
  versions,
  writes,
  dirty,
  onLoad,
}: VersionsProps): React.JSX.Element {
  const [target, setTarget] = useState<DynamicRouteVersion>();
  const [loadError, setLoadError] = useState<string>();
  const [done, setDone] = useState<string>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const rollback = target !== undefined && target.version < route.deployed_version;
  const readOnly = !writes.access.allowed;

  return (
    <SectionCard
      title="버전"
      description={`배포 중: ${route.deployed_version > 0 ? `v${route.deployed_version}` : "없음"} · 최신 v${route.latest_version}. 최근 100개를 보여 줍니다.`}
    >
      {done ? (
        <InlineNotice tone="success" title={done}>
          이 게이트웨이는 바로, 다른 인스턴스는 5초 안에 새 버전으로 요청을 처리합니다.
        </InlineNotice>
      ) : null}
      {loadError ? (
        <InlineNotice tone="danger" title="버전을 불러오지 못했습니다.">
          {loadError}
        </InlineNotice>
      ) : null}
      <div className="data-table-scroll" tabIndex={0} aria-label="버전 표 영역">
        <table className="data-table">
          <caption className="sr-only">동적 경로 버전 목록</caption>
          <thead>
            <tr>
              <th scope="col">버전</th>
              <th scope="col">메모</th>
              <th scope="col">작성</th>
              <th scope="col">
                <span className="sr-only">동작</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version) => {
              const deployed = version.version === route.deployed_version;
              return (
                <tr key={version.version}>
                  <th scope="row">
                    v{version.version} {deployed ? <Badge tone="success">배포 중</Badge> : null}
                    {version.version === route.latest_version && !deployed ? (
                      <Badge tone="warning">최신</Badge>
                    ) : null}
                  </th>
                  <td>{version.note || <span className="dr-muted">메모 없음</span>}</td>
                  <td>
                    <span>{version.created_by || "알 수 없음"}</span>
                    <br />
                    <time className="dr-muted" dateTime={version.created_at}>
                      {formatDateTime(version.created_at)}
                    </time>
                  </td>
                  <td className="dr-row-actions">
                    <Button
                      size="small"
                      variant="ghost"
                      onClick={() => {
                        setLoadError(undefined);
                        void loadDynamicRouteVersion(route.id, version.version)
                          .then((result) => {
                            if (result.version.graph) onLoad(result.version.graph, version.version);
                          })
                          .catch((error: unknown) => setLoadError(dynamicRouteErrorMessage(error)));
                      }}
                      title={dirty ? "편집 중인 변경을 이 버전 내용으로 바꿉니다." : undefined}
                    >
                      <FileDown aria-hidden="true" /> 편집기로 불러오기
                    </Button>
                    {!deployed ? (
                      <Button
                        size="small"
                        variant={version.version > route.deployed_version ? "primary" : "secondary"}
                        disabled={readOnly || writes.deploy.isPending}
                        onClick={(event) => {
                          triggerRef.current = event.currentTarget;
                          setDone(undefined);
                          setTarget(version);
                        }}
                      >
                        {version.version > route.deployed_version ? (
                          <Rocket aria-hidden="true" />
                        ) : (
                          <Undo2 aria-hidden="true" />
                        )}
                        {version.version > route.deployed_version ? "배포" : "이 버전으로 롤백"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {versions.length === 0 ? (
        <p className="dr-hint">
          <History aria-hidden="true" /> 버전이 없습니다.
        </p>
      ) : null}

      <ConfirmDialog
        open={target !== undefined}
        onOpenChange={(open) => {
          if (!open) setTarget(undefined);
        }}
        returnFocusRef={triggerRef}
        tone={rollback ? "danger" : "primary"}
        title={target ? (rollback ? `v${target.version}으로 롤백` : `v${target.version} 배포`) : "배포"}
        description={
          target
            ? `${route.call_model} 요청이 v${route.deployed_version || "-"} 대신 v${target.version}으로 처리됩니다. 저장된 다른 버전은 그대로 남습니다.`
            : ""
        }
        confirmLabel={rollback ? "롤백" : "배포"}
        requireReason={rollback}
        onConfirm={async (reason) => {
          if (!target) return;
          const result = await writes.deploy.mutateAsync({
            id: route.id,
            version: target.version,
            expected: route.deployed_version,
            reason,
          });
          setDone(
            rollback
              ? `v${result.route.deployed_version}으로 롤백했습니다.`
              : `v${result.route.deployed_version}을 배포했습니다.`,
          );
        }}
      />
    </SectionCard>
  );
}
