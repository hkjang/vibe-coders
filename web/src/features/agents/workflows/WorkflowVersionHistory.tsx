import { useLayoutEffect, useRef, useState } from "react";
import type { WorkflowVersion } from "@/shared/api/domains/agents.schemas";
import { Button } from "@/shared/components/ui/Button";
import { formatDateTime, formatNumber } from "@/shared/utils/format";
import { WorkflowGraphRead } from "./WorkflowGraphRead";
import { WorkflowFlow } from "./WorkflowFlow";
import { flowDisplay } from "./workflow-flow";

export function WorkflowVersionHistory({
  versions,
  prefixes,
}: {
  versions: readonly WorkflowVersion[];
  prefixes: readonly string[];
}) {
  const [selected, setSelected] = useState<WorkflowVersion>();
  const trigger = useRef<HTMLButtonElement | null>(null),
    heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    if (selected) heading.current?.focus();
  }, [selected]);
  return (
    <>
      <p>게시 시점에 저장한 정의입니다. 실제 실행은 현재 저장된 정의를 사용합니다.</p>
      <div className="data-table-scroll" tabIndex={0} aria-label="워크플로 버전 표 영역">
        <table className="data-table">
          <caption className="sr-only">워크플로 게시 버전 이력</caption>
          <thead>
            <tr>
              <th scope="col">버전</th>
              <th scope="col">게시자</th>
              <th scope="col">게시일</th>
              <th scope="col">단계</th>
              <th scope="col">메모</th>
              <th scope="col">정의</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((version, index) => (
              <tr key={version.id ?? String(index)}>
                <td className="cell-number">v{formatNumber(version.version)}</td>
                <td>{flowDisplay(version.published_by, prefixes)}</td>
                <td>{formatDateTime(version.published_at)}</td>
                <td className="cell-number">{formatNumber(version.steps?.length ?? 0)}</td>
                <td>{flowDisplay(version.note, prefixes)}</td>
                <td>
                  <Button
                    size="small"
                    aria-expanded={selected === version}
                    onClick={(event) => {
                      trigger.current = event.currentTarget;
                      setSelected(version);
                    }}
                  >
                    버전 {formatNumber(version.version)} 정의 보기
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {selected ? (
        <section aria-label="선택한 게시 정의">
          <h4 tabIndex={-1} ref={heading}>
            버전 {formatNumber(selected.version)} 정의
          </h4>
          <p>
            {flowDisplay(selected.name, prefixes)} · 허용 팀:{" "}
            {flowDisplay(selected.allowed_teams || "전체", prefixes)}
          </p>
          {selected.flow ? (
            <WorkflowGraphRead
              workflow={{
                ...selected,
                id: selected.workflow_id ?? selected.id ?? "snapshot",
                name: selected.name ?? "게시된 정의",
                description: selected.description ?? "",
                allowed_teams: selected.allowed_teams ?? "",
                enabled: false,
              }}
              prefixes={prefixes}
            />
          ) : (
            <WorkflowFlow steps={selected.steps ?? []} prefixes={prefixes} />
          )}
          <Button
            onClick={() => {
              setSelected(undefined);
              trigger.current?.focus();
            }}
          >
            정의 닫기
          </Button>
        </section>
      ) : null}
    </>
  );
}
