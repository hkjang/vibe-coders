import { FlaskConical, Wand2 } from "lucide-react";
import { useRef } from "react";
import type { PolicySuggestion } from "@/shared/api/domains/governance";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Sheet } from "@/shared/components/ui/Sheet";
import { GovernanceTable, PanelFailure, type GovernanceColumn } from "./governance-parts";
import { compactJson, severityLabel, severityTone } from "./governance-utils";
import { usePolicySimulationAccess, type PolicySimulationAccess } from "./policy-simulation-access";
import { simulationText, simulationWindows, type SimulationWindow } from "./policy-simulation-state";
import { PolicySimulationResult } from "./PolicySimulationResult";
import { usePolicySimulation } from "./use-policy-simulation";
import "./policy-simulation.css";

interface SimulationSectionProps {
  canWrite: boolean;
  window: SimulationWindow;
  rows: readonly PolicySuggestion[];
  pending: boolean;
  failed: boolean;
  error: unknown;
  hasData: boolean;
  refresh: () => void;
  changeWindow: (window: string) => void;
  applyDraft: (row: PolicySuggestion, trigger: HTMLButtonElement) => void;
  draftDisabled?: boolean;
  draftReason?: string;
  draftTriggerRef?: (id: string, node: HTMLButtonElement | null) => void;
}
export function PolicySimulationSection(props: SimulationSectionProps) {
  const access = usePolicySimulationAccess(props.canWrite);
  // Only the simulation lifetime is reset; parent draft/canary dialogs are not remounted.
  return <SimulationSession key={`${access.sessionKey}:${props.window}`} {...props} access={access} />;
}
function SimulationSession({
  access,
  ...props
}: SimulationSectionProps & { access: PolicySimulationAccess }) {
  const operation = usePolicySimulation(access, props.window);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const selected = useRef<string | undefined>(undefined);
  const panel = useRef<HTMLDivElement | null>(null);
  const text = (value: string | undefined) => simulationText(value, access.credentialPrefixes);
  const busy = operation.state.kind === "pending";
  // Resolve the current row node after table columns rerender, not the detached old button.
  const returnFocusRef = {
    get current() {
      const button = selected.current === undefined ? undefined : triggers.current.get(selected.current);
      return button?.isConnected && !button.disabled ? button : panel.current;
    },
  };
  const columns: ReadonlyArray<GovernanceColumn<PolicySuggestion>> = [
    {
      id: "severity",
      header: "심각도",
      cell: (row) => <Badge tone={severityTone(row.severity)}>{text(severityLabel(row.severity))}</Badge>,
    },
    {
      id: "title",
      header: "추천",
      cell: (row) => (
        <span>
          <strong>{text(row.title || row.id)}</strong>
          <br />
          {row.rationale ? text(row.rationale) : null}
        </span>
      ),
    },
    {
      id: "rule",
      header: "규칙",
      cell: (row) => (
        <span className="mono">
          if {text(compactJson(row.conditions))} → {text(compactJson(row.actions))}
        </span>
      ),
    },
    {
      id: "actions",
      header: "동작",
      cell: (row) => (
        <span className="governance-actions">
          <Button
            size="small"
            disabled={!access.allowed || busy}
            title={access.reason}
            ref={(node) => {
              if (node) triggers.current.set(row.id, node);
              else triggers.current.delete(row.id);
            }}
            aria-label={`${text(row.title ?? row.id)} 섀도우 영향 확인`}
            onClick={() => {
              selected.current = row.id;
              void operation.run(row);
            }}
          >
            <FlaskConical aria-hidden="true" /> {busy ? "계산 중" : "섀도우 영향"}
          </Button>
          <Button
            size="small"
            variant="primary"
            disabled={props.draftDisabled ?? !props.canWrite}
            title={props.draftReason}
            ref={(node) => props.draftTriggerRef?.(row.id, node)}
            aria-label={`${text(row.title ?? row.id)} 초안 생성`}
            onClick={(event) => props.applyDraft(row, event.currentTarget)}
          >
            <Wand2 aria-hidden="true" /> 초안 생성
          </Button>
        </span>
      ),
    },
  ];
  return (
    <div ref={panel} tabIndex={-1} className="policy-simulation-card">
      <SectionCard
        title="정책 어드바이저"
        description="최근 신호를 근거로 추천한 정책 규칙입니다. 적용하면 비활성 draft 정책으로 생성됩니다."
        actions={
          <label className="toolbar">
            <span>분석 기간</span>
            <Select
              aria-label="정책 어드바이저 분석 기간"
              value={props.window}
              onChange={(event) => props.changeWindow(event.target.value)}
            >
              {Object.entries(simulationWindows).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </label>
        }
      >
        {props.failed ? (
          <PanelFailure
            error={props.error}
            hasData={props.hasData}
            label="정책 추천"
            onRetry={props.refresh}
          />
        ) : null}
        {busy ? (
          <InlineNotice title="정책 영향을 계산하고 있습니다.">
            {operation.state.kind === "pending"
              ? `${text(operation.state.snapshot.title)} · ${simulationWindows[operation.state.snapshot.window]}. `
              : null}
            정책을 저장하거나 적용하지 않습니다. 분석 기간이나 화면을 바꾸면 이 화면에 늦은 결과를 게시하지
            않습니다.
          </InlineNotice>
        ) : null}
        {operation.state.kind === "error" ? (
          <InlineNotice
            tone="danger"
            title="정책 영향을 계산하지 못했습니다."
            actions={
              <Button disabled={!access.allowed} onClick={() => void operation.retry()}>
                다시 시뮬레이션
              </Button>
            }
          >
            {text(operation.state.message)}{" "}
            {operation.state.requestId ? `요청 ID: ${text(operation.state.requestId)}` : null}
            <p>
              다시 시뮬레이션은 {text(operation.state.snapshot.title)}의 실행 당시 규칙,{" "}
              {simulationWindows[operation.state.snapshot.window]}을 사용합니다. 재조회 시 표본은 달라질 수
              있습니다.
            </p>
          </InlineNotice>
        ) : null}
        {!props.pending && !props.failed && props.rows.length === 0 ? (
          <EmptyState
            title="지금 추천할 정책이 없습니다."
            description="비용 급증, 비밀정보 탐지, MCP 도구 오류가 감지되면 근거와 함께 정책을 추천합니다."
          />
        ) : (
          <GovernanceTable
            caption="정책 추천 목록"
            columns={columns}
            rows={props.rows}
            loading={props.pending}
            error={props.failed && !props.hasData ? "추천을 불러오지 못했습니다." : undefined}
            onRetry={props.refresh}
          />
        )}
      </SectionCard>
      <Sheet
        open={operation.state.kind === "success"}
        onOpenChange={(open) => {
          if (!open) operation.close();
        }}
        returnFocusRef={returnFocusRef}
        title="섀도우 영향 분석"
        description="실행한 규칙으로 과거 기록의 잠재 영향을 계산합니다."
        size="wide"
      >
        {operation.state.kind === "success" ? (
          <PolicySimulationResult
            snapshot={operation.state.snapshot}
            result={operation.state.result}
            prefixes={access.credentialPrefixes}
          />
        ) : null}
      </Sheet>
    </div>
  );
}
