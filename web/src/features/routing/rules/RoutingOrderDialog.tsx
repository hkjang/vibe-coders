import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { apiClient } from "@/shared/api/client";
import { routingOrderEndpoints, type OrderSnapshot } from "@/shared/api/domains/routing-order";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { Checkbox } from "@/shared/components/ui/Checkbox";
import { Dialog } from "@/shared/components/ui/Dialog";
import { Input } from "@/shared/components/ui/Input";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FormField } from "@/shared/components/form/FormField";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import type { RoutingOrderAccess } from "./routing-order-access";
import { orderDisplay, orderText, orderUsable } from "./routing-order-state";
import { useRoutingOrderEditor } from "./use-routing-order-editor";
import { RoutingOrderList } from "./RoutingOrderList";
import "./routing-order.css";

export interface RoutingOrderDialogProps {
  access: RoutingOrderAccess;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}

export function RoutingOrderDialog(props: RoutingOrderDialogProps) {
  return (
    <UnsavedChangesProvider>
      <OrderLoader {...props} />
    </UnsavedChangesProvider>
  );
}
function OrderLoader(props: RoutingOrderDialogProps) {
  const [instance] = useState(() => crypto.randomUUID());
  const query = useQuery({
    queryKey: ["routing-order-review", props.access.key, instance],
    queryFn: async ({ signal }) => {
      props.access.assertRead();
      const result = await apiClient.request(routingOrderEndpoints.snapshot, {
        query: { view: "order" },
        signal,
        routeId: "routing.rules",
      });
      props.access.assertRead();
      return result;
    },
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  if (query.isSuccess) return <OrderEditor {...props} snapshot={query.data} />;
  return (
    <Dialog
      open
      wide
      scrollBody
      title={orderText.title}
      description={orderText.description}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {query.isError ? (
        <InlineNotice tone="danger" title="규칙 순서를 불러오지 못했습니다.">
          {safeAppErrorMessage(query.error, "현재 규칙을 확인하지 못했습니다. 연결과 권한을 확인하세요.")}
          <Button onClick={() => void query.refetch()}>다시 조회</Button>
        </InlineNotice>
      ) : (
        <p role="status">전체 규칙 순서를 불러오고 있습니다…</p>
      )}
    </Dialog>
  );
}
function OrderEditor({ snapshot, ...props }: RoutingOrderDialogProps & { snapshot: OrderSnapshot }) {
  const { access } = props;
  const editor = useRoutingOrderEditor(snapshot, access, props.onClose);
  const modelRef = useRef<HTMLInputElement>(null);
  const complexityRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (editor.problem?.field === "model") modelRef.current?.focus();
    if (editor.problem?.field === "complexity") complexityRef.current?.focus();
    if (editor.problem?.field === "reason") reasonRef.current?.focus();
  }, [editor.problem]);
  const unusable = !orderUsable(snapshot, access.prefixes);
  const locked = editor.pending || editor.locked || unusable;
  const error =
    isAppError(editor.error) && editor.error.code === "routing_order_conflict"
      ? orderText.stale
      : safeAppErrorMessage(editor.error, "요청을 확인하지 못했습니다. 현재 설정과 권한을 확인하세요.");
  const requestId = isAppError(editor.error) ? editor.error.requestId : undefined;
  const safeRequestId =
    requestId &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(requestId) &&
    !containsPotentialSecret(requestId, access.prefixes)
      ? requestId
      : undefined;
  return (
    <Dialog
      open
      wide
      scrollBody
      title={orderText.title}
      description={orderText.description}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) editor.close();
      }}
      footer={
        <>
          <Button disabled={editor.pending} onClick={() => editor.close()}>
            닫기
          </Button>
          <Button
            variant="primary"
            disabled={
              locked ||
              !editor.comparison ||
              !editor.confirmed ||
              !editor.changed ||
              !editor.draft.reason.trim()
            }
            onClick={editor.save}
          >
            {editor.phase === "save" ? "저장 중…" : "검토한 순서 저장"}
          </Button>
        </>
      }
    >
      <div className="routing-order-editor">
        <p role="status" className="sr-only">
          {editor.announcement}
        </p>
        {access.reason ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
        {unusable ? (
          <InlineNotice tone="warning">
            {snapshot.rules.length < 2
              ? orderText.unavailable
              : "표시 보호 기준으로 순서 변경을 지원하지 않는 규칙이 있습니다. 기존 규칙 편집을 사용하세요."}
          </InlineNotice>
        ) : null}
        <InlineNotice>{orderText.impact}</InlineNotice>
        {snapshot.ambiguous_ties ? <InlineNotice tone="warning">{orderText.ambiguous}</InlineNotice> : null}
        {editor.saved ? (
          <InlineNotice tone="success">{orderText.saved}</InlineNotice>
        ) : editor.sent &&
          !editor.pending &&
          !(isAppError(editor.error) && editor.error.code === "routing_order_conflict") ? (
          <InlineNotice tone="warning">{orderText.unknown}</InlineNotice>
        ) : null}
        {editor.phase === "save" ? <p role="status">순서와 감사 기록을 저장 중입니다…</p> : null}
        {editor.error ? (
          <InlineNotice tone="danger" title="작업을 완료하지 못했습니다.">
            {error}
            {safeRequestId ? <p>요청 ID: {safeRequestId}</p> : null}
          </InlineNotice>
        ) : null}
        <RoutingOrderList
          snapshot={snapshot}
          ids={editor.draft.ids}
          prefixes={access.prefixes}
          disabled={locked}
          move={editor.move}
        />
        <FormField
          label="변경 사유"
          error={editor.problem?.field === "reason" ? editor.problem.message : undefined}
          required
          description="감사 이력에 저장합니다. 비밀정보와 개인정보를 제외하고 500자 이내로 입력하세요."
        >
          {(control) => (
            <Input
              {...control}
              value={editor.draft.reason}
              ref={reasonRef}
              disabled={locked}
              onChange={(event) => editor.updateField("reason", event.target.value)}
            />
          )}
        </FormField>
        <section className="routing-order-preview" aria-label="적용 전후 비교">
          <h3>적용 전후 비교</h3>
          <p>{orderText.scope}</p>
          <div className="routing-order-fields">
            <FormField
              label="검증할 모델명"
              required
              error={editor.problem?.field === "model" ? editor.problem.message : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  value={editor.draft.model}
                  ref={modelRef}
                  disabled={locked}
                  onChange={(event) => editor.updateField("model", event.target.value)}
                />
              )}
            </FormField>
            <FormField
              label="요청 복잡도"
              required
              description="0~100의 정수"
              error={editor.problem?.field === "complexity" ? editor.problem.message : undefined}
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  value={editor.draft.complexity}
                  ref={complexityRef}
                  disabled={locked}
                  onChange={(event) => editor.updateField("complexity", event.target.value)}
                />
              )}
            </FormField>
            <Button disabled={locked} onClick={editor.preview}>
              {editor.phase === "preview" ? "비교 중…" : "순서 변경 비교"}
            </Button>
          </div>
          {editor.comparison ? (
            <div className="routing-order-comparison">
              {(["before", "after"] as const).map((side) => {
                const result = editor.comparison?.[side];
                if (!result) return null;
                return (
                  <section key={side} aria-label={side === "before" ? "변경 전 선택" : "변경 후 선택"}>
                    <h4>{side === "before" ? "변경 전" : "변경 후"}</h4>
                    <dl>
                      <dt>적용 규칙</dt>
                      <dd>{orderDisplay(result.matched_rule_id, access.prefixes)}</dd>
                      <dt>선택 모델</dt>
                      <dd>{orderDisplay(result.target_model, access.prefixes)}</dd>
                      <dt>공급자 지정</dt>
                      <dd>{orderDisplay(result.target_provider, access.prefixes)}</dd>
                      <dt>모델 변경</dt>
                      <dd>{result.applied ? "변경됨" : "유지됨"}</dd>
                    </dl>
                  </section>
                );
              })}
            </div>
          ) : null}
          <Checkbox
            label={orderText.confirm}
            checked={editor.confirmed}
            disabled={locked || !editor.comparison}
            onChange={(event) => editor.setConfirmation(event.target.checked)}
          />
        </section>
      </div>
    </Dialog>
  );
}
