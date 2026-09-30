import { useRef, useState, type RefObject } from "react";
import { toast } from "sonner";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import type { RoutingRule } from "@/shared/api/domains/routing";
import { AppError, isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { useRoutingToggleOperation, type RoutingToggleAccess } from "./routing-toggle-access";
import type { RoutingToggleData } from "./routing-toggle-data";
import {
  assertToggleBaseline,
  sameRoutingRule,
  toggleIdentityReason,
  toggleListReason,
} from "./routing-toggle-state";
import "./routing-toggle.css";

export function RoutingToggleDialog({
  rule,
  intendedEnabled,
  access,
  data,
  onClose,
  returnFocusRef,
}: {
  rule: RoutingRule;
  intendedEnabled: boolean;
  access: RoutingToggleAccess;
  data: RoutingToggleData;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
}) {
  const [baseline, setBaseline] = useState(() => ({ ...rule }));
  const approval = useRef(baseline);
  const operation = useRoutingToggleOperation(access);
  const current = data.query.data?.rules.find((candidate) => candidate.id === rule.id);
  const alreadyApplied = current?.enabled === intendedEnabled;
  const reason =
    access.write.reason ??
    toggleIdentityReason(rule.id) ??
    (!data.confirmed ? toggleListReason : undefined) ??
    (!current ? "선택한 규칙이 현재 목록에 없습니다. 원래 대상은 변경하지 않습니다." : undefined) ??
    (alreadyApplied
      ? `현재 이미 ${intendedEnabled ? "사용 중" : "중지된 상태"}입니다. 반대 작업은 창을 닫고 다시 선택하세요.`
      : undefined) ??
    (!sameRoutingRule(current, baseline)
      ? "선택한 규칙이 변경되었습니다. 목록과 최신 기준을 다시 확인하세요."
      : undefined);
  const display = (value: string, empty = "없음") =>
    containsPotentialSecret(value, access.credentialPrefixes)
      ? "민감정보가 포함될 수 있어 표시하지 않습니다."
      : value || empty;
  return (
    <ConfirmDialog
      open
      title={`라우팅 규칙 ${intendedEnabled ? "사용" : "중지"}`}
      description="선택한 원본 규칙의 사용 상태만 변경합니다. 대상과 변경 전후 상태를 확인하세요."
      confirmLabel={intendedEnabled ? "사용" : "중지"}
      tone={intendedEnabled ? "primary" : "danger"}
      confirmDisabled={operation.pending || !!reason}
      returnFocusRef={returnFocusRef}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onConfirm={async () => {
        await operation.run(
          async (assert, signal) => {
            if (approval.current !== baseline)
              throw new AppError("이전 확인 기준은 폐기되었습니다. 최신 기준에서 다시 확인하세요.", {
                kind: "contract",
              });
            assertToggleBaseline(data.assertConfirmed(), baseline, intendedEnabled);
            const endpoint = withPathParams(endpoints.domains.routing.rules.update, { id: rule.id });
            const body = { enabled: intendedEnabled };
            assert();
            return apiClient.request(endpoint, { body, signal, routeId: "routing.rules" });
          },
          () => {
            toast.success(intendedEnabled ? "규칙을 다시 사용합니다." : "규칙 사용을 중지했습니다.");
            data.afterCommit();
          },
        );
      }}
    >
      <dl className="routing-toggle-review">
        <dt>원본 규칙 ID</dt>
        <dd>{display(rule.id)}</dd>
        <dt>변경 전 상태</dt>
        <dd>{baseline.enabled ? "사용 중" : "중지됨"}</dd>
        <dt>변경 후 상태</dt>
        <dd>{intendedEnabled ? "사용 중" : "중지됨"}</dd>
        <dt>모델 패턴</dt>
        <dd>{display(baseline.match_pattern, "전체 (*)")}</dd>
        <dt>대상 모델</dt>
        <dd>{display(baseline.target_model)}</dd>
        <dt>대상 공급자</dt>
        <dd>{display(baseline.target_provider, "자동 선택")}</dd>
        <dt>메모</dt>
        <dd>{display(baseline.note)}</dd>
        <dt>우선순위</dt>
        <dd>{baseline.priority}</dd>
        <dt>복잡도 범위</dt>
        <dd>
          {baseline.min_complexity}–{baseline.max_complexity}
        </dd>
      </dl>
      <p>
        {intendedEnabled
          ? "라우팅 기능이 활성화된 환경에서 조건과 우선순위에 따라 이 규칙의 대상 모델을 선택할 수 있습니다."
          : "중지한 규칙은 갱신된 설정을 읽은 라우팅에서 제외됩니다. 다음 우선순위 규칙 또는 기본 라우팅이 적용될 수 있습니다."}
      </p>
      {reason ? (
        <InlineNotice tone="warning" title="규칙 상태 변경 잠김">
          {reason}
        </InlineNotice>
      ) : null}
      {data.query.isError ? (
        <InlineNotice tone="warning" title="규칙 목록 조회 실패">
          {safeAppErrorMessage(data.query.error, "목록을 다시 조회하세요.")}
          {isAppError(data.query.error) && data.query.error.requestId ? (
            <p>요청 ID: {data.query.error.requestId}</p>
          ) : null}
        </InlineNotice>
      ) : null}
      <div className="routing-toggle-review-actions">
        <Button
          disabled={operation.pending || data.query.isFetching || !access.readAllowed}
          onClick={() => void data.refresh().catch(() => undefined)}
        >
          목록 다시 조회
        </Button>
        <Button
          disabled={
            operation.pending ||
            !access.write.allowed ||
            !data.confirmed ||
            !current ||
            alreadyApplied ||
            !!toggleIdentityReason(rule.id)
          }
          onClick={() => {
            try {
              access.write.assertCurrent();
              const latest = data.assertConfirmed().find((candidate) => candidate.id === rule.id);
              if (!latest || latest.enabled === intendedEnabled) return;
              const next = { ...latest };
              approval.current = next;
              setBaseline(next);
            } catch {
              /* keep the original target and intent locked */
            }
          }}
        >
          최신 기준 다시 확인
        </Button>
      </div>
      <p>
        확인한 목록 기준으로 원본 ID와 사용 상태를 전송합니다. 서버의 동시 변경 차단이나 즉시 전체 인스턴스
        반영을 보장하지 않습니다.
      </p>
    </ConfirmDialog>
  );
}
