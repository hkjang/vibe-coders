import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { migrationRegistry } from "@/config/migration-registry";
import { migrationStatusLabels, roleLabel } from "@/config/ui-labels";
import {
  ConsoleFeatureDialog,
  type ConsoleFeatureEdit,
} from "@/features/system/settings/ConsoleFeatureDialog";
import { SettingDetailSheet } from "@/features/system/settings/SettingDetailSheet";
import {
  SettingsRecoveryDialog,
  type SettingRecovery,
} from "@/features/system/settings/SettingsRecoveryDialog";
import { ConsoleUsagePanel } from "@/features/system/settings/ConsoleUsagePanel";
import { QueryNotice, UpdatedAt } from "@/features/system/settings/SettingsParts";
import { settingSaveOutcome, type SettingSaveResult } from "@/features/system/settings/setting-save-outcome";
import {
  buildConsoleFeatureRows,
  consoleGlobalSettings,
  consoleSettingLabels,
  isConsoleSetting,
  normalizedBoolean,
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
import { useSettingsReloadNotice } from "@/features/system/settings/use-settings-reload-notice";

const system = endpoints.domains.system;

const conflictMessage =
  "다른 작업자가 전환 설정을 변경해 저장하지 않았습니다. 입력한 내용을 확인한 뒤 대화상자를 닫고 다시 열어 최신 설정과 비교하세요.";

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

function statusDisplay(status: string): string {
  return Object.prototype.hasOwnProperty.call(migrationStatusLabels, status)
    ? migrationStatusLabels[status as keyof typeof migrationStatusLabels]
    : "확인 불가";
}

function roleCodes(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role !== "");
}

function roleDisplay(value: string | undefined): React.JSX.Element {
  const roles = roleCodes(value);
  if (roles.length === 0) return <span>기능별 기본 역할 제한</span>;
  return (
    <span className="settings-key-cell">
      <span>{roles.map((role) => roleLabel(role)).join(", ")}</span>
      <small className="mono">{roles.join(", ")}</small>
    </span>
  );
}

function readOnlyDisplay(value: string | undefined): React.JSX.Element {
  const normalized = normalizedBoolean(value ?? "false");
  return (
    <span className="settings-key-cell">
      <span>{normalized === "true" ? "쓰기 차단" : "쓰기 허용"}</span>
      <small className="mono">{normalized}</small>
    </span>
  );
}

