import { useEffect, useRef } from "react";
import { useRouteError } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { routeErrorMessage } from "@/app/router/route-error-message";
import { ErrorState } from "@/shared/components/state/PageStates";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { reportBoundaryError } from "@/shared/telemetry/diagnostic-channel";

export function RouteErrorPage(): React.JSX.Element {
  const auth = useAuth();
  const error = useRouteError();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const observation = useRef<{ error: unknown } | undefined>(undefined);
  useEffect(() => {
    headingRef.current?.focus();
  }, [error]);
  useEffect(() => {
    // A cold deep link can fail before bootstrap resolves. Observe only the error
    // still on screen after opt-in is known; never replay an earlier route.
    if (observation.current?.error === error) return;
    if (reportBoundaryError(error, "route")) observation.current = { error };
  }, [error, auth]);
  return (
    <ErrorState
      title="화면 오류"
      message={routeErrorMessage(error)}
      headingRef={headingRef}
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
