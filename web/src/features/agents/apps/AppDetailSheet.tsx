import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type RefObject } from "react";

import { appComponentKindLabels } from "@/features/agents/apps/app-form";
import { AppInspectionPanel } from "./AppInspectionPanel";
import { AppPermissionDialog } from "@/features/agents/apps/AppPermissionDialog";
import { AppPermissionPanel } from "@/features/agents/apps/AppPermissionPanel";
import { useAppPermissionDraft } from "@/features/agents/apps/use-app-permission-draft";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

interface AppDetailSheetProps {
  app: WorkApp | undefined;
  canWrite: boolean;
  onDelete: () => void;
  onDeprecate: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  writeDisabledReason: string;
}

export function AppDetailSheet(props: AppDetailSheetProps): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <AppDetailSheetContent {...props} />
  ) : (
    <UnsavedChangesProvider>
      <AppDetailSheetContent {...props} />
    </UnsavedChangesProvider>
  );
}

function AppDetailSheetContent({
  app: selectedApp,
  canWrite,
  onDelete,
  onDeprecate,
  onEdit,
  onOpenChange,
  onPublish,
  open,
  returnFocusRef,
  writeDisabledReason,
}: AppDetailSheetProps): React.JSX.Element {
  const permissionEditor = useAppPermissionDraft(canWrite);
  // A refetch or an external selection change cannot retarget an open draft.
  const app = permissionEditor.target?.app ?? selectedApp;
  const permissionOpen = Boolean(permissionEditor.target);
  const [showVersions, setShowVersions] = useState(false);
  const [showPermissions, setShowPermissions] = useState(false);
  const permissionsButtonRef = useRef<HTMLButtonElement>(null);
  const appId = app?.id ?? "";
  const versions = useQuery({
    queryKey: ["agents", "apps", appId, "versions"],
    enabled: open && showVersions && appId !== "",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.versions, { id: appId }), {
        signal,
        routeId: "agents.apps",
      }),
  });
  const components = app?.components ?? [];

  return (
    <Sheet
      description="AI 업무 앱의 구성 요소를 확인하고 검증·실행·발행·권한을 관리합니다."
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else
          permissionEditor.requestLeave(() => {
            setShowVersions(false);
            setShowPermissions(false);
            onOpenChange(false);
          });
      }}
      open={open || Boolean(permissionEditor.target)}
      returnFocusRef={returnFocusRef}
      size="wide"
      title={app ? `${app.icon ?? ""} ${app.title ?? app.id}`.trim() : "AI 업무 앱"}
    >
      {!app ? (
        <EmptyState title="앱을 찾을 수 없습니다." description="목록에서 다시 선택하세요." />
      ) : (
        <div className="agents-detail-stack">
          <KeyValueList
            items={[
              { label: "ID", value: app.id, mono: true },
              {
                label: "상태",
                value: (
                  <Badge tone={app.status === "active" ? "success" : "muted"}>
                    {app.status === "active" ? "활성" : (app.status ?? "—")}
                  </Badge>
                ),
              },
              { label: "설명", value: app.description },
              { label: "책임자", value: app.owner },
              { label: "허용 팀", value: app.allowed_teams || "전체" },
              { label: "허용 역할", value: app.allowed_roles || "전체" },
              { label: "구성 요소", value: formatNumber(components.length) },
              { label: "수정일", value: formatDateTime(app.updated_at) },
            ]}
          />

          <div className="agents-detail-actions">
            <Button
              onClick={onPublish}
              disabled={!canWrite || permissionOpen}
              title={canWrite ? undefined : writeDisabledReason}
            >
              발행
            </Button>
            <Button
              onClick={onDeprecate}
              disabled={!canWrite || permissionOpen}
              title={canWrite ? undefined : writeDisabledReason}
            >
              지원 중단
            </Button>
            <Button
              onClick={() => setShowVersions((current) => !current)}
              aria-expanded={showVersions}
              disabled={permissionOpen}
            >
              버전 이력
            </Button>
            <Button
              ref={permissionsButtonRef}
              onClick={() =>
                permissionEditor.requestLeave(() => {
                  permissionEditor.returnFocusRef.current = permissionsButtonRef.current;
                  setShowPermissions((current) => !current);
                })
              }
              disabled={permissionEditor.pending}
              aria-expanded={showPermissions}
            >
              권한 관리
            </Button>
            <Button
              onClick={onEdit}
              disabled={!canWrite || permissionOpen}
              title={canWrite ? undefined : writeDisabledReason}
            >
              수정
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
              disabled={!canWrite || permissionOpen}
              title={canWrite ? undefined : writeDisabledReason}
            >
              삭제
            </Button>
          </div>
          {!canWrite ? (
            <InlineNotice tone="info" title="읽기 전용">
              {writeDisabledReason}
            </InlineNotice>
          ) : null}

          <SectionCard title="구성 요소" headingLevel={3}>
            {components.length === 0 ? (
              <EmptyState
                title="구성 요소가 없습니다."
                description="Skill, 프롬프트 상품, Text2SQL 리포트 등을 추가하면 실행 계획이 만들어집니다."
              />
            ) : (
              <div className="data-table-scroll" tabIndex={0} aria-label="앱 구성 요소 표 영역">
                <table className="data-table">
                  <caption className="sr-only">AI 업무 앱 구성 요소</caption>
                  <thead>
                    <tr>
                      <th scope="col">종류</th>
                      <th scope="col">참조</th>
                      <th scope="col">라벨</th>
                    </tr>
                  </thead>
                  <tbody>
                    {components.map((component, index) => (
                      <tr key={`${component.kind ?? ""}-${component.ref ?? ""}-${index}`}>
                        <td>
                          {appComponentKindLabels[
                            (component.kind ?? "") as keyof typeof appComponentKindLabels
                          ] ??
                            component.kind ??
                            "—"}
                        </td>
                        <td className="mono">{component.ref || "—"}</td>
                        <td>{component.label || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </SectionCard>

          <AppInspectionPanel app={app} disabled={permissionOpen} />

          {showVersions ? (
            <SectionCard title="버전 이력" headingLevel={3}>
              {versions.isPending ? (
                <p role="status">버전 이력을 불러오는 중입니다.</p>
              ) : versions.isError ? (
                <InlineNotice
                  tone="danger"
                  title="버전 이력을 불러오지 못했습니다."
                  actions={
                    <Button size="small" onClick={() => void versions.refetch()}>
                      다시 시도
                    </Button>
                  }
                >
                  {safeAppErrorMessage(versions.error, "버전 이력을 불러오지 못했습니다.")}
                </InlineNotice>
              ) : (versions.data?.versions ?? []).length === 0 ? (
                <EmptyState
                  title="발행된 버전이 없습니다."
                  description="발행하면 현재 정의가 첫 버전으로 저장됩니다."
                />
              ) : (
                <div className="data-table-scroll" tabIndex={0} aria-label="앱 버전 표 영역">
                  <table className="data-table">
                    <caption className="sr-only">AI 업무 앱 발행 버전 이력</caption>
                    <thead>
                      <tr>
                        <th scope="col">버전</th>
                        <th scope="col">발행자</th>
                        <th scope="col">발행일</th>
                        <th scope="col">구성 요소</th>
                        <th scope="col">메모</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(versions.data?.versions ?? []).map((version) => (
                        <tr key={version.id ?? String(version.version)}>
                          <td className="cell-number">v{formatNumber(version.version)}</td>
                          <td>{version.published_by ?? "—"}</td>
                          <td>{formatDateTime(version.published_at)}</td>
                          <td className="cell-number">{formatNumber(version.components?.length ?? 0)}</td>
                          <td className="truncate">{version.note || "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </SectionCard>
          ) : null}

          {showPermissions ? (
            <AppPermissionPanel
              app={app}
              canWrite={canWrite}
              editor={permissionEditor}
              writeDisabledReason={writeDisabledReason}
            />
          ) : null}
          {permissionEditor.target ? (
            <AppPermissionDialog
              key={permissionEditor.target.instance}
              target={permissionEditor.target}
              editor={permissionEditor}
              canWrite={canWrite}
              writeDisabledReason={writeDisabledReason}
            />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
