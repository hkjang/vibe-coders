import { useLayoutEffect, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import {
  routingDraftEndpoints,
  type DraftComparison,
  type DraftWriteProof,
} from "@/shared/api/domains/routing-draft";
import { routingOrderEndpoints } from "@/shared/api/domains/routing-order";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError, isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Input } from "@/shared/components/ui/Input";
import { Textarea } from "@/shared/components/ui/Textarea";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import type { RoutingEditAccess } from "./routing-rule-edit-access";
import type { RuleReview } from "./routing-rule-edit-operation";
import { assertRuleBaseline, ruleText } from "./routing-rule-edit-state";

const reasonLabel: Readonly<Record<string, string>> = {
  client_model: "요청한 모델 유지",
  auto_router: "자동 모델 선택",
  auto_router_learned: "학습 결과로 자동 선택",
  complexity_rule: "복잡도 규칙 적용",
};
function fallbackLabel(value: string) {
  if (value === "no_provider_failover:single_matching_provider") return "대체할 공급자 없음";
  if (value === "fallback_disabled:sensitive_data") return "민감정보 위험으로 대체 호출 금지";
  if (value.startsWith("context_overflow:")) return `문맥 한도 초과 시 ${value.slice(17)}`;
  if (value.startsWith("429|5xx|timeout:")) return `과부하·오류·시간 초과 시 ${value.slice(16)}`;
  return value;
}

