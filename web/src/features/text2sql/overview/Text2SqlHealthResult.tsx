import { useAuth } from "@/app/auth/AuthProvider";
import type { Text2SQLHealthcheck } from "@/shared/api/domains/text2sql";
import { InlineNotice, type NoticeTone } from "@/shared/components/ui/InlineNotice";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { StatusBadge } from "./text2sql-presentation";

function checkLabel(value: boolean | null | undefined): string {
  return value === true ? "정상" : value === false ? "실패" : "확인 안 함";
}
const tones: Record<string, NoticeTone> = { ok: "success", warn: "warning", error: "danger" };

export function Text2SqlHealthResult({
  connectionId,
  result,
}: {
  connectionId: string;
  result: Text2SQLHealthcheck;
}): React.JSX.Element {
  const auth = useAuth();
  const diagnostic = (value: string | undefined): string =>
    value && containsPotentialSecret(value, auth.credentialPrefixes)
      ? "민감한 연결 정보는 표시하지 않습니다."
      : value || "—";
  return (
    <InlineNotice
      tone={tones[result.status] ?? "info"}
      title={`연결 점검 결과 — ${diagnostic(connectionId)}`}
    >
      <KeyValueList
        items={[
          { label: "상태", value: <StatusBadge value={diagnostic(result.status)} /> },
          { label: "설명", value: diagnostic(result.detail) },
          { label: "드라이버", value: diagnostic(result.driver) },
          { label: "DB 연결", value: checkLabel(result.reachable) },
          { label: "기본 조회", value: checkLabel(result.query_ok) },
          { label: "읽기 전용 트랜잭션", value: checkLabel(result.read_only_tx_ok) },
          { label: "점검 제한 시간 적용", value: checkLabel(result.statement_timeout_ok) },
          { label: "설정된 실행 제한 시간", value: diagnostic(result.statement_timeout) },
          { label: "점검 제한 시간", value: diagnostic(result.probe_timeout) },
          { label: "계정 쓰기 제한", value: "별도 확인 필요" },
        ]}
      />
      <p>
        연결 점검만으로 계정 전체의 쓰기 제한을 확인할 수 없습니다. 실행을 허용하기 전에 DB 계정 권한을 별도로
        검토하세요.
      </p>
    </InlineNotice>
  );
}
