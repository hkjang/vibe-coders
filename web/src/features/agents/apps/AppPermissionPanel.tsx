import { useQuery } from "@tanstack/react-query";

import { appPermissionDescription, appPermissionKey, appPermissionTarget } from "./app-permission-form";
import type { AppPermissionEditor } from "./use-app-permission-draft";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatDateTime } from "@/shared/utils/format";

interface AppPermissionPanelProps {
  app: WorkApp;
  canWrite: boolean;
  editor: AppPermissionEditor;
  writeDisabledReason: string;
}

/** Additional grants supplement (and never narrow) the app's existing team/role access. */
export function AppPermissionPanel({
  app,
  canWrite,
  editor,
  writeDisabledReason,
}: AppPermissionPanelProps): React.JSX.Element {
  const permissions = useQuery({
    queryKey: appPermissionKey(app.id),
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.permissions, { id: app.id }), {
        signal,
        routeId: "agents.apps",
      }),
  });
  const rows = permissions.data?.permissions ?? [];
  const locked = Boolean(editor.target);

  return (
    <SectionCard title="추가 앱 접근 권한" headingLevel={3} description={appPermissionDescription}>
      <div className="toolbar">
        <Button
          ref={(node) => editor.rememberTrigger(node, app.id)}
          variant="primary"
          size="small"
          disabled={!canWrite || locked}
          title={canWrite ? undefined : writeDisabledReason}
          onClick={(event) => {
            if (canWrite) editor.open(app, event.currentTarget);
          }}
        >
          접근 권한 추가
        </Button>
        <Button
          size="small"
          disabled={permissions.isFetching || editor.pending}
          onClick={() => void permissions.refetch()}
        >
          권한 목록 새로고침
        </Button>
      </div>
      {permissions.isError ? (
        <InlineNotice
          tone="danger"
          title="권한 목록을 불러오지 못했습니다."
          actions={
            <Button
              size="small"
              disabled={permissions.isFetching || editor.pending}
              onClick={() => void permissions.refetch()}
            >
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(permissions.error, "권한 목록을 불러오지 못했습니다.")}
          {isAppError(permissions.error) && permissions.error.requestId ? (
            <span className="request-id"> 요청 ID: {permissions.error.requestId}</span>
          ) : null}
          <p>목록을 다시 확인하세요. 추가 권한이 없는 상태로 판단하지 않습니다.</p>
        </InlineNotice>
      ) : permissions.isPending ? (
        <p role="status">권한 목록을 불러오는 중입니다.</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="추가 접근 권한이 없습니다."
          description="기존 팀·역할 조건에 따른 접근은 유지됩니다. 다른 사용자나 팀에게도 허용하려면 권한을 추가하세요."
        />
      ) : (
        <div className="data-table-scroll" tabIndex={0} aria-label="앱 추가 접근 권한 표 영역">
          <table className="data-table">
            <caption className="sr-only">앱 추가 접근 권한 목록</caption>
            <thead>
              <tr>
                <th scope="col">대상 종류</th>
                <th scope="col">대상 ID</th>
                <th scope="col">부여자</th>
                <th scope="col">부여일</th>
                <th scope="col">
                  <span className="sr-only">작업</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((permission, index) => {
                const subject = appPermissionTarget(permission);
                return (
                  <tr key={permission.id ?? `${permission.subject_type}-${permission.subject_id}-${index}`}>
                    <td>
                      {permission.subject_type === "team"
                        ? "팀"
                        : permission.subject_type === "user"
                          ? "사용자"
                          : `알 수 없는 종류 (${permission.subject_type || "없음"})`}
                    </td>
                    <td className="mono">{permission.subject_id || "—"}</td>
                    <td>{permission.granted_by || "—"}</td>
                    <td>{formatDateTime(permission.created_at)}</td>
                    <td>
                      <Button
                        ref={(node) => {
                          if (subject) editor.rememberTrigger(node, app.id, subject);
                        }}
                        size="small"
                        variant="danger"
                        disabled={!canWrite || locked || !subject}
                        title={
                          !canWrite
                            ? writeDisabledReason
                            : !subject
                              ? "대상 종류와 ID를 확인할 수 없어 회수할 수 없습니다."
                              : undefined
                        }
                        aria-label={`${permission.subject_id || "알 수 없는 대상"} 권한 회수`}
                        onClick={(event) => {
                          if (canWrite && subject) editor.open(app, event.currentTarget, subject);
                        }}
                      >
                        회수
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
