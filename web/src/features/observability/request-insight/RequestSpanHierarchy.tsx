import type { RequestTraceSpan } from "@/shared/api/domains/observability.schemas";
import { RequestSpanRecord } from "./RequestSpanRecord";
import { spanRecordForest, type SpanRecordNode } from "./request-span-hierarchy";

interface DisplayProps {
  totalMs: number;
  credentialPrefixes: readonly string[];
}

function RecordBranch({ node, ...display }: DisplayProps & { node: SpanRecordNode }): React.JSX.Element {
  return (
    <li className="obs-span-lane">
      <RequestSpanRecord span={node.span} {...display} showBar={false} />
      {node.note ? <p className="request-flow-note">{node.note}</p> : null}
      {node.children.length ? (
        <details className="request-record-children" open>
          <summary>하위 기록 {node.children.length}개</summary>
          <ul className="obs-span-lanes" aria-label="하위 처리 기록">
            {node.children.map((child) => (
              <RecordBranch key={child.key} node={child} {...display} />
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

export function RequestSpanHierarchy({
  spans,
  ...display
}: DisplayProps & { spans: readonly RequestTraceSpan[] }): React.JSX.Element {
  const roots = spanRecordForest(spans, display.credentialPrefixes);
  return (
    <>
      <p className="request-flow-note">
        서버 응답에 명시된 상위·하위 기록 관계입니다. 실제 호출 순서나 인과관계를 뜻하지 않습니다. 연결을
        확인할 수 없는 기록도 별도로 표시합니다.
      </p>
      <ul className="obs-span-lanes request-record-tree" aria-label="요청 기록 관계">
        {roots.map((node) => (
          <RecordBranch key={node.key} node={node} {...display} />
        ))}
      </ul>
    </>
  );
}
