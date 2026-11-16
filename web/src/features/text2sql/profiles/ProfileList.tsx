import { useMemo, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { Text2SQLConnectionRow, Text2SQLProfileRow } from "@/shared/api/domains/text2sql";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { createDataTableColumnHelper, type DataTableColumn } from "@/shared/data-table/columns";
import { DataTable } from "@/shared/data-table/DataTable";
import { operationLabel, writeDisabledTitle } from "../overview/text2sql-labels";
import { text2sqlInvalidations, text2sqlRouteId } from "../overview/use-text2sql-queries";
import { useText2SqlMutation } from "../overview/use-text2sql-mutation";
import { Text2SqlProfileConnection } from "../overview/Text2SqlProfileConnection";
import { ProfileEditDialog } from "./ProfileEditDialog";
interface Props {
  canWrite: boolean;
  profiles: readonly Text2SQLProfileRow[];
  profilesLoading: boolean;
  connections: readonly Text2SQLConnectionRow[];
  connectionsLoading: boolean;
  connectionsError: unknown;
}
export function ProfileList({
  canWrite,
  profiles,
  profilesLoading,
  connections,
  connectionsLoading,
  connectionsError,
}: Props): React.JSX.Element {
  const [profileDialog, setProfileDialog] = useState<{ model?: string }>();
  const [profileToDelete, setProfileToDelete] = useState("");
  const profileTriggerRef = useRef<HTMLElement | null>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const removeProfile = useText2SqlMutation({
    authorized: canWrite,
    mutate: (virtualModel: string) =>
      apiClient.request(endpoints.domains.text2sql.profiles.remove, {
        query: { virtual_model: virtualModel },
        routeId: text2sqlRouteId,
      }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "런타임 프로필을 삭제했습니다.",
  });
  const profileColumns = useMemo(() => {
    const profileColumn = createDataTableColumnHelper<Text2SQLProfileRow>();
    return profileColumn.columns([
      profileColumn.accessor((row) => row.virtual_model, {
        id: "virtual_model",
        header: "가상 모델",
        cell: ({ row }) => (
          <div className="t2s-cell-stack">
            <code className="mono">{row.original.virtual_model}</code>
            {row.original.enabled ? null : <Badge tone="muted">서버 기본 설정 사용</Badge>}
          </div>
        ),
      }),
      profileColumn.accessor((row) => row.mode, {
        id: "mode",
        header: "모드",
        cell: ({ getValue }) => operationLabel(getValue()),
      }),
      profileColumn.accessor((row) => row.upstream_model, {
        id: "upstream",
        header: "업스트림",
        cell: ({ getValue }) => getValue() || "—",
      }),
      profileColumn.accessor((row) => row.summary_model, {
        id: "summary",
        header: "요약 모델",
        cell: ({ getValue }) => getValue() || "—",
      }),
      profileColumn.accessor((row) => row.schema_name, {
        id: "schema",
        header: "스키마",
        cell: ({ getValue }) => getValue() || "—",
      }),
      profileColumn.accessor((row) => row.exec_connection_id, {
        id: "connection",
        header: "실행 DB",
        cell: ({ getValue }) => (
          <Text2SqlProfileConnection
            id={getValue()}
            connections={connections}
            loading={connectionsLoading}
            error={connectionsError}
          />
        ),
      }),
      profileColumn.display({
        id: "actions",
        header: "동작",
        cell: ({ row }) => (
          <div className="t2s-action-buttons">
            <Button
              size="small"
              disabled={!canWrite}
              title={writeDisabledTitle(canWrite)}
              onClick={(event) => {
                profileTriggerRef.current = event.currentTarget;
                setProfileDialog({ model: row.original.virtual_model });
              }}
            >
              수정
            </Button>
            <Button
              size="small"
              variant="danger"
              disabled={!canWrite}
              title={writeDisabledTitle(canWrite)}
              onClick={(event) => {
                rowTriggerRef.current = event.currentTarget;
                setProfileToDelete(row.original.virtual_model);
              }}
            >
              삭제
            </Button>
          </div>
        ),
      }),
    ]) as Array<DataTableColumn<Text2SQLProfileRow>>;
  }, [canWrite, connections, connectionsError, connectionsLoading]);

  return (
    <>
      <SectionCard
        title="런타임 프로필 (DB 오버라이드 · 신규 가상 모델)"
        description="환경 기본값을 덮어쓰거나 새 vibe/text2sql-* 가상 모델을 추가합니다."
        actions={
          <Button
            variant="primary"
            disabled={!canWrite}
            title={writeDisabledTitle(canWrite)}
            onClick={(event) => {
              profileTriggerRef.current = event.currentTarget;
              setProfileDialog({});
            }}
          >
            프로필 추가
          </Button>
        }
      >
        <DataTable
          caption="런타임 Text2SQL 프로필"
          columns={profileColumns}
          data={profiles}
          loading={profilesLoading}
          getRowId={(row) => row.virtual_model}
          emptyMessage="런타임 프로필이 없습니다. 추가하면 환경 기본값을 덮어쓰거나 새 가상 모델을 정의할 수 있습니다."
        />
      </SectionCard>

      {profileDialog ? (
        <ProfileEditDialog
          model={profileDialog.model}
          canWrite={canWrite}
          connections={connections}
          connectionsError={connectionsError}
          connectionsLoading={connectionsLoading}
          returnFocusRef={profileTriggerRef}
          onClose={() => setProfileDialog(undefined)}
        />
      ) : null}

      <ConfirmDialog
        confirmDisabled={!canWrite}
        open={profileToDelete !== ""}
        onOpenChange={(next) => {
          if (!next) setProfileToDelete("");
        }}
        returnFocusRef={rowTriggerRef}
        tone="danger"
        title="런타임 프로필 삭제"
        description={`${profileToDelete} 프로필을 삭제하면 이 가상 모델은 환경 기본값으로 되돌아갑니다.`}
        confirmLabel="삭제"
        onConfirm={async () => {
          await removeProfile.mutateAsync(profileToDelete);
          setProfileToDelete("");
        }}
      />
    </>
  );
}
