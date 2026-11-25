import { FlaskConical } from "lucide-react";
import { useId, useState } from "react";

import type { DynamicRouteGraph, DynamicRouteSimulateResult } from "@/shared/api/domains/routing-dynamic";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Textarea } from "@/shared/components/ui/Textarea";
import { formatNumber } from "@/shared/utils/format";

import { DynamicRouteFlow } from "./DynamicRouteFlow";
import { elementTitle, outcomeLabel, pathHighlight } from "./dynamic-route-model";
import { dynamicRouteErrorMessage, rejectionValidation, simulateDynamicRoute } from "./use-dynamic-routes";

const identityFields = [
  { key: "team", label: "팀 이름 (identity.team)" },
  { key: "team_id", label: "팀 ID (identity.team_id)" },
  { key: "user_id", label: "사용자 ID (identity.user_id)" },
  { key: "role", label: "역할 (identity.role)" },
] as const;

/**
 * Walks the graph being edited for a sample request — no model is called and no
 * limit is spent. Marking models as failing and limits as spent shows the
 * fallbacks a real outage or budget would take.
 */
export function DynamicRouteSimulator({
  routeId,
  graph,
  dirty,
}: {
  routeId: string;
  graph: DynamicRouteGraph;
  dirty: boolean;
}): React.JSX.Element {
  const formId = useId();
  const [metadata, setMetadata] = useState('{\n  "plan": "free",\n  "user_id": "u-123"\n}');
  const [identity, setIdentity] = useState<Record<string, string>>({});
  const [stream, setStream] = useState(false);
  const [failing, setFailing] = useState<ReadonlySet<string>>(new Set());
  const [exceeded, setExceeded] = useState<ReadonlySet<string>>(new Set());
  const [result, setResult] = useState<DynamicRouteSimulateResult>();
  const [error, setError] = useState<string>();
  const [running, setRunning] = useState(false);

  let metadataError: string | undefined;
  let metadataValue: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = metadata.trim() === "" ? {} : JSON.parse(metadata);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      metadataError = "JSON 객체여야 합니다.";
    else metadataValue = parsed as Record<string, unknown>;
  } catch {
    metadataError = "JSON 형식이 아닙니다.";
  }
  const models = graph.elements.filter((element) => element.type === "model");
  const limits = graph.elements.filter((element) => element.type === "rate");
  const toggle = (set: ReadonlySet<string>, id: string): Set<string> => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const run = async (): Promise<void> => {
    if (!metadataValue) return;
    setRunning(true);
    setError(undefined);
    try {
      setResult(
        await simulateDynamicRoute({
          graph: { elements: graph.elements },
          route_id: routeId,
          metadata: metadataValue,
          identity: Object.fromEntries(Object.entries(identity).filter(([, value]) => value.trim() !== "")),
          stream,
          failing: [...failing],
          exceeded: [...exceeded],
          samples: 1000,
        }),
      );
    } catch (caught) {
      const validation = rejectionValidation(caught);
      setResult(undefined);
      setError(
        validation
          ? `경로에 오류가 ${validation.errors.length}개 있어 시뮬레이션할 수 없습니다. 흐름 편집 탭에서 먼저 고치세요.`
          : dynamicRouteErrorMessage(caught),
      );
    } finally {
      setRunning(false);
    }
  };

  const highlight = pathHighlight(result?.result.steps);
  const titleOf = (id: string): string => {
    const element = graph.elements.find((item) => item.id === id);
    return element ? elementTitle(element) : id;
  };

  return (
    <div className="dr-sim">
      <SectionCard
        title="샘플 요청"
        description={
          dirty ? "저장하지 않은 편집 내용으로 시뮬레이션합니다." : "현재 최신 버전으로 시뮬레이션합니다."
        }
      >
        <form
          id={formId}
          className="dr-sim-form"
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <FormField
            label="메타데이터 (X-Vibe-Metadata)"
            error={metadataError}
            description="요청 헤더에 실릴 JSON입니다. 조건·고정 분배·한도 키가 이 값을 읽습니다."
          >
            {(control) => (
              <Textarea
                {...control}
                className="dr-code"
                rows={6}
                spellCheck={false}
                value={metadata}
                onChange={(event) => setMetadata(event.target.value)}
              />
            )}
          </FormField>
          <div className="dr-form-grid">
            {identityFields.map((field) => (
              <FormField key={field.key} label={field.label}>
                {(control) => (
                  <Input
                    {...control}
                    value={identity[field.key] ?? ""}
                    onChange={(event) =>
                      setIdentity((current) => ({ ...current, [field.key]: event.target.value }))
                    }
                  />
                )}
              </FormField>
            ))}
          </div>
          <Checkbox
            checked={stream}
            onChange={(event) => setStream(event.target.checked)}
            label="스트리밍 요청 (request.stream = true)"
          />
          {models.length > 0 ? (
            <fieldset className="dr-sim-toggles">
              <legend>실패로 가정할 모델</legend>
              {models.map((element) => (
                <Checkbox
                  key={element.id}
                  checked={failing.has(element.id)}
                  onChange={() => setFailing((current) => toggle(current, element.id))}
                  label={`${elementTitle(element)} (${element.properties.model || "모델 미지정"})`}
                />
              ))}
            </fieldset>
          ) : null}
          {limits.length > 0 ? (
            <fieldset className="dr-sim-toggles">
              <legend>한도를 다 쓴 것으로 가정할 요소</legend>
              {limits.map((element) => (
                <Checkbox
                  key={element.id}
                  checked={exceeded.has(element.id)}
                  onChange={() => setExceeded((current) => toggle(current, element.id))}
                  label={elementTitle(element)}
                />
              ))}
            </fieldset>
          ) : null}
          <div className="dr-save-actions">
            <Button type="submit" variant="primary" disabled={running || metadataError !== undefined}>
              <FlaskConical aria-hidden="true" /> {running ? "시뮬레이션 중…" : "시뮬레이션 실행"}
            </Button>
          </div>
        </form>
        {error ? (
          <InlineNotice tone="danger" title="시뮬레이션하지 못했습니다.">
            {error}
          </InlineNotice>
        ) : null}
      </SectionCard>

      {result ? (
        <SectionCard title="결과" description="모델은 호출하지 않았고 한도도 쓰지 않았습니다.">
          <div className="dr-sim-result" role="status">
            <p className="dr-sim-final">
              {result.result.outcome === "success" ? (
                <>
                  <strong>{titleOf(result.result.final_element_id)}</strong> →{" "}
                  <code>{result.result.final_model}</code>
                  {result.result.provider ? (
                    <span className="dr-muted"> · {result.result.provider}</span>
                  ) : (
                    <span className="dr-muted"> · 공급자 자동</span>
                  )}
                </>
              ) : (
                <strong className="dr-validation-error">{outcomeLabel(result.result.outcome)}</strong>
              )}
              <span className="dr-muted">
                {" "}
                · 모델 시도 {result.result.attempts}회 · 폴백 {result.result.fallbacks}회
              </span>
            </p>
            {result.result.blocked_by ? (
              <p>
                한도 요소 <strong>{titleOf(result.result.blocked_by)}</strong>에서 거절되며 약{" "}
                {formatNumber(result.result.retry_after_seconds)}초 뒤 다시 시도할 수 있습니다(429).
              </p>
            ) : null}
            <ol className="dr-path" aria-label="지나간 경로">
              {result.result.steps.map((step, index) => (
                <li key={`${step.id}:${index}`} className={`dr-path-step dr-path-${step.outcome}`}>
                  <span className="dr-path-id">{titleOf(step.id)}</span>
                  <span className="dr-path-outcome">{outcomeLabel(step.outcome)}</span>
                </li>
              ))}
            </ol>
            <code className="dr-path-header">X-Dynamic-Route-Path: {result.result.path}</code>
          </div>
          <DynamicRouteFlow graph={graph} label="시뮬레이션 경로가 강조된 흐름" highlight={highlight} />
          {result.distribution.length > 0 ? (
            <div className="dr-dist">
              <h3>비율 분배 미리보기</h3>
              <p className="dr-hint">
                같은 입력을 {formatNumber(result.samples)}번 무작위로 흘려 본 결과입니다. 고정 분배 키는
                여기서 무시합니다.
              </p>
              <ul className="dr-dist-list">
                {result.distribution.map((row) => (
                  <li key={`${row.final_element_id}:${row.outcome}`}>
                    <span className="dr-dist-label">
                      {row.final_element_id ? titleOf(row.final_element_id) : outcomeLabel(row.outcome)}
                      {row.final_model ? <code>{row.final_model}</code> : null}
                      {row.outcome !== "success" ? (
                        <span className="dr-muted"> · {outcomeLabel(row.outcome)}</span>
                      ) : null}
                    </span>
                    <span className="dr-dist-bar" aria-hidden="true">
                      <span style={{ width: `${Math.round(row.share * 1000) / 10}%` }} />
                    </span>
                    <span className="dr-dist-value">{(row.share * 100).toFixed(1)}%</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </SectionCard>
      ) : null}
    </div>
  );
}
