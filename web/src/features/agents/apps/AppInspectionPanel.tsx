import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { AppInspectionResults } from "./AppInspectionResults";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import { appRunPlanSchema, appValidationSchema, type WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import {
  assertFeatureRead,
  useFeatureReadOwner,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";

interface Props {
  app: WorkApp;
  disabled: boolean;
}

/** Results belong to one identity, selection AND definition, never just a reusable app ID. */
export function AppInspectionPanel(props: Props) {
  const owner = useFeatureReadOwner("agents.apps", "app-inspection", ["admin:write"]);
  return <Inspection key={JSON.stringify([owner.id, props.app])} {...props} owner={owner} />;
}

function Inspection({ app, disabled, owner }: Props & { owner: FeatureReadOwner }) {
  const auth = useAuth();
  const client = useQueryClient();
  const [denied, setDenied] = useState(false);
  const alive = useRef(false);
  const flight = useRef(false);
  const paused = useRef(disabled);
  useLayoutEffect(() => {
    paused.current = disabled;
  }, [disabled]);
  useLayoutEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const current = () => alive.current && owner.isCurrent();
  const canValidate = auth.user?.scopes.includes("admin:write") ?? false;
  // The plan endpoint records a run. Feature read-only mode must not dispatch it.
  const access = useFeatureMutationAccess(["agents.apps"], owner.readable);
  // Validation only resolves references (plus the server's audit event), like other simulations.
  const validateReason = canValidate ? undefined : "구성 요소 검증에는 admin:write 권한이 필요합니다.";
  const assertAction = (kind: "validate" | "plan") => {
    assertFeatureRead(owner);
    if (!alive.current || paused.current || denied || flight.current)
      throw new AppError("현재 앱과 진행 중인 작업을 확인하세요.", { kind: "aborted" });
    if (kind === "plan") access.assertCurrent();
    else if (validateReason) throw new AppError(validateReason, { kind: "permission" });
  };
  const verifyComponents = (rows: readonly { kind: string; ref: string }[]) => {
    const components = app.components ?? [];
    if (
      rows.length !== components.length ||
      rows.some((row, i) => row.kind !== components[i]?.kind || row.ref !== components[i]?.ref)
    )
      throw new AppError("앱 구성이 변경되었거나 응답이 일치하지 않습니다. 목록을 새로고침하세요.", {
        kind: "contract",
      });
  };
  const onError = (error: Error) => {
    if (current() && isAppError(error) && (error.status === 401 || error.status === 403)) setDenied(true);
  };
  const validate = useMutation({
    retry: false,
    mutationFn: async () => {
      assertAction("validate");
      flight.current = true;
      try {
        const response = await apiClient.request(
          withPathParams(endpoints.domains.agents.apps.validate, { id: app.id }),
          { routeId: "agents.apps", retryUnauthorized: false },
        );
        if (!current()) throw new AppError("조회 대상이 변경되었습니다.", { kind: "aborted" });
        const parsed = appValidationSchema.safeParse(response);
        if (!parsed.success) throw new AppError("검증 응답 형식을 확인할 수 없습니다.", { kind: "contract" });
        verifyComponents(parsed.data.checks);
        if (parsed.data.ok !== parsed.data.checks.every((check) => check.resolved))
          throw new AppError("검증 요약과 구성 요소 결과가 일치하지 않습니다.", { kind: "contract" });
        return parsed.data;
      } finally {
        flight.current = false;
      }
    },
    onError,
  });
  const plan = useMutation({
    retry: false,
    mutationFn: async () => {
      assertAction("plan");
      flight.current = true;
      try {
        const response = await apiClient.request(
          withPathParams(endpoints.domains.agents.apps.run, { id: app.id }),
          { routeId: "agents.apps", retryUnauthorized: false },
        );
        if (!current()) throw new AppError("조회 대상이 변경되었습니다.", { kind: "aborted" });
        const parsed = appRunPlanSchema.safeParse(response);
        if (!parsed.success || parsed.data.app_id !== app.id)
          throw new AppError("실행 계획의 대상 또는 응답 형식을 확인할 수 없습니다.", { kind: "contract" });
        verifyComponents(parsed.data.plan);
        return parsed.data;
      } finally {
        flight.current = false;
      }
    },
    onError,
    onSuccess: () => {
      if (current()) void client.invalidateQueries({ queryKey: ["agents", "apps", "runs"] });
    },
  });
  const busy = validate.isPending || plan.isPending;
  const unavailable = disabled || busy || !owner.readable || denied;
  return (
    <SectionCard title="구성 검증과 실행 계획" headingLevel={3}>
      <p>
        검증은 구성 요소의 참조를 확인합니다. 실행 계획 생성은 이력 기록을 요청하지만 모델·도구·리포트를
        실제로 실행하지 않습니다. 이력 저장 여부는 실행 이력에서, 실제 실행 권한과 비용은 각 실행 시 다시
        확인해야 합니다.
      </p>
      <div className="agents-detail-actions">
        <Button
          onClick={() => validate.mutate()}
          disabled={unavailable || !canValidate}
          title={validateReason}
        >
          검증
        </Button>
        <Button onClick={() => plan.mutate()} disabled={unavailable || !access.allowed} title={access.reason}>
          실행 계획 생성
        </Button>
      </div>
      {!owner.readable || denied ? (
        <InlineNotice tone="warning" title="접근 권한을 다시 확인하세요.">
          검증 결과를 숨겼습니다. 인증·권한을 확인한 뒤 상세 화면을 다시 여세요.
        </InlineNotice>
      ) : (
        <>
          {!access.allowed ? <InlineNotice tone="info">{access.reason}</InlineNotice> : null}
          {validateReason ? <InlineNotice tone="info">{validateReason}</InlineNotice> : null}
          {busy ? (
            <p role="status">
              {validate.isPending ? "구성 요소 검증 중입니다." : "실행 계획 생성 중입니다."}
            </p>
          ) : null}
          {validate.error ? (
            <InlineNotice tone="danger" title="검증에 실패했습니다.">
              {safeAppErrorMessage(validate.error, "검증을 완료하지 못했습니다.")}
              {isAppError(validate.error) && validate.error.requestId
                ? ` 요청 ID: ${validate.error.requestId}`
                : ""}
            </InlineNotice>
          ) : null}
          {plan.error ? (
            <InlineNotice tone="danger" title="실행 계획을 확인하지 못했습니다.">
              {safeAppErrorMessage(plan.error, "실행 계획을 확인하지 못했습니다.")} 이력 기록 여부는 실행
              이력에서 확인하세요. 다시 생성하면 새 이력이 추가될 수 있습니다.
              {isAppError(plan.error) && plan.error.requestId ? ` 요청 ID: ${plan.error.requestId}` : ""}
            </InlineNotice>
          ) : null}
          <AppInspectionResults validation={validate.data} plan={plan.data} />
        </>
      )}
    </SectionCard>
  );
}
