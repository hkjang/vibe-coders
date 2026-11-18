import { useId } from "react";
import { Button } from "@/shared/components/ui/Button";
import { Select } from "@/shared/components/ui/Select";
import type { GraphInput } from "@/shared/api/domains/workflow-graph.schemas";

export function WorkflowGraphControls({
  steps,
  selected,
  onChoose,
  scale,
  fit,
  zoomIn,
  zoomOut,
  fitAll,
  reveal,
}: {
  steps: GraphInput["steps"];
  selected: string;
  onChoose: (id: string) => void;
  scale: number;
  fit: boolean;
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
  reveal: () => void;
}) {
  const id = useId();
  return (
    <div className="workflow-graph-controls" role="group" aria-label="분기 그림 탐색">
      <label htmlFor={id}>그림에서 찾을 단계</label>
      <Select
        id={id}
        value={selected}
        disabled={!steps.length}
        onChange={(event) => onChoose(event.target.value)}
        options={steps.map((step, index) => ({
          value: step.id,
          label: `${index + 1}. ${step.name || step.id}`,
        }))}
      />
      <div className="workflow-graph-toolbar">
        <Button size="small" onClick={zoomOut} disabled={scale <= 0.25}>
          축소
        </Button>
        <output aria-label="그림 배율" aria-live="polite">
          {new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 1 }).format(scale * 100)}%
        </output>
        <Button size="small" onClick={zoomIn} disabled={scale >= 2}>
          확대
        </Button>
        <Button size="small" onClick={fitAll} aria-pressed={fit}>
          전체 보기
        </Button>
        <Button
          size="small"
          onClick={reveal}
          disabled={!selected}
          title="선택한 단계를 원래 크기로 표시합니다."
        >
          선택 단계 보기
        </Button>
      </div>
      <p className="workflow-graph-help">위·아래 화살표로 단계 이동 · Home/End 처음·마지막</p>
    </div>
  );
}
