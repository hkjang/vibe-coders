import { AlertTriangle, Construction, LockKeyhole, Power, RefreshCw } from "lucide-react";

import { Button } from "@/shared/components/ui/Button";

export function LoadingState({ label = "화면을 준비하는 중입니다." }: { label?: string }): React.JSX.Element {
  return (
    <div className="page-state" role="status" aria-live="polite">
      <div className="skeleton skeleton-title" />
      <div className="skeleton skeleton-line" />
      <span className="sr-only">{label}</span>
    </div>
  );
}

interface ErrorStateProps {
  title?: string;
  message: string;
  requestId?: string;
  diagnosticCode?: string;
  onRetry?: () => void;
  showLegacy?: boolean;
}

export function ErrorState({
  title = "화면을 불러오지 못했습니다.",
  message,
  requestId,
  diagnosticCode,
  onRetry,
  showLegacy = true,
}: ErrorStateProps): React.JSX.Element {
  return (
    <section className="page-state page-state-error" role="alert">
      <AlertTriangle aria-hidden="true" />
      <h1>{title}</h1>
      <p>{message}</p>
      {requestId ? <p className="request-id">요청 ID: {requestId}</p> : null}
      {diagnosticCode ? <p className="request-id">진단 코드: {diagnosticCode}</p> : null}
      <div className="state-actions">
        {onRetry ? (
          <Button variant="primary" onClick={onRetry}>
            <RefreshCw aria-hidden="true" /> 다시 시도
          </Button>
        ) : null}
        {showLegacy ? (
          <a className="button button-secondary button-default" href="/admin">
            기존 관리자 화면 열기
          </a>
        ) : null}
      </div>
    </section>
  );
}

export function AppDisabled(): React.JSX.Element {
  return (
    <section className="page-state" role="status" aria-live="polite">
      <Power aria-hidden="true" />
      <h1>신규 콘솔이 비활성화되어 있습니다.</h1>
      <p>운영자가 `/app`을 활성화할 때까지 안정 운영 화면을 이용하세요.</p>
      <a className="button button-primary button-default" href="/admin">
        기존 관리자 화면 열기
      </a>
    </section>
  );
}

export function FeatureUnavailable(): React.JSX.Element {
  return (
    <section className="page-state" role="alert">
      <Construction aria-hidden="true" />
      <h1>이 UI 버전에서 사용할 수 없는 기능입니다.</h1>
      <p>
        기능 전환 상태와 현재 UI 빌드가 일치하지 않습니다. 운영자에게 전환 설정을 확인해 달라고 요청하세요.
      </p>
      <a className="button button-primary button-default" href="/app/overview">
        개요로 이동
      </a>
    </section>
  );
}

function deniedFeatureCopy(reason: string | undefined): { title: string; message: string } {
  switch (reason) {
    case "authentication_required":
      return { title: "로그인이 필요합니다.", message: "다시 로그인한 뒤 이 화면을 열어 주세요." };
    case "feature_hidden":
      return {
        title: "현재 숨김 처리된 기능입니다.",
        message: "운영자에게 기능 전환 상태를 확인해 달라고 요청하세요.",
      };
    case "outside_rollout":
    case "rollout":
      return {
        title: "아직 이 기능의 배포 대상이 아닙니다.",
        message: "점진 배포 범위에 포함되면 사용할 수 있습니다.",
      };
    case "role_not_enabled":
    case "preview_role":
      return {
        title: "현재 역할에는 미리보기가 열려 있지 않습니다.",
        message: "운영자에게 이 기능의 미리보기 대상 역할을 확인해 달라고 요청하세요.",
      };
    case "permission_denied":
    default:
      return {
        title: "접근 권한이 없습니다.",
        message: "이 화면을 보려면 관리자에게 필요한 권한을 요청하세요.",
      };
  }
}

export function PermissionDenied({
  permission,
  reason,
}: {
  permission?: string;
  reason?: string;
}): React.JSX.Element {
  const copy = deniedFeatureCopy(reason);
  return (
    <section className="page-state" role="alert">
      <LockKeyhole aria-hidden="true" />
      <h1>{copy.title}</h1>
      <p>{copy.message}</p>
      {permission ? <p className="request-id">필요 권한: {permission}</p> : null}
      <a className="button button-secondary button-default" href="/app/overview">
        개요로 이동
      </a>
    </section>
  );
}
