import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";

import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";
import { formatDateTime } from "@/shared/utils/format";

interface AppPermissionPanelProps {
  appId: string;
  canWrite: boolean;
  writeDisabledReason: string;
}

const subjectTypes = [
  { value: "user", label: "사용자" },
  { value: "team", label: "팀" },
];

/** Explicit per-app grants (`ai_app_permissions`) shown alongside the team/role gate. */
export function AppPermissionPanel({
  appId,
  canWrite,
  writeDisabledReason,
}: AppPermissionPanelProps): React.JSX.Element {
  const fieldId = useId();
  const [subjectType, setSubjectType] = useState("user");
  const [subjectId, setSubjectId] = useState("");
  const permissionsKey = ["agents", "apps", appId, "permissions"] as const;

  const permissions = useQuery({
    queryKey: permissionsKey,
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.permissions, { id: appId }), {
        signal,
        routeId: "agents.apps",
      }),
  });

  const grant = useMutationFeedback({
    mutate: (variables: { subject_type: string; subject_id: string }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.grantPermission, { id: appId }), {
        body: variables,
        routeId: "agents.apps",
      }),
    invalidates: [permissionsKey],
    successMessage: "권한을 추가했습니다.",
    errorMessage: "권한을 추가하지 못했습니다.",
    onSuccess: () => setSubjectId(""),
  });

  const revoke = useMutationFeedback({
    mutate: (variables: { subject_type: string; subject_id: string }) =>
      apiClient.request(withPathParams(endpoints.domains.agents.apps.revokePermission, { id: appId }), {
        query: variables,
        routeId: "agents.apps",
      }),
    invalidates: [permissionsKey],
    successMessage: "권한을 회수했습니다.",
    errorMessage: "권한을 회수하지 못했습니다.",
  });

  const rows = permissions.data?.permissions ?? [];

  return (
    <SectionCard
      title="명시 권한"
      headingLevel={3}
      description="팀/역할 조건을 통과하지 못하는 사용자에게도 이 앱을 직접 열어 줍니다."
    >
      <form
        className="toolbar"
        onSubmit={(event) => {
          event.preventDefault();
          if (subjectId.trim() === "") return;
          grant.mutate({ subject_type: subjectType, subject_id: subjectId.trim() });
        }}
      >
        <div className="toolbar-start">
          <label className="agents-toolbar-field" htmlFor={`${fieldId}-type`}>
            <span>대상 종류</span>
            <Select
              id={`${fieldId}-type`}
              options={subjectTypes}
              value={subjectType}
              onChange={(event) => setSubjectType(event.target.value)}
            />
          </label>
          <label className="agents-toolbar-field" htmlFor={`${fieldId}-subject`}>
            <span>대상 ID</span>
            <Input
              id={`${fieldId}-subject`}
              value={subjectId}
              onChange={(event) => setSubjectId(event.target.value)}
              placeholder="사용자 ID 또는 팀 ID"
            />
          </label>
        </div>
        <div className="toolbar-end">
          <Button
            type="submit"
            variant="primary"
            size="small"
            disabled={!canWrite || grant.isPending || subjectId.trim() === ""}
            title={canWrite ? undefined : writeDisabledReason}
          >
            권한 추가
          </Button>
        </div>
      </form>

      {permissions.isError ? (
        <InlineNotice
          tone="danger"
          title="권한 목록을 불러오지 못했습니다."
          actions={
            <Button size="small" onClick={() => void permissions.refetch()}>
              다시 시도
            </Button>
          }
        >
          {safeAppErrorMessage(permissions.error, "권한 목록을 불러오지 못했습니다.")}
        </InlineNotice>
      ) : null}

      {permissions.isPending ? (
        <p role="status">권한 목록을 불러오는 중입니다.</p>
      ) : rows.length === 0 ? (
        <EmptyState
          title="명시 권한이 없습니다."
          description="특정 사용자나 팀에게만 열어 주려면 위에서 권한을 추가하세요."
        />
      ) : (
        <div className="data-table-scroll" tabIndex={0} aria-label="앱 명시 권한 표 영역">
          <table className="data-table">
            <caption className="sr-only">AI 업무 앱 명시 권한 목록</caption>
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
              {rows.map((permission) => (
                <tr key={permission.id ?? `${permission.subject_type}-${permission.subject_id}`}>
                  <td>{permission.subject_type === "team" ? "팀" : "사용자"}</td>
                  <td className="mono">{permission.subject_id ?? "—"}</td>
                  <td>{permission.granted_by ?? "—"}</td>
                  <td>{formatDateTime(permission.created_at)}</td>
                  <td>
                    <Button
                      size="small"
                      variant="danger"
                      disabled={!canWrite || revoke.isPending}
                      title={canWrite ? undefined : writeDisabledReason}
                      aria-label={`${permission.subject_id ?? ""} 권한 회수`}
                      onClick={() =>
                        revoke.mutate({
                          subject_type: permission.subject_type ?? "user",
                          subject_id: permission.subject_id ?? "",
                        })
                      }
                    >
                      회수
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}
