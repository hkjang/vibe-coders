import { useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { decisionLabel, riskLabel } from "@/features/mcp/mcp-utils";
import { QueryNotice } from "@/features/mcp/mcp-ui";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { KeyValueList } from "@/shared/components/ui/KeyValueList";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { Select } from "@/shared/components/ui/Select";
import { Textarea } from "@/shared/components/ui/Textarea";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { formatNumber } from "@/shared/utils/format";
import {
  callCommand,
  callable,
  callMethods,
  callReason,
  emptyCall,
  CallDraftError,
  type CallDraft,
} from "./mcp-call-review";
import { useMcpCall } from "./use-mcp-call";

export function McpCallConsole({
  owner,
  canWrite,
  initial = emptyCall,
}: {
  owner: FeatureReadOwner;
  canWrite: boolean;
  initial?: CallDraft;
}) {
  const auth = useAuth();
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState("");
  const [errorField, setErrorField] = useState<keyof CallDraft>();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const operation = useMcpCall(owner, canWrite);
  const { review, explain, run } = operation;
  const pending = explain.isPending || run.isPending;
  const argsEnabled = draft.method === "tools/call" || draft.method === "prompts/get";
  const edit = (key: keyof CallDraft, value: string) => {
    operation.reset();
    setError("");
    setErrorField(undefined);
    setOpen(false);
    setDraft((previous) => ({ ...previous, [key]: value }));
  };
  const inspect = () => {
    try {
      const command = callCommand(draft, auth.credentialPrefixes);
      setError("");
      setErrorField(undefined);
      operation.inspect(command);
    } catch (cause) {
      operation.reset();
      setError(cause instanceof Error ? cause.message : "입력을 확인하세요.");
      const field = cause instanceof CallDraftError ? cause.field : "name";
      setErrorField(field);
      formRef.current
        ?.querySelector<HTMLElement>(field === "arguments" ? "#mcp-call-arguments" : `#mcp-explain-${field}`)
        ?.focus();
    }
  };
  const allowed =
    operation.lockSupported &&
    operation.access.allowed &&
    Boolean(review && callable(review.explanation)) &&
    !operation.conflict &&
    !operation.attempted &&
    !pending;
  const safePreview =
    run.data?.response_preview &&
    !containsPotentialSecret(run.data.response_preview, auth.credentialPrefixes);
  return (
    <SectionCard
      title="경로 확인·호출 테스트"
      description="경로 확인과 실제 외부 호출은 별도 단계입니다. 입력과 결과는 주소나 브라우저 저장소에 보관하지 않습니다."
    >
      <p>
        경로 확인에도 서버의 MCP 관리 권한이 필요합니다. 읽기 전용 미리보기에서는 경로 확인만 가능하고 실제
        호출은 실행하지 않습니다.
      </p>
      {!operation.lockSupported ? (
        <InlineNotice tone="warning">
          탭 간 호출 잠금을 사용할 수 없어 실제 호출을 중지했습니다. HTTPS와 지원 브라우저를 확인하세요. 경로
          확인은 계속 사용할 수 있습니다.
        </InlineNotice>
      ) : null}
      <form
        ref={formRef}
        className="mcp-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!pending && operation.canExplain) inspect();
        }}
      >
        <label htmlFor="mcp-explain-method">
          메서드
          <Select
            id="mcp-explain-method"
            aria-invalid={errorField === "method"}
            aria-describedby={errorField === "method" ? "mcp-call-error" : undefined}
            options={callMethods}
            value={draft.method}
            disabled={run.isPending}
            onChange={(event) => edit("method", event.target.value)}
          />
        </label>
        {draft.method === "resources/read" ? (
          <label htmlFor="mcp-explain-uri">
            리소스 URI
            <Input
              id="mcp-explain-uri"
              aria-invalid={errorField === "uri"}
              aria-describedby={errorField === "uri" ? "mcp-call-error" : undefined}
              value={draft.uri}
              disabled={run.isPending}
              onChange={(event) => edit("uri", event.target.value)}
            />
          </label>
        ) : (
          <label htmlFor="mcp-explain-name">
            노출 이름
            <Input
              id="mcp-explain-name"
              aria-invalid={errorField === "name"}
              aria-describedby={errorField === "name" ? "mcp-call-error" : undefined}
              value={draft.name}
              disabled={run.isPending}
              onChange={(event) => edit("name", event.target.value)}
              placeholder="예: docs__search"
            />
          </label>
        )}
        {argsEnabled ? (
          <div>
            <label htmlFor="mcp-call-arguments">JSON 인수</label>
            <Textarea
              id="mcp-call-arguments"
              aria-invalid={errorField === "arguments"}
              value={draft.arguments}
              disabled={run.isPending}
              onChange={(event) => edit("arguments", event.target.value)}
              rows={4}
              spellCheck={false}
              aria-describedby={
                errorField === "arguments"
                  ? "mcp-call-arguments-help mcp-call-error"
                  : "mcp-call-arguments-help"
              }
            />
            <span id="mcp-call-arguments-help">16KB 이하의 JSON 객체. 비밀정보는 입력하지 마세요.</span>
          </div>
        ) : null}
        <Button type="submit" variant="primary" disabled={pending || !operation.canExplain}>
          {explain.isPending ? "확인 중" : "적용 경로 확인"}
        </Button>
      </form>
      {error ? (
        <p id="mcp-call-error" className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {explain.isError ? (
        <QueryNotice
          error={explain.error}
          hasData={false}
          label="적용 경로"
          onRetry={() => {
            if (!pending && operation.canExplain) inspect();
          }}
        />
      ) : null}
      {review ? (
        <>
          <KeyValueList
            items={[
              { label: "확인한 메서드", value: review.command.input.method, mono: true },
              {
                label: "확인한 대상",
                value: review.command.input.name || review.command.input.uri,
                mono: true,
              },
              { label: "경로 확인", value: review.explanation.route.found ? "찾음" : "없음" },
              { label: "업스트림", value: review.explanation.route.upstream_name || "—" },
              { label: "선택 경로의 메서드", value: review.explanation.route.target_method || "—" },
              { label: "대상 이름", value: review.explanation.route.target_name || "—" },
              { label: "서버 정책", value: decisionLabel(review.explanation.policy?.server_policy ?? "") },
              { label: "도구 위험도", value: riskLabel(review.explanation.policy?.tool_risk_level ?? "") },
              { label: "현재 정책 판단", value: decisionLabel(review.explanation.final.decision) },
              {
                label: "판단 근거",
                value: callReason(review.explanation.final.reason, auth.credentialPrefixes),
              },
            ]}
          />
          {!callable(review.explanation) ? (
            <InlineNotice tone="warning" title="이 경로는 신규 콘솔에서 테스트할 수 없습니다.">
              경로 없음·차단·승인 필요·알 수 없는 판단에서는 실행하지 않습니다. 정책과 승인 상태를 먼저
              확인하세요.
            </InlineNotice>
          ) : null}
        </>
      ) : (
        <p>입력 후 적용 경로를 확인하세요. 입력을 바꾸면 이전 결과와 실행 검토가 초기화됩니다.</p>
      )}
      {operation.conflict ? (
        <InlineNotice tone="warning" title="경로나 정책이 변경되었습니다.">
          검토창을 닫고 적용 경로를 다시 확인하세요. 실제 호출은 보내지 않았습니다.
        </InlineNotice>
      ) : null}
      {operation.attempted ? (
        <InlineNotice tone="warning" title="테스트 호출을 전송했습니다.">
          응답 실패나 시간 초과여도 외부 작업이 실행되었을 수 있습니다. 외부 상태를 확인한 뒤 새로 경로를
          검토하세요. 자동 재호출은 하지 않습니다.
        </InlineNotice>
      ) : null}
      <Button ref={trigger} disabled={!allowed} title={operation.access.reason} onClick={() => setOpen(true)}>
        테스트 호출 검토
      </Button>
      {run.data ? (
        <InlineNotice
          tone={run.data.ok ? "success" : "danger"}
          title={run.data.ok ? "호출 성공" : "호출 실패"}
        >
          <p>
            {run.data.upstream_name || run.data.upstream_id} · {run.data.method} ·{" "}
            {formatNumber(run.data.latency_ms)}ms
          </p>
          {!run.data.ok ? (
            <p>업스트림 호출에 실패했습니다. 외부 작업의 완료 여부는 별도로 확인하세요.</p>
          ) : null}
          {run.data.response_preview ? (
            safePreview ? (
              <details>
                <summary>응답 미리보기 열기</summary>
                <p>응답에는 업무 데이터가 포함될 수 있습니다. 외부에 공유하지 마세요.</p>
                <pre className="mcp-call-preview" tabIndex={0}>
                  {run.data.response_preview}
                </pre>
              </details>
            ) : (
              <p>인증정보로 보이는 내용이 있어 응답 미리보기를 숨겼습니다.</p>
            )
          ) : null}
        </InlineNotice>
      ) : null}
      {review ? (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title="실제 MCP 호출 검토"
          description="외부 시스템을 호출합니다. 도구에 따라 데이터 변경·비용이 발생하며 되돌릴 수 없을 수 있습니다."
          requireTarget="실제 호출"
          confirmLabel="검토한 호출 실행"
          confirmDisabled={!allowed}
          returnFocusRef={trigger}
          tone="danger"
          onConfirm={() => run.mutateAsync(review)}
        >
          <KeyValueList
            items={[
              { label: "실제 전송 메서드", value: review.command.input.method },
              { label: "대상", value: review.command.input.name || review.command.input.uri },
              { label: "검토한 업스트림", value: review.explanation.route.upstream_name || "—" },
              { label: "현재 판단", value: decisionLabel(review.explanation.final.decision) },
            ]}
          />
          {argsEnabled ? (
            <details>
              <summary>전송할 JSON 인수 확인</summary>
              <pre className="mcp-call-preview" tabIndex={0}>
                {JSON.stringify(review.command.arguments, null, 2)}
              </pre>
            </details>
          ) : (
            <p>이 메서드는 인수를 보내지 않습니다.</p>
          )}
          <p>
            같은 브라우저·주소의 다른 탭에서 호출 중이면 전송하지 않습니다. 다른 브라우저·기기, 탭 종료 이후의
            외부 실행이나 응답 유실 후 재호출까지 막는 서버 멱등성은 아닙니다.
          </p>
          <p>
            실행 직전에 경로와 정책을 다시 비교합니다. 서버의 동시 변경 잠금이나 승인 절차를 대신하지
            않습니다. 기존 관리자 테스트 API는 일반 게이트웨이의 정책 집행·비용 상한·작업별 감사 기록을
            보장하지 않습니다.
          </p>
          {operation.conflict ? (
            <p role="alert">경로 또는 정책 변경으로 실행하지 않았습니다. 창을 닫고 다시 검토하세요.</p>
          ) : null}
          {operation.attempted && run.isError ? (
            <p role="alert">이미 호출을 전송했습니다. 외부 상태를 확인하기 전에는 재실행하지 마세요.</p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </SectionCard>
  );
}
