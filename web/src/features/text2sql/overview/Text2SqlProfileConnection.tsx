import type { Text2SQLConnectionRow } from "@/shared/api/domains/text2sql";
import { Badge } from "@/shared/components/ui/Badge";

interface Props {
  id: string;
  connections: readonly Text2SQLConnectionRow[];
  loading: boolean;
  error: unknown;
}

/** Registration state only: a saved connection is not proof that its DB is reachable. */
export function Text2SqlProfileConnection({ id, connections, loading, error }: Props) {
  const connectionId = id.trim();
  if (!connectionId || connectionId === "default") return <>기본 DB (서버 설정)</>;
  const connection = connections.find((item) => item.id === connectionId);
  return (
    <div className="t2s-cell-stack">
      <code className="mono">{connectionId}</code>
      {loading ? (
        <span>연결 확인 중</span>
      ) : error ? (
        <Badge tone="warning">연결 상태 확인 불가</Badge>
      ) : !connection ? (
        <Badge tone="danger">등록되지 않은 연결</Badge>
      ) : (
        <>
          <span>{connection.name || "등록된 연결"}</span>
          {!connection.enabled ? <Badge tone="danger">연결 중지</Badge> : null}
        </>
      )}
    </div>
  );
}
