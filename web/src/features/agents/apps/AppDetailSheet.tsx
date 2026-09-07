import { useQuery } from "@tanstack/react-query";
import { useRef, useState, type RefObject } from "react";

import { appComponentKindLabels } from "@/features/agents/apps/app-form";
import { AppPermissionPanel } from "@/features/agents/apps/AppPermissionPanel";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import type { AppRunPlan, AppValidation, WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Sheet } from "@/shared/components/ui/Sheet";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime, formatNumber } from "@/shared/utils/format";

interface AppDetailSheetProps {
  app: WorkApp | undefined;
  canWrite: boolean;
  onDelete: () => void;
  onDeprecate: () => void;
  onEdit: () => void;
  onOpenChange: (open: boolean) => void;
  onPublish: () => void;
  onRun: () => void;
  onValidate: () => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
  runError: Error | null;
  runPending: boolean;
  runPlan: AppRunPlan | undefined;
  validation: AppValidation | undefined;
  validationError: Error | null;
  validationPending: boolean;
  writeDisabledReason: string;
}

export function AppDetailSheet({
  app,
  canWrite,
  onDelete,
  onDeprecate,
  onEdit,
  onOpenChange,
  onPublish,
  onRun,
  onValidate,
  open,
  returnFocusRef,
  runError,
  runPending,
  runPlan,
  validation,
  validationError,
  validationPending,
  writeDisabledReason,
}: AppDetailSheetProps): React.JSX.Element {
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
        if (!next) {
          setShowVersions(false);
          setShowPermissions(false);
        }
        onOpenChange(next);
      }}
      open={open}
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
            <Button variant="primary" onClick={onValidate} disabled={validationPending}>
              {validationPending ? "검증 중" : "검증"}
            </Button>
            <Button onClick={onRun} disabled={runPending}>
              {runPending ? "실행 계획 생성 중" : "실행(플랜)"}
            </Button>
            <Button
              onClick={onPublish}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              발행
            </Button>
            <Button
              onClick={onDeprecate}
              disabled={!canWrite}
              title={canWrite ? undefined : writeDisabledReason}
            >
              지원 중단
            </Button>
            <Button onClick={() => setShowVersions((current) => !current)} aria-expanded={showVersions}>
              버전 이력
            </Button>
            <Button
              ref={permissionsButtonRef}
              onClick={() => setShowPermissions((current) => !current)}
              aria-expanded={showPermissions}
            >
              권한 관리
            </Button>
            <Button onClick={onEdit} disabled={!canWrite} title={canWrite ? undefined : writeDisabledReason}>
              수정
            </Button>
            <Button
              variant="danger"
              onClick={onDelete}
              disabled={!canWrite}
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

          {validationError ? (
            <InlineNotice tone="danger" title="검증에 실패했습니다.">
              {safeAppErrorMessage(validationError, "검증을 실행하지 못했습니다.")}
            </InlineNotice>
          ) : null}
          {validation ? (
            <SectionCard title="검증 결과" headingLevel={3}>
              <InlineNotice tone={validation.ok ? "success" : "warning"}>
                {validation.ok ? "모든 구성 요소를 확인했습니다." : "확인되지 않은 구성 요소가 있습니다."}
              </InlineNotice>
              <ul className="agents-checklist">
                {(validation.checks ?? []).map((check, index) => (
                  <li key={`${check.kind ?? ""}-${index}`} data-ok={String(check.resolved !== false)}>
                    <span className="agents-checklist-copy">
                      <strong>{check.label || check.ref || check.kind || "구성 요소"}</strong>
                      <small>
                        {check.kind ?? "—"}
                        {check.detail ? ` · ${check.detail}` : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
              {(validation.warnings ?? []).length > 0 ? (
                <InlineNotice tone="warning" title="경고">
                  {(validation.warnings ?? []).join(" · ")}
                </InlineNotice>
              ) : null}
              {(validation.allowed_models ?? []).length > 0 ? (
                <p>허용 모델: {(validation.allowed_models ?? []).join(", ")}</p>
              ) : null}
            </SectionCard>
          ) : null}

          {runError ? (
            <InlineNotice tone="danger" title="실행 계획을 만들지 못했습니다.">
              {safeAppErrorMessage(runError, "실행 계획을 만들지 못했습니다.")}
            </InlineNotice>
          ) : null}
          {runPlan ? (
            <SectionCard title="실행 계획" headingLevel={3} description={runPlan.note ?? undefined}>
              <KeyValueList
                columns={3}
                items={[
                  { label: "실행 ID", value: runPlan.run_id, mono: true },
                  { label: "상태", value: runPlan.status },
                  { label: "단계", value: formatNumber(runPlan.plan?.length ?? 0) },
                ]}
              />
              <ul className="agents-checklist">
                {(runPlan.plan ?? []).map((step, index) => (
                  <li key={`${step.kind ?? ""}-${index}`} data-ok={String(step.resolved !== false)}>
                    <span className="agents-checklist-copy">
                      <strong>
                        {index + 1}. {step.label || step.ref || step.kind || "단계"}
                      </strong>
                      <small>
                        {step.action ?? "—"}
                        {step.endpoint ? ` · ${step.endpoint}` : ""}
                        {step.hint ? ` · ${step.hint}` : ""}
                      </small>
                    </span>
                  </li>
                ))}
              </ul>
            </SectionCard>
          ) : null}

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
              appId={app.id}
              canWrite={canWrite}
              writeDisabledReason={writeDisabledReason}
            />
          ) : null}
        </div>
      )}
    </Sheet>
  );
}
