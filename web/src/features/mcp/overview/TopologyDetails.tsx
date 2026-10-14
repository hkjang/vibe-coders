import type { McpTopologyNode } from "@/shared/api/domains/mcp.schemas";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { topologyKind, topologyState, topologyEdgeLabel, type topologyModel } from "./mcp-topology-model";

export function TopologyDetails({
  node,
  model,
  onSelect,
  onClear,
}: {
  node: McpTopologyNode;
  model: ReturnType<typeof topologyModel>;
  onSelect: (id: string) => void;
  onClear: () => void;
}) {
  const rows = [
    ...(model.incoming.get(node.id) ?? []).map((edge) => ({
      direction: "들어오는 연결",
      other: edge.from,
      label: edge.label,
    })),
    ...(model.outgoing.get(node.id) ?? []).map((edge) => ({
      direction: "나가는 연결",
      other: edge.to,
      label: edge.label,
    })),
  ];
  return (
    <SectionCard title="선택한 연결 상세" actions={<Button onClick={onClear}>선택 해제</Button>}>
      <KeyValueList
        items={[
          { label: "이름", value: node.label || node.id },
          { label: "노드 ID", value: node.id, mono: true },
          { label: "종류", value: topologyKind(node.kind) },
          { label: "사용 상태", value: topologyState(node.status) },
          { label: "현재 정책 판단", value: topologyState(node.decision) },
        ]}
      />
      <p>정책 판단은 조회 시점의 서버 설정이며 과거 호출의 결과나 연결 성공을 뜻하지 않습니다.</p>
      {rows.length ? (
        <div className="mcp-topology-connections" role="region" aria-label="선택한 노드의 연결" tabIndex={0}>
          <table>
            <caption>선택한 노드의 연결 {rows.length}개</caption>
            <thead>
              <tr>
                <th scope="col">방향</th>
                <th scope="col">연결 대상</th>
                <th scope="col">관계·메서드</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={index}>
                  <td>{row.direction}</td>
                  <td>
                    {model.byId.has(row.other) ? (
                      <Button variant="ghost" onClick={() => onSelect(row.other)}>
                        {model.byId.get(row.other)?.label || row.other}
                      </Button>
                    ) : (
                      <>목록에 없는 노드: {row.other}</>
                    )}
                  </td>
                  <td>{topologyEdgeLabel(row.label)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p>서버가 반환한 연결이 없습니다.</p>
      )}
    </SectionCard>
  );
}
