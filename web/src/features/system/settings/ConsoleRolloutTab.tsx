import { useMemo, useRef, useState } from "react";

import { migrationRegistry } from "@/config/migration-registry";
import {
  ConsoleFeatureDialog,
  type ConsoleFeatureEdit,
} from "@/features/system/settings/ConsoleFeatureDialog";
import { SettingDetailSheet } from "@/features/system/settings/SettingDetailSheet";
import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import {
  buildConsoleFeatureRows,
  consoleGlobalSettings,
  isConsoleSetting,
  settingDisplayValue,
  settingEditPermission,
  type ConsoleFeatureRow,
} from "@/features/system/settings/settings-utils";
import {
  routeId,
  systemSettingsKeys,
  useEffectiveSettings,
} from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { EffectiveSetting } from "@/shared/api/domains/system.schemas";
import { pathWithParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

const system = endpoints.domains.system;

const featureTitles = new Map(
  migrationRegistry.map((feature) => [feature.featureId as string, feature.title as string]),
);

const statusTones: Record<string, "danger" | "info" | "muted" | "success" | "warning"> = {
  hidden: "muted",
  legacy: "muted",
  preview_read_only: "info",
  preview: "info",
  stable: "success",
  deprecated: "warning",
  retired: "danger",
};

function fieldValue(setting: EffectiveSetting | undefined): string {
  return setting?.value ?? "—";
}

export function ConsoleRolloutTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const settingsQuery = useEffectiveSettings();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<ConsoleFeatureRow | undefined>();
  const [globalKey, setGlobalKey] = useState<string | undefined>();

  const consoleSettings = useMemo(
    () => (settingsQuery.data?.settings ?? []).filter(isConsoleSetting),
    [settingsQuery.data?.settings],
  );
  const globals = useMemo(() => consoleGlobalSettings(consoleSettings), [consoleSettings]);
  const featureRows = useMemo(() => buildConsoleFeatureRows(consoleSettings), [consoleSettings]);
  const selectedGlobal = globals.find((setting) => setting.key === globalKey);

  const editableSetting = editing?.status ?? editing?.roles ?? editing?.rollout ?? editing?.readonly;
  const permission = editableSetting
    ? settingEditPermission(editableSetting, hasAdminWrite)
    : { editable: hasAdminWrite, reason: hasAdminWrite ? undefined : "admin:write 권한이 필요합니다." };

  const writeSetting = async (setting: EffectiveSetting, value: string, reason: string): Promise<void> => {
    const endpoint = system.settings.update;
    await apiClient.request(
      { ...endpoint, path: pathWithParams(endpoint.path, { key: setting.key }) },
      {
        body: {
          value,
          ...(reason ? { reason } : {}),
          ...(setting.version === undefined ? {} : { expected_version: setting.version }),
        },
        routeId,
      },
    );
  };

  const saveFeature = useMutationFeedback({
    mutate: async (input: { row: ConsoleFeatureRow; changes: ConsoleFeatureEdit; reason: string }) => {
      // Each key is its own setting; writing them one at a time keeps a partial
      // failure visible instead of silently dropping the remaining fields.
      const entries: Array<[EffectiveSetting | undefined, string | undefined]> = [
        [input.row.status, input.changes.status],
        [input.row.roles, input.changes.roles],
        [input.row.rollout, input.changes.rollout],
        [input.row.readonly, input.changes.readonly],
      ];
      for (const [setting, value] of entries) {
        if (!setting || value === undefined) continue;
        await writeSetting(setting, value, input.reason);
      }
      return input.row.featureId;
    },
    invalidates: [systemSettingsKeys.effective],
    successMessage: "콘솔 전환 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.",
    errorMessage: "콘솔 전환 설정을 저장하지 못했습니다.",
  });

  const saveGlobal = useMutationFeedback({
    mutate: async (input: { setting: EffectiveSetting; value: string; reason: string }) =>
      writeSetting(input.setting, input.value, input.reason),
    invalidates: [systemSettingsKeys.effective],
    successMessage: "콘솔 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.",
    errorMessage: "콘솔 설정을 저장하지 못했습니다.",
  });

  return (
    <div className="settings-tab-stack">
      <InlineNotice tone="warning" title="변경 후 새로고침이 필요합니다.">
        `/app` 전환 상태는 콘솔이 시작할 때 한 번 읽습니다. 값을 저장한 뒤 브라우저를 새로고침해야 새 상태가
        적용되며, 다른 사용자에게는 각자의 다음 새로고침부터 반영됩니다.
      </InlineNotice>

      {settingsQuery.isError ? (
        <QueryNotice
          error={settingsQuery.error}
          hasPreviousData={Boolean(settingsQuery.data)}
          label="콘솔 전환 설정"
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : null}

      <SectionCard
        title="콘솔 전체 설정"
        headingLevel={3}
        description="신규 콘솔의 활성화 여부와 기본 진입 화면을 결정합니다."
      >
        {settingsQuery.isPending ? (
          <p role="status">콘솔 전환 설정을 불러오는 중입니다.</p>
        ) : (
          <table className="data-table">
            <caption className="sr-only">콘솔 전체 설정</caption>
            <thead>
              <tr>
                <th scope="col">설정 키</th>
                <th scope="col">현재 값</th>
                <th scope="col">적용 출처</th>
                <th scope="col">작업</th>
              </tr>
            </thead>
            <tbody>
              {globals.map((setting) => (
                <tr key={setting.key}>
                  <th scope="row">
                    <span className="mono">{setting.key}</span>
                    <small>{setting.description}</small>
                  </th>
                  <td className="mono">{settingDisplayValue(setting)}</td>
                  <td>{setting.source === "admin" ? "DB 오버라이드" : "환경변수"}</td>
                  <td>
                    <Button
                      size="small"
                      variant="ghost"
                      aria-label={`${setting.key} 편집`}
                      onClick={(event) => {
                        triggerRef.current = event.currentTarget;
                        setGlobalKey(setting.key);
                      }}
                    >
                      편집
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <SectionCard
        title="기능별 전환 상태"
        headingLevel={3}
        description="화면마다 기존 화면 유지·미리보기·정식 전환과 대상 역할, 배포 비율을 조정합니다."
      >
        <table className="data-table">
          <caption className="sr-only">기능별 콘솔 전환 상태</caption>
          <thead>
            <tr>
              <th scope="col">기능</th>
              <th scope="col">상태</th>
              <th scope="col">미리보기 역할</th>
              <th scope="col">배포 비율</th>
              <th scope="col">읽기 전용</th>
              <th scope="col">작업</th>
            </tr>
          </thead>
          <tbody>
            {featureRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="data-table-state">
                  {settingsQuery.isPending
                    ? "콘솔 전환 설정을 불러오는 중입니다."
                    : "전환 설정을 제공하는 기능이 없습니다."}
                </td>
              </tr>
            ) : (
              featureRows.map((row) => {
                const status = row.status?.value ?? "";
                return (
                  <tr key={row.featureId}>
                    <th scope="row">
                      <span>{featureTitles.get(row.featureId) ?? row.featureId}</span>
                      <small className="mono">{row.featureId}</small>
                    </th>
                    <td>
                      <Badge tone={statusTones[status] ?? "muted"}>{status || "—"}</Badge>
                    </td>
                    <td className="mono truncate">{fieldValue(row.roles) || "—"}</td>
                    <td className="cell-number">{fieldValue(row.rollout)}</td>
                    <td>{fieldValue(row.readonly)}</td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${featureTitles.get(row.featureId) ?? row.featureId} 전환 설정 편집`}
                        onClick={(event) => {
                          triggerRef.current = event.currentTarget;
                          setEditing(row);
                        }}
                      >
                        편집
                      </Button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </SectionCard>

      <UpdatedAt at={settingsQuery.dataUpdatedAt} />

      <ConsoleFeatureDialog
        open={editing !== undefined}
        onOpenChange={(next) => {
          if (!next) setEditing(undefined);
        }}
        disabledReason={permission.editable ? undefined : permission.reason}
        onSubmit={(input) => saveFeature.mutateAsync(input)}
        pending={saveFeature.isPending}
        returnFocusRef={triggerRef}
        row={editing}
        title={`${featureTitles.get(editing?.featureId ?? "") ?? editing?.featureId ?? ""} 전환 설정`}
      />

      <SettingDetailSheet
        hasAdminWrite={hasAdminWrite}
        open={selectedGlobal !== undefined}
        onOpenChange={(next) => {
          if (!next) setGlobalKey(undefined);
        }}
        onRequestRevert={() => setGlobalKey(undefined)}
        onRequestRollback={() => setGlobalKey(undefined)}
        onSave={(input) => saveGlobal.mutateAsync(input)}
        pending={saveGlobal.isPending}
        returnFocusRef={triggerRef}
        setting={selectedGlobal}
      />
    </div>
  );
}