export function RoutingDraftComparison({
  baseline,
  review,
  access,
  disabled,
  onProof,
}: {
  baseline: RoutingRule;
  review: RuleReview;
  access: RoutingEditAccess;
  disabled: boolean;
  onProof: (proof: DraftWriteProof | undefined) => void;
}) {
  const [input, setInput] = useState({ model: "", prompt: "", keyId: "", reason: "" });
  const [result, setResult] = useState<DraftComparison>();
  const [error, setError] = useState<unknown>();
  const [validation, setValidation] = useState<{ field: keyof typeof input; message: string }>();
  const [pending, setPending] = useState(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const active = useRef(false);
  const publish = useRef(onProof);
  const resultHeading = useRef<HTMLHeadingElement>(null);
  const modelInput = useRef<HTMLInputElement>(null);
  const promptInput = useRef<HTMLTextAreaElement>(null);
  const reasonInput = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    publish.current = onProof;
  });
  useLayoutEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      flight.current?.abort();
    };
  }, []);
  const change = (field: keyof typeof input, value: string) => {
    if (!active.current || disabled || pending) return;
    publish.current(undefined);
    setResult(undefined);
    setError(undefined);
    setValidation(undefined);
    setInput((current) => ({ ...current, [field]: value }));
  };
  const compare = async () => {
    if (!active.current || disabled || flight.current) return;
    publish.current(undefined);
    setResult(undefined);
    setError(undefined);
    setValidation(undefined);
    const controller = new AbortController();
    const assertCurrent = () => {
      access.assertApproval(review.approval);
      if (!active.current || controller.signal.aborted || flight.current !== controller)
        throw new AppError("종료된 초안 비교입니다.", { kind: "aborted" });
    };
    try {
      access.assertApproval(review.approval);
      for (const [field, label, ref] of [
        ["model", "시험 모델", modelInput],
        ["prompt", "예시 요청", promptInput],
        ["reason", "변경 사유", reasonInput],
      ] as const) {
        if (!input[field].trim()) {
          setValidation({ field, message: `${label} 항목을 입력하세요.` });
          ref.current?.focus();
          return;
        }
      }
      if (Array.from(input.reason.trim()).length > 500)
        throw new AppError("변경 사유는 500자 이하로 입력하세요.", { kind: "contract" });
      if (
        [input.model, input.keyId, input.reason].some((value) =>
          containsPotentialSecret(value, access.prefixes),
        )
      )
        throw new AppError("모델·키 식별자·변경 사유에 비밀정보를 넣지 마세요.", { kind: "contract" });
      flight.current = controller;
      setPending(true);
      const snapshot = await apiClient.request(routingOrderEndpoints.snapshot, {
        query: { view: "order" },
        signal: controller.signal,
        routeId: "routing.rules",
      });
      assertCurrent();
      assertRuleBaseline(snapshot.rules, baseline);
      if (snapshot.ambiguous_ties)
        throw new AppError("우선순위와 생성 시각이 같은 규칙의 순서를 먼저 정리하세요.", {
          kind: "contract",
        });
      const comparison = await apiClient.request(routingDraftEndpoints.preview, {
        body: {
          rule_edit: { id: baseline.id, expected_revision: snapshot.revision, patch: review.patch },
          request: {
            model: input.model.trim(),
            messages: [{ role: "user", content: input.prompt }],
            ...(input.keyId.trim() ? { api_key_id: input.keyId.trim() } : {}),
          },
        },
        signal: controller.signal,
        routeId: "routing.rules",
      });
      assertCurrent();
      if (comparison.revision !== snapshot.revision)
        throw new AppError("비교 응답의 검토 기준이 다릅니다. 다시 조회하세요.", { kind: "contract" });
      setResult(comparison);
      publish.current({ revision: comparison.revision, reason: input.reason.trim() });
    } catch (cause) {
      if (active.current && !controller.signal.aborted) setError(cause);
    } finally {
      if (flight.current === controller) {
        flight.current = undefined;
        if (active.current) setPending(false);
      }
    }
  };
  useLayoutEffect(() => {
    if (result) {
      resultHeading.current?.focus({ preventScroll: true });
      resultHeading.current?.scrollIntoView?.({ block: "start" });
    }
  }, [result]);
  const text = (value: string) => ruleText(value, access.prefixes);
  const rows: Array<readonly [string, string, string]> = result
    ? [
        ["선택 모델", result.before.selected_model, result.after.selected_model],
        [
          "선택 공급자",
          result.before.selected_provider || "선택 없음",
          result.after.selected_provider || "선택 없음",
        ],
        [
          "선택 이유",
          reasonLabel[result.before.route_reason] ?? result.before.route_reason,
          reasonLabel[result.after.route_reason] ?? result.after.route_reason,
        ],
        ["복잡도 점수", String(result.before.complexity.score), String(result.after.complexity.score)],
        ["위험 점수", String(result.before.risk.score), String(result.after.risk.score)],
        ["공급자 상태 점수", String(result.before.health_score), String(result.after.health_score)],
        [
          "대체 경로 계획",
          result.before.fallback_plan.map(fallbackLabel).join("\n"),
          result.after.fallback_plan.map(fallbackLabel).join("\n"),
        ],
      ]
    : [];
  return (
    <section className="routing-rule-edit-fields" aria-label="초안 실행 계획 비교">
      <h3>시험 요청으로 결과 비교</h3>
      <p>
        예시 요청 한 건의 모델·공급자·대체 경로 계획을 비교합니다. 실제 모델을 호출하지 않습니다. 도구 호출과
        공급자 고정 없이 텍스트 요청을 계산합니다.
      </p>
      <fieldset disabled={disabled || pending} className="routing-rule-edit-fields">
        <legend className="sr-only">초안 시험 요청</legend>
        <FormField
          label="시험 모델"
          required
          error={validation?.field === "model" ? validation.message : undefined}
          description="호출할 모델명 또는 vibe/auto를 입력하세요."
        >
          {(control) => (
            <Input
              {...control}
              ref={modelInput}
              value={input.model}
              maxLength={256}
              onChange={(event) => change("model", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="예시 요청"
          error={validation?.field === "prompt" ? validation.message : undefined}
          required
          description="입력은 이 창에서만 사용하며 주소나 브라우저 저장소에 보관하지 않습니다."
        >
          {(control) => (
            <Textarea
              {...control}
              ref={promptInput}
              value={input.prompt}
              rows={3}
              maxLength={16000}
              onChange={(event) => change("prompt", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="정책 적용 키 식별자"
          description="선택 항목입니다. 비밀키 대신 기존 키의 ID를 입력하세요."
        >
          {(control) => (
            <Input
              {...control}
              value={input.keyId}
              maxLength={512}
              autoComplete="off"
              onChange={(event) => change("keyId", event.target.value)}
            />
          )}
        </FormField>
        <FormField
          label="변경 사유"
          error={validation?.field === "reason" ? validation.message : undefined}
          required
          description="감사 기록에 남습니다. 개인정보와 비밀정보를 넣지 마세요."
        >
          {(control) => (
            <Textarea
              {...control}
              ref={reasonInput}
              value={input.reason}
              rows={2}
              maxLength={500}
              onChange={(event) => change("reason", event.target.value)}
            />
          )}
        </FormField>
      </fieldset>
      <div>
        <Button disabled={disabled || pending} onClick={() => void compare()}>
          초안 결과 비교
        </Button>
        {pending ? (
          <Button
            onClick={() => {
              flight.current?.abort();
              flight.current = undefined;
              setPending(false);
              publish.current(undefined);
            }}
          >
            비교 취소
          </Button>
        ) : null}
      </div>
      {pending ? <p role="status">현재 설정과 초안의 실행 계획을 확인하고 있습니다.</p> : null}
      {error ? (
        <InlineNotice tone="warning" title="초안 결과를 확인하지 못했습니다.">
          {safeAppErrorMessage(error, "현재 설정과 입력을 확인하고 다시 비교하세요.")}
          {isAppError(error) && error.requestId ? <p>요청 ID: {text(error.requestId)}</p> : null}
        </InlineNotice>
      ) : null}
      {result ? (
        <>
          <h4 tabIndex={-1} ref={resultHeading}>
            실행 계획 비교 결과
          </h4>
          <p>
            규칙은 같은 검토 기준으로 계산했습니다. 공급자 상태와 학습·공급자 설정은 순차 조회하므로 계산 중
            달라질 수 있습니다. 전체 사용자·팀의 영향이나 실제 호출 성공을 보장하지 않습니다.
          </p>
          <table>
            <caption className="sr-only">현재 저장값과 편집한 초안의 실행 계획</caption>
            <thead>
              <tr>
                <th scope="col">항목</th>
                <th scope="col">현재 설정</th>
                <th scope="col">편집한 초안</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([label, before, after]) => (
                <tr key={label}>
                  <th scope="row">{label}</th>
                  <td>{text(before)}</td>
                  <td>
                    {text(after)}
                    {before !== after ? " (변경)" : " (동일)"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            비교 시각:{" "}
            <time dateTime={result.observed_at}>{new Date(result.observed_at).toLocaleString("ko-KR")}</time>
          </p>
        </>
      ) : null}
    </section>
  );
}
