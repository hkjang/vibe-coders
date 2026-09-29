import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { useInlineSettingsDraft } from "@/features/system/settings/use-inline-settings-draft";
import { routeId, systemSettingsKeys } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import type { KeycloakConfig } from "@/shared/api/domains/system.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";

export interface SsoRoleRow {
  keycloakRole: string;
  internalRole: string;
}

export const ssoSaveStatusKey = ["system", "sso", "last-save-outcome"] as const;
type SaveOutcome = "none" | "reload_pending" | "read_failed";

function fromConfig(config: KeycloakConfig) {
  return {
    enabled: config.enabled,
    issuerUrl: config.issuer_url ?? "",
    clientId: config.client_id ?? "",
    clientSecret: "",
    clearSecret: false,
    redirectUri: config.redirect_uri ?? "",
    scopes: (config.scopes ?? []).join(","),
    defaultRole: config.default_role ?? "",
    roleClaim: config.role_claim ?? "",
    groupClaim: config.group_claim ?? "",
    allowLocalLogin: config.allow_local_login !== false,
    autoLogin: config.auto_login === true,
    roleMap: Object.entries(config.role_map ?? {}).map(([keycloakRole, internalRole]) => ({
      keycloakRole,
      internalRole,
    })),
  };
}

export function useSsoDraft(config: KeycloakConfig, hasAdminWrite: boolean) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ssoSaveStatusKey,
    queryFn: (): { outcome: SaveOutcome } => ({ outcome: "none" }),
    initialData: { outcome: "none" as SaveOutcome },
    enabled: false,
    gcTime: Infinity,
  });
  const setOutcome = (outcome: SaveOutcome): void => {
    client.setQueryData(ssoSaveStatusKey, { outcome });
  };
  const [confirmation, setConfirmation] = useState<{ resetRoleMap: boolean }>();
  const [locked, setLocked] = useState(status.data.outcome !== "none");
  const [error, setError] = useState<string>();
  const notice =
    status.data.outcome === "reload_pending"
      ? "설정은 저장되었지만 런타임 재적재에 실패했습니다. 다시 저장하지 마세요. 최신 설정 조회는 저장된 값만 확인하며 실제 로그인 적용이나 모든 파드의 활성 상태를 증명하지 않습니다. 운영 로그와 적용 상태를 확인하세요."
      : status.data.outcome === "read_failed"
        ? "설정은 저장되었습니다. 최신 설정을 조회하지 못해 추가 저장을 잠갔습니다. 다시 조회하세요."
        : undefined;
  const editor = useInlineSettingsDraft({
    config,
    fromConfig,
    held: confirmation !== undefined || locked,
    onDiscard: () => {
      setConfirmation(undefined);
      setLocked(false);
      setError(undefined);
    },
  });
  const { draft, baseline, guard, rebase } = editor;
  const sameSnapshotSaved = status.data.outcome === "reload_pending" && !editor.dirty;
  const reportError = (cause: unknown): void => {
    if (isAppError(cause) && cause.status === 409 && cause.code === "sso_config_conflict") {
      setLocked(true);
      setError(
        "서버의 SSO 설정이 변경되었습니다. 초안을 보존했습니다. 변경 취소 후 최신 설정을 다시 검토하세요.",
      );
    } else setError(safeAppErrorMessage(cause, "SSO 설정을 저장하지 못했습니다."));
  };
  const requestSave = (resetRoleMap = false): void => {
    if (!hasAdminWrite || guard.pending || locked || (sameSnapshotSaved && !resetRoleMap)) return;
    if (draft.clientSecret && (!draft.clientSecret.trim() || /[*•]{3,}/.test(draft.clientSecret))) {
      setError(
        "공백이나 마스킹된 값은 비밀키로 저장할 수 없습니다. 새 비밀키를 입력하거나 지우기를 선택하세요.",
      );
      return;
    }
    setError(undefined);
    setConfirmation({ resetRoleMap });
  };
  const save = (): Promise<void> => {
    if (!confirmation || !hasAdminWrite || locked) return Promise.resolve();
    const roleMap = Object.fromEntries(
      draft.roleMap
        .map((row) => [row.keycloakRole.trim(), row.internalRole.trim()])
        .filter(([key, value]) => key && value),
    );
    return guard.run(
      async () => {
        let reloadPending = false;
        try {
          await apiClient.request(endpoints.domains.system.sso.save, {
            routeId,
            body: {
              enabled: draft.enabled,
              issuer_url: draft.issuerUrl.trim(),
              client_id: draft.clientId.trim(),
              redirect_uri: draft.redirectUri.trim(),
              scopes: draft.scopes
                .split(",")
                .map((value) => value.trim())
                .filter(Boolean),
              default_role: draft.defaultRole.trim(),
              role_claim: draft.roleClaim.trim(),
              group_claim: draft.groupClaim.trim(),
              allow_local_login: draft.allowLocalLogin,
              auto_login: draft.autoLogin,
              role_map: confirmation.resetRoleMap ? {} : roleMap,
              ...(draft.clearSecret
                ? { client_secret: "" }
                : draft.clientSecret
                  ? { client_secret: draft.clientSecret }
                  : {}),
              expected_version: baseline.version ?? 0,
            },
          });
        } catch (cause) {
          if (!isAppError(cause) || cause.code !== "sso_reload_failed" || cause.status !== 500) throw cause;
          reloadPending = true;
        }
        // A failed follow-up read must never turn a committed save into a retry.
        const latest = await apiClient
          .request(endpoints.domains.system.sso.config, { routeId })
          .catch(() => undefined);
        return { latest, reloadPending };
      },
      reportError,
      ({ latest, reloadPending }) => {
        // A pre-commit background read must not later replace the accepted
        // snapshot. This callback already passed the guard's session check.
        void client.cancelQueries({ queryKey: systemSettingsKeys.sso, exact: true });
        setConfirmation(undefined);
        setError(undefined);
        if (latest) {
          client.setQueryData(systemSettingsKeys.sso, latest);
          rebase(latest);
        } else {
          // No secret is retained, even when the acknowledgement read fails.
          editor.acceptDraft({ ...draft, clientSecret: "", clearSecret: false });
        }
        setLocked(reloadPending || !latest);
        setOutcome(reloadPending ? "reload_pending" : !latest ? "read_failed" : "none");
        if (!reloadPending) toast.success("SSO 설정을 저장했습니다.");
      },
    );
  };
  const reload = (): void =>
    guard.requestClose(() => {
      // Explicit local discard only. Security and route disposal cannot trigger a read.
      setLocked(true);
      void guard.run(
        () => apiClient.request(endpoints.domains.system.sso.config, { routeId }),
        (cause) => setError(safeAppErrorMessage(cause, "최신 SSO 설정을 조회하지 못했습니다.")),
        (latest) => {
          void client.cancelQueries({ queryKey: systemSettingsKeys.sso, exact: true });
          client.setQueryData(systemSettingsKeys.sso, latest);
          rebase(latest);
          setLocked(false);
          setError(undefined);
          // Reading the persisted snapshot is not proof of runtime activation.
          if (status.data.outcome === "read_failed") setOutcome("none");
        },
      );
    });
  return {
    ...editor,
    confirmation,
    setConfirmation,
    locked,
    sameSnapshotSaved,
    error,
    notice,
    requestSave,
    save,
    reload,
  };
}
