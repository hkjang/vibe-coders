import { useRouteError } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { routeErrorMessage } from "@/app/router/route-error-message";
import { ErrorState } from "@/shared/components/state/PageStates";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";

export function RouteErrorPage(): React.JSX.Element {
  const auth = useAuth();
  const error = useRouteError();
  return (
    <ErrorState
      title="화면 오류"
      message={routeErrorMessage(error)}
      onRetry={() => window.location.reload()}
      showLegacy={canOpenLegacyAdmin(auth)}
    />
  );
}

export function NotFoundPage(): React.JSX.Element {
  return (
    <section className="page-state">
      <p className="eyebrow">404</p>
      <h1>화면을 찾을 수 없습니다.</h1>
      <p>주소를 확인하거나 개요로 돌아가세요.</p>
      <a className="button button-primary button-default" href="/app/overview">
        개요로 이동
      </a>
    </section>
  );
}