export function ConsoleRolloutTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const settingsQuery = useEffectiveSettings();
  const triggerRef = useRef<HTMLElement | null>(null);
  const [editing, setEditing] = useState<ConsoleFeatureRow | undefined>();
  const [selectedGlobal, setSelectedGlobal] = useState<EffectiveSetting | undefined>();
  const [recovery, setRecovery] = useState<SettingRecovery | undefined>();
  const [conflict, setConflict] = useState(false);
  const { reloadPending, setReloadPending } = useSettingsReloadNotice();

  const consoleSettings = useMemo(
    () => (settingsQuery.data?.settings ?? []).filter(isConsoleSetting),
    [settingsQuery.data?.settings],
  );
  const globals = useMemo(() => consoleGlobalSettings(consoleSettings), [consoleSettings]);
  const featureRows = useMemo(() => buildConsoleFeatureRows(consoleSettings), [consoleSettings]);

  const editableSetting = editing?.status ?? editing?.roles ?? editing?.rollout ?? editing?.readonly;
  const permission = editableSetting
    ? settingEditPermission(editableSetting, hasAdminWrite)
    : { editable: hasAdminWrite, reason: hasAdminWrite ? undefined : "admin:write 권한이 필요합니다." };

  const writeSetting = async (
    setting: EffectiveSetting,
    value: string,
    reason: string,
  ): Promise<SettingSaveResult> => {
    const endpoint = system.settings.update;
    return settingSaveOutcome(() =>
      apiClient.request(
        { ...endpoint, path: pathWithParams(endpoint.path, { key: setting.key }) },
        {
          body: {
            value,
            ...(reason ? { reason } : {}),
            expected_version: setting.version ?? 0,
          },
          routeId,
        },
      ),
    );
  };

  const saveFeature = useMutationFeedback({
    mutate: async (input: {
      row: ConsoleFeatureRow;
      changes: ConsoleFeatureEdit;
      reason: string;
    }): Promise<SettingSaveResult> => {
      const entries: Array<[EffectiveSetting | undefined, string | undefined]> = [
        [input.row.status, input.changes.status],
        [input.row.roles, input.changes.roles],
        [input.row.rollout, input.changes.rollout],
        [input.row.readonly, input.changes.readonly],
      ];
      const settings = entries.flatMap(([setting, value]) =>
        setting && value !== undefined && value !== setting.value
          ? [{ key: setting.key, value, expected_version: setting.version ?? 0 }]
          : [],
      );
      return settingSaveOutcome(() =>
        apiClient.request(system.settings.bulk, {
          body: { settings, reason: input.reason },
          routeId,
        }),
      );
    },
    invalidates: [systemSettingsKeys.effective],
    onSuccess: (result) => {
      if (result.outcome === "conflict") {
        setConflict(true);
      } else if (result.outcome === "reload_pending") {
        setReloadPending({ requestId: result.requestId });
      } else {
        setReloadPending(undefined);
        toast.success("콘솔 전환 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.");
      }
    },
    errorMessage: "콘솔 전환 설정을 저장하지 못했습니다.",
  });

  const saveGlobal = useMutationFeedback({
    mutate: async (input: { setting: EffectiveSetting; value: string; reason: string }) =>
      writeSetting(input.setting, input.value, input.reason),
    invalidates: [systemSettingsKeys.effective],
    onSuccess: (result) => {
      if (result.outcome === "reload_pending") setReloadPending({ requestId: result.requestId });
      else if (result.outcome === "saved") {
        setReloadPending(undefined);
        toast.success("콘솔 설정을 저장했습니다. 화면을 새로고침하면 적용됩니다.");
      }
    },
    errorMessage: "콘솔 설정을 저장하지 못했습니다.",
  });

  return (
    <div className="settings-tab-stack">
      <InlineNotice tone="warning" title="변경 후 새로고침이 필요합니다.">
        저장 후 새로고침하면 전환 상태를 다시 확인합니다. 활성 탭은 주기적으로 설정을 확인하지만, 서버 반영
        대기나 연결 오류가 있으면 적용이 늦어질 수 있습니다.
      </InlineNotice>

      {reloadPending ? (
        <InlineNotice tone="warning" title="설정은 저장됐으며 런타임 반영을 기다리고 있습니다.">
          저장된 설정의 반영을 기다리는 상태입니다. 다시 저장하지 말고 최신 설정과 서버 반영 상태를
          확인하세요. 이 조회는 현재 요청을 처리한 서버의 상태이며 모든 서버의 적용 완료를 뜻하지 않습니다.
          {reloadPending?.requestId ? (
            <span className="request-id"> 요청 ID: {reloadPending.requestId}</span>
          ) : null}
        </InlineNotice>
      ) : null}

      {settingsQuery.isError ? (
        <QueryNotice
          error={settingsQuery.error}
          hasPreviousData={Boolean(settingsQuery.data)}
          label="콘솔 전환 설정"
          onRetry={() => void settingsQuery.refetch()}
        />
      ) : null}

      <ConsoleUsagePanel />

      <SectionCard
        title="콘솔 전체 설정"
        headingLevel={2}
        description="신규 콘솔의 활성화 여부와 기본 진입 화면을 결정합니다."
      >
        {settingsQuery.isPending ? (
          <p role="status">콘솔 전환 설정을 불러오는 중입니다.</p>
        ) : (
          <div className="data-table-scroll" role="region" aria-label="콘솔 전체 설정 표" tabIndex={0}>
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
                      <span>{consoleSettingLabels[setting.key] ?? setting.key}</span>
                      <small className="mono">{setting.key}</small>
                      <small>{setting.description}</small>
                    </th>
                    <td className="mono">{settingDisplayValue(setting)}</td>
                    <td>{setting.source === "admin" ? "DB 오버라이드" : "환경변수"}</td>
                    <td>
                      <Button
                        size="small"
                        variant="ghost"
                        aria-label={`${consoleSettingLabels[setting.key] ?? setting.key} 편집`}
                        onClick={(event) => {
                          triggerRef.current = event.currentTarget;
                          setSelectedGlobal({ ...setting });
                        }}
                      >
                        편집
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>

      <SectionCard
        title="기능별 전환 상태"
        headingLevel={2}
        description="화면마다 기존 화면 유지·미리보기·정식 전환과 대상 역할, 배포 비율을 조정합니다."
      >
        <div className="data-table-scroll" role="region" aria-label="기능별 전환 상태 표" tabIndex={0}>
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
                        {status ? (
                          <span className="settings-key-cell">
                            <Badge tone={statusTones[status] ?? "muted"}>{statusDisplay(status)}</Badge>
                            <small className="mono">{status}</small>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>{roleDisplay(row.roles?.value)}</td>
                      <td className="cell-number">
                        {row.rollout?.value === undefined ? "—" : `${row.rollout.value}%`}
                      </td>
                      <td>{row.readonly ? readOnlyDisplay(row.readonly.value) : "—"}</td>
                      <td>
                        <Button
                          size="small"
                          variant="ghost"
                          aria-label={`${featureTitles.get(row.featureId) ?? row.featureId} 전환 설정 편집`}
                          onClick={(event) => {
                            triggerRef.current = event.currentTarget;
                            setConflict(false);
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
        </div>
      </SectionCard>

      <UpdatedAt at={settingsQuery.dataUpdatedAt} />

      <ConsoleFeatureDialog
        open={editing !== undefined}
        onOpenChange={(next) => {
          if (!next) setEditing(undefined);
        }}
        disabledReason={conflict ? conflictMessage : permission.editable ? undefined : permission.reason}
        onSubmit={async (input) => {
          const result = await saveFeature.mutateAsync(input);
          // Keep the draft visible after a conflict, with saving disabled until
          // the operator reopens the editor against the refreshed settings.
          if (result.outcome === "conflict") throw result.error;
        }}
        pending={saveFeature.isPending}
        returnFocusRef={triggerRef}
        row={editing}
        title={`${featureTitles.get(editing?.featureId ?? "") ?? editing?.featureId ?? ""} 전환 설정`}
      />

      <SettingDetailSheet
        hasAdminWrite={hasAdminWrite}
        open={selectedGlobal !== undefined}
        onOpenChange={(next) => {
          if (!next) setSelectedGlobal(undefined);
        }}
        onRequestRevert={(setting) => setRecovery({ kind: "revert", setting })}
        onRequestRollback={(setting, historyId, historyCount) =>
          setRecovery({ kind: "rollback", setting, historyId, historyCount })
        }
        onSave={async (input) => {
          const result = await saveGlobal.mutateAsync(input);
          if (result.outcome === "conflict") throw result.error;
        }}
        pending={saveGlobal.isPending}
        returnFocusRef={triggerRef}
        setting={selectedGlobal}
      />
      <SettingsRecoveryDialog
        request={recovery}
        onClose={() => setRecovery(undefined)}
        hasAdminWrite={hasAdminWrite}
        onReloadPending={(requestId) => setReloadPending({ requestId })}
        onSaved={() => setReloadPending(undefined)}
        returnFocusRef={triggerRef}
      />
    </div>
  );
}
