import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { containsPotentialSecret, defaultCredentialPrefixes } from "@/shared/security/secrets";
import { connectionOutcomeLabels } from "./provider-connection-state";
import type { useProviderConnection } from "./use-provider-connection";

export function ProviderConnectionPanel({
  connection,
  disabled,
  credentialPrefixes = defaultCredentialPrefixes,
}: {
  connection: ReturnType<typeof useProviderConnection>;
  disabled: boolean;
  credentialPrefixes?: readonly string[];
}): React.JSX.Element {
  const result = connection.result;
  const requestId = connection.error?.requestId;
  const safeRequestId =
    requestId && !containsPotentialSecret(requestId, credentialPrefixes) ? requestId : undefined;
  return (
    <section className="provider-connection-panel form-grid" aria-label="저장 전 연결 테스트">
      <p>
        모델 목록 HTTP 연결만 확인합니다. 추론은 실행하지 않으며 공급자를 저장하지 않습니다. 공급자 측 요청
        기록이나 비용이 발생하지 않는다는 보장은 없습니다.
      </p>
      {connection.allowNoKey ? (
        <Checkbox
          label="API 키 없이 확인"
          description="이 초안은 API 키를 보내지 않습니다. 저장된 키를 삭제하는 기능이 아닙니다."
          checked={connection.noKey}
          disabled={disabled}
          onChange={(event) => connection.acknowledgeNoKey(event.target.checked)}
        />
      ) : null}
      {connection.phase === "request" ? (
        <InlineNotice>연결을 확인하고 있습니다. 저장과 다른 검사는 완료 후 가능합니다.</InlineNotice>
      ) : null}
      {connection.error ? (
        <InlineNotice tone="danger" title="연결 테스트를 실행하지 못했습니다.">
          {connection.error.message}
          {safeRequestId ? <span className="request-id"> 요청 ID: {safeRequestId}</span> : null}
        </InlineNotice>
      ) : null}
      {result ? (
        <section aria-label="저장 전 연결 테스트 결과" className="form-grid">
          {connection.stale ? (
            <InlineNotice tone="warning">
              연결 입력이 달라졌습니다. 다시 연결 테스트를 실행하세요.
            </InlineNotice>
          ) : null}
          <InlineNotice
            tone={
              connection.stale ? "info" : result.value.outcome === "catalog_available" ? "success" : "warning"
            }
            title={connection.stale ? "이전 입력의 연결 결과" : connectionOutcomeLabels[result.value.outcome]}
          >
            <dl>
              <dt>공급자 HTTP 상태</dt>
              <dd>{result.value.upstream_status ?? "응답 헤더 미수신"}</dd>
              <dt>확인 소요 시간</dt>
              <dd>{result.value.duration_ms} ms</dd>
              <dt>적용된 검사 제한 시간</dt>
              <dd>{result.value.timeout_ms} ms</dd>
              {result.value.model_count !== null ? (
                <>
                  <dt>모델 수</dt>
                  <dd>{result.value.model_count}</dd>
                </>
              ) : null}
            </dl>
            <p>
              {result.mode === "stored"
                ? "검사 시점의 저장된 API 키를 사용했습니다. "
                : "실행 당시 초안의 인증 방식으로 확인했습니다. "}
              이후 저장 성공이나 실제 추론 성공을 보장하지 않습니다. 입력 변경 후에는 직접 다시 검사하세요.
            </p>
          </InlineNotice>
        </section>
      ) : null}
    </section>
  );
}
