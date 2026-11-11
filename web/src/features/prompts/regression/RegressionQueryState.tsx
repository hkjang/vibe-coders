import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { formatDateTime, formatRelative } from "@/shared/utils/format";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useAuth } from "@/app/auth/AuthProvider";

export function RegressionQueryState({
  error,
  updatedAt,
  fetching,
  retry,
}: {
  error: unknown;
  updatedAt: number;
  fetching: boolean;
  retry: () => void;
}) {
  const { credentialPrefixes } = useAuth();
  const requestID = isAppError(error) ? error.requestId : undefined;
  return (
    <>
      {error ? (
        <InlineNotice
          tone="danger"
          title="데이터를 갱신하지 못했습니다."
          actions={<Button onClick={retry}>다시 조회</Button>}
        >
          {updatedAt
            ? "마지막 정상 조회 결과입니다. 최신 상태는 다시 조회해 확인하세요."
            : "연결 상태와 권한을 확인한 뒤 다시 조회하세요."}
          {requestID && !containsPotentialSecret(requestID, credentialPrefixes) ? (
            <p>요청 ID: {requestID}</p>
          ) : null}
        </InlineNotice>
      ) : null}
      <p className="muted" role="status">
        {fetching ? "조회 중 · " : ""}
        {updatedAt ? (
          <span title={formatDateTime(updatedAt)}>마지막 정상 갱신: {formatRelative(updatedAt)}</span>
        ) : (
          "아직 정상 조회한 데이터가 없습니다."
        )}
      </p>
    </>
  );
}
