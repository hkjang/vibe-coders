import { Navigate, Outlet, useLocation } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { AppDisabled, ErrorState, LoadingState } from "@/shared/components/state/PageStates";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { appReturnTo } from "@/shared/utils/safe-return-to";

export function ProtectedRoute(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  if (auth.mode === "loading") return <LoadingState label="인증 상태를 확인하는 중입니다." />;
  if (auth.mode === "error") {
    return (
      <ErrorState
        message={auth.error ?? "인증 상태를 확인할 수 없습니다."}
        onRetry={() => void auth.retry()}
        showLegacy={canOpenLegacyAdmin(auth)}
      />
    );
  }
  if (!auth.uiEnabled) return <AppDisabled />;
  if (auth.mode === "anonymous") {
    const returnTo = appReturnTo(location.pathname, location.search, location.hash);
    return <Navigate replace to={`/login?return_to=${encodeURIComponent(returnTo)}`} />;
  }
  return <Outlet />;
}
