import { useAuth } from "@/app/auth/AuthProvider";
import { versionLabels } from "@/app/layouts/version-labels";
import { apiVersionMismatch } from "@/shared/api/version";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { LegacyLink } from "@/shared/components/ui/LegacyLink";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { staleBundle } from "@/shared/utils/ui-version";

export function AppVersionNotice(): React.JSX.Element | null {
  const auth = useAuth();
  const apiMismatch = apiVersionMismatch(auth.apiVersion);
  const outdated = staleBundle(__UI_VERSION__, auth.uiVersion);
  if (!apiMismatch && !outdated) return null;

  return (
    <InlineNotice
      className="app-version-notice"
      tone="warning"
      title={apiMismatch ? versionLabels.apiMismatchTitle : versionLabels.staleTitle}
      actions={
        <>
          <Button size="small" onClick={() => window.location.reload()}>
            {versionLabels.refresh}
          </Button>
          {apiMismatch && canOpenLegacyAdmin(auth) ? (
            <LegacyLink className="button button-secondary button-small" href="/admin">
              {versionLabels.legacy}
            </LegacyLink>
          ) : null}
        </>
      }
    >
      {apiMismatch ? (
        versionLabels.apiMismatchDescription
      ) : (
        <>
          이 탭은 {__UI_VERSION__} 화면을 쓰고 있고 서버는 {auth.uiVersion}입니다. 새로고침하면 최신 화면으로
          바뀝니다.
        </>
      )}
    </InlineNotice>
  );
}
