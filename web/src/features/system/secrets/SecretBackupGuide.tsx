import { CopyButton } from "@/shared/components/ui/CopyButton";

const sqliteCommand =
  "gateway verify-secret-backup --sqlite /backup/gateway.db --key-file /run/secrets/gateway-key";
const postgresCommand = "gateway verify-secret-backup --postgres --key-file /run/secrets/gateway-key";

/** Offline operations only: the browser never receives a backup or its key. */
export function SecretBackupGuide({ expanded = false }: { expanded?: boolean }) {
  return (
    <details className="secret-backup-guide" open={expanded || undefined}>
      <summary>백업과 비밀키 일치 확인</summary>
      <div className="secret-backup-content">
        <p>
          v0.86.135 이상 게이트웨이 바이너리로 격리된 백업을 읽기 전용 검사할 수 있습니다.
          공급자·MCP·Text2SQL·비밀 설정·SSO의 암호문을 확인하며 키, 원문, 항목 이름을 출력하지 않습니다.
        </p>
        <ol className="secret-steps">
          <li>
            교체 전 DB와 당시 환경 파일을 함께 보관하세요. SQLite는 일관된 독립 백업 파일을, PostgreSQL은 별도
            데이터베이스에 복원한 사본을 준비합니다. 검사 중 사본을 변경하지 마세요.
          </li>
          <li>
            확인할 키를 접근이 제한된 일반 파일에 보관합니다. 환경 파일 전체가 아닌 키 값만 넣고, 원래 값에
            없던 줄바꿈·따옴표·공백을 추가하지 마세요. 명령 인자에 키를 직접 넣지 않습니다.
          </li>
          <li>백업을 읽을 수 있는 점검 환경에서 아래 명령을 실행하고 종료 코드와 결과를 함께 확인하세요.</li>
        </ol>
        <div className="secret-backup-command">
          <div className="secret-backup-command-title">
            <h2>SQLite 백업 검사</h2>
            <CopyButton label="SQLite 검사 명령 복사" value={sqliteCommand} />
          </div>
          <pre tabIndex={0} aria-label="SQLite 백업 검사 명령">
            <code>{sqliteCommand}</code>
          </pre>
          <p>
            비어 있지 않은 WAL·저널이 붙은 파일은 거부합니다. 파일을 삭제하지 말고 일관 백업을 다시 만드세요.
          </p>
        </div>
        <div className="secret-backup-command">
          <div className="secret-backup-command-title">
            <h2>PostgreSQL 복원본 검사</h2>
            <CopyButton label="PostgreSQL 검사 명령 복사" value={postgresCommand} />
          </div>
          <p>
            격리 복원본의 연결 문자열을 <code>SECRET_BACKUP_POSTGRES_DSN</code> 환경변수로 지정하세요. 평소
            서버가 사용하는 DB 연결과 키는 자동으로 읽지 않습니다.
          </p>
          <pre tabIndex={0} aria-label="PostgreSQL 복원본 검사 명령">
            <code>{postgresCommand}</code>
          </pre>
        </div>
        <dl className="secret-backup-results">
          <div>
            <dt>일치 · matched · 종료 코드 0</dt>
            <dd>
              비어 있지 않은 암호문을 모두 읽었습니다. 실제 공급자 호출과 SSO 로그인은 별도로 검증하세요.
            </dd>
          </div>
          <div>
            <dt>불일치 · mismatch · 종료 코드 1</dt>
            <dd>키가 다르거나 암호문이 손상됐습니다. 일부 성공만으로 전체 키가 맞다고 판단하지 않습니다.</dd>
          </div>
          <div>
            <dt>입력 오류 · 종료 코드 2</dt>
            <dd>대상과 키 파일을 확인하세요. 입력값은 오류에 다시 표시하지 않습니다.</dd>
          </div>
          <div>
            <dt>판정 불가 · 종료 코드 3</dt>
            <dd>
              비밀값 없음(no_secrets), 연결·스키마 오류, 제한 초과 또는 시간 초과입니다. 키가 틀렸다는 뜻은
              아닙니다.
            </dd>
          </div>
        </dl>
        <p>
          교체 응답을 잃었다면 현재 DB의 격리 사본을 이전 키와 새 키로 각각 검사하세요. 복구할 때는 교체 전
          DB와 해당 키를 함께 복원합니다. 이 검사는 복원·키 교체를 실행하지 않으며 여러 서버의 교체를 조정하지
          않습니다.
        </p>
      </div>
    </details>
  );
}
