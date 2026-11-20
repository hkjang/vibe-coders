import { useRef, useState } from "react";
import { legacyRoutes } from "@/config/legacy-route-map";
import { useAuth } from "@/app/auth/AuthProvider";
import { severityTone } from "@/features/access/access-format";
import type { MeAction } from "@/shared/api/domains/me-console.schemas";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { EmptyState } from "@/shared/components/ui/EmptyState";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { FeatureLegacyLink } from "@/shared/components/ui/FeatureLegacyLink";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { SectionCard } from "@/shared/components/ui/SectionCard";
import { useSearchState } from "@/shared/hooks/use-search-state";
import { useMeActionsQuery } from "./use-me-queries";
import { useMeSnooze } from "./me-console-actions";
import { meLabel, safeMeMessage } from "./me-console-model";
import { MeOperationNotice, MePartial, MeQueryContent } from "./me-console-ui";
import { meActionTitle } from "./me-action-labels";

export function MeActionsPanel() {
  const auth = useAuth();
  const actions = useMeActionsQuery();
  const [, update] = useSearchState();
  const [snoozing, setSnoozing] = useState<MeAction>();
  const trigger = useRef<HTMLElement>(null);
  const snooze = useMeSnooze();
  function actionTarget(type: string) {
    if (type === "key_expiry") return { tab: "keys" };
    if (type === "failure_increase") return { tab: "requests", request_status: "error" };
    if (type === "unreviewed_recommendations") return { tab: "skills" };
    if (type === "model_switch" || type === "mcp_recommend") return { tab: "requests" };
    return undefined;
  }
  return (
    <>
      <SectionCard
        className="me-actions-panel"
        title="내 할 일"
        actions={actions.data ? <Badge tone="muted">{actions.data.actions.length}건</Badge> : undefined}
        description="비용·오류·키 만료 신호를 확인하고 필요한 작업을 처리하세요."
      >
        <MeOperationNotice pending={snooze.pending} uncertain={snooze.uncertain} />
        {!snooze.access.allowed ? (
          <InlineNotice tone="info">읽기 전용에서는 할 일을 숨길 수 없습니다.</InlineNotice>
        ) : null}
        <MeQueryContent query={actions} label="내 할 일">
          <MePartial failures={actions.data?.partial_failures} />
          {actions.data?.actions.length ? (
            <ul className="me-action-list" aria-label="확인할 할 일">
              {actions.data.actions.map((action) => (
                <li key={action.type}>
                  <div className="me-action-copy">
                    <div className="me-action-heading">
                      <h3>{meActionTitle(action.type)}</h3>
                      <Badge tone={severityTone(action.severity)}>{meLabel(action.severity)}</Badge>
                    </div>
                    <p>{action.message}</p>
                  </div>
                  <div className="me-action-tools">
                    {actionTarget(action.type) ? (
                      <Button size="small" onClick={() => update(actionTarget(action.type) ?? {})}>
                        {action.button_label || "확인"}
                      </Button>
                    ) : action.type === "cost_increase" ? (
                      <Button size="small" onClick={() => document.getElementById("me-report")?.focus()}>
                        리포트 보기
                      </Button>
                    ) : canOpenLegacyAdmin(auth) ? (
                      <FeatureLegacyLink
                        featureId="me.home"
                        className="button button-secondary button-small"
                        href={legacyRoutes.me}
                      >
                        기존 내 홈에서 확인
                      </FeatureLegacyLink>
                    ) : null}
                    <Button
                      size="small"
                      variant="ghost"
                      disabled={snooze.disabled || actions.isFetching}
                      onClick={(event) => {
                        trigger.current = event.currentTarget;
                        setSnoozing(action);
                      }}
                    >
                      7일 숨기기
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : !actions.data?.partial_failures.length ? (
            <EmptyState
              title="처리할 할 일이 없습니다."
              description="현재 조회된 신호 중 처리할 항목이 없습니다."
            />
          ) : null}
        </MeQueryContent>
      </SectionCard>
      <ConfirmDialog
        open={Boolean(snoozing)}
        onOpenChange={(open) => {
          if (!open) setSnoozing(undefined);
        }}
        returnFocusRef={trigger}
        title="할 일 숨기기"
        description={`'${snoozing?.message ?? ""}'와 같은 종류의 할 일을 7일 동안 숨깁니다.`}
        confirmLabel="숨기기"
        confirmDisabled={snooze.disabled}
        errorFormatter={safeMeMessage}
        onConfirm={async () => {
          if (!snoozing) return;
          await snooze.execute({ type: snoozing.type });
          setSnoozing(undefined);
        }}
      />
    </>
  );
}
