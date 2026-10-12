import { ChangeSetList } from "./ChangeSetList";
import { ChangeSetImpactForm } from "./ChangeSetImpactForm";
import { ChangeSetDetails } from "./ChangeSetDetails";
import {
  lifecycleConfigs,
  lifecycleOrder,
  changeSetItemsSchema,
  createSchema,
  simulateSchema,
  simulateParams,
  type LifecycleAction,
  changeSetStatusLabel,
  type CreateValues,
  type SimulateValues,
} from "./change-set-model";
import { useContext, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { tokenStore } from "@/shared/auth/token-store";

import { routeId, systemSettingsKeys, useChangeSets } from "@/features/system/settings/use-system-settings";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import type { ChangeSetDryRun } from "@/shared/api/domains/system.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { FormDialog } from "@/shared/components/form/FormDialog";
import { FormField } from "@/shared/components/form/FormField";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { Sheet } from "@/shared/components/ui/Sheet";
import { Textarea } from "@/shared/components/ui/Textarea";
import { useChangeSetMutation } from "./use-change-set-mutation";
import { useChangeSetCreateAttempt } from "./use-change-set-create-attempt";
import { useChangeSetReview } from "./use-change-set-review";
import { assertChangeSetResponse } from "./change-set-response";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

const system = endpoints.domains.system;

export function ChangeSetsTab({ hasAdminWrite }: { hasAdminWrite: boolean }): React.JSX.Element {
  const auth = useAuth();
  const context = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const readable =
    ["authenticated", "legacy", "open"].includes(auth.mode) &&
    auth.user?.scopes.includes("admin:read") === true &&
    context?.featureId === routeId &&
    context.permitted;
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.team_id,
    readable,
  ]);
  if (!readable)
    return <InlineNotice tone="warning">현재 계정과 화면에서 변경 세트를 조회할 수 없습니다.</InlineNotice>;
  return <OwnedChangeSetsTab key={owner} owner={owner} hasAdminWrite={hasAdminWrite} />;
}

function OwnedChangeSetsTab({
  owner,
  hasAdminWrite,
}: {
  owner: string;
  hasAdminWrite: boolean;
}): React.JSX.Element {
  const queryKey = [...systemSettingsKeys.changeSets, owner];
  const review = useChangeSetReview(queryKey);
  const access = useFeatureMutationAccess(
    [routeId],
    hasAdminWrite,
    "변경에는 admin:write 권한이 필요합니다.",
  );
  const changeSets = useChangeSets(owner);
  const createAttempt = useChangeSetCreateAttempt(queryKey, access.assertCurrent);
  const createTriggerRef = useRef<HTMLButtonElement | null>(null);
  const rowTriggerRef = useRef<HTMLElement | null>(null);
  const reviewTriggerRef = useRef<HTMLElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const pendingAction = review.snapshot?.action;
  const [dryRun, setDryRun] = useState<
    { id: string; revision: unknown; result: ChangeSetDryRun } | undefined
  >();

  const rows = useMemo(() => changeSets.data?.change_sets ?? [], [changeSets.data?.change_sets]);
  const selected = rows.find((row) => row.id === selectedId);

  const createForm = useZodForm<CreateValues, CreateValues>(createSchema, {
    title: "",
    description: "",
    canary_scope: "",
    items: "",
  });

  const simulateForm = useZodForm<SimulateValues, SimulateValues>(simulateSchema, {
    change_type: "block_model",
    days: "7",
    pattern: "",
    model: "",
    input_krw_per_1m: "",
    output_krw_per_1m: "",
    from: "",
    to: "",
  });

  const createChangeSet = useChangeSetMutation({
    mutate: async (values: CreateValues) => {
      access.assertCurrent();
      const items =
        values.items === ""
          ? []
          : changeSetItemsSchema.parse(JSON.parse(values.items) as unknown).map((item) => ({
              kind: item.kind,
              key: item.key,
              value: item.value,
              ...(item.note ? { note: item.note } : {}),
            }));
      createAttempt.claim();
      try {
        const result = await apiClient.request(system.changeSets.create, {
          body: {
            title: values.title,
            description: values.description,
            canary_scope: values.canary_scope,
            items,
          },
          routeId,
          retryUnauthorized: false,
        });
        if (!result.id.trim() || result.status !== "draft")
          throw new AppError("생성 완료 응답을 확인하지 못했습니다. 목록에서 실제 생성 여부를 확인하세요.", {
            kind: "contract",
          });
        return result;
      } finally {
        createAttempt.finish();
      }
    },
    invalidates: [systemSettingsKeys.changeSets],
    invalidateOnError: true,
    successMessage: "변경 세트를 만들었습니다.",
    errorMessage: "변경 세트를 만들지 못했습니다.",
  });

  const changeSetDryRun = useChangeSetMutation({
    mutate: async ({ id }: { id: string; revision: unknown }) =>
      apiClient.request(withPathParams(system.changeSets.dryRun, { id }), { routeId }),
    errorMessage: "미리보기를 실행하지 못했습니다.",
    onSuccess: (result, variables) => setDryRun({ ...variables, result }),
  });

  // One mutation per lifecycle step: the server exposes each as its own POST and
  // rejects a transition that does not match the current status.
  const lifecycle = useChangeSetMutation({
    mutate: async (variables: { action: LifecycleAction; id: string; reason: string; target?: string }) => {
      access.assertCurrent();
      const { action, id, reason } = variables;
      review.claim(action, id, variables.target);
      const note = reason.trim();
      if (action === "delete") {
        const result = await apiClient.request(withPathParams(system.changeSets.remove, { id }), {
          body: { note },
          routeId,
          retryUnauthorized: false,
        });
        assertChangeSetResponse(action, id, result);
        return result;
      }
      const endpoint =
        action === "submit"
          ? system.changeSets.submit
          : action === "approve"
            ? system.changeSets.approve
            : action === "apply"
              ? system.changeSets.apply
              : system.changeSets.rollback;
      const result = await apiClient.request(withPathParams(endpoint, { id }), {
        body: note === "" ? {} : { note },
        routeId,
        retryUnauthorized: false,
      });
      assertChangeSetResponse(action, id, result);
      return result;
    },
    invalidates: [systemSettingsKeys.changeSets, systemSettingsKeys.effective],
    invalidateOnError: true,
    successMessage: (_result, variables) => lifecycleConfigs[variables.action].successMessage,
    errorMessage: "변경 세트 작업을 완료하지 못했습니다.",
  });

  const simulate = useChangeSetMutation({
    mutate: async (values: SimulateValues) =>
      apiClient.request(system.changeSets.simulateImpact, {
        body: {
          change_type: values.change_type,
          days: Number(values.days),
          params: simulateParams(values),
        },
        routeId,
      }),
    errorMessage: "변경 영향도를 계산하지 못했습니다.",
  });

  const selectedStatus = selected?.status ?? "";
  const actionDisabledReason = (action: LifecycleAction): string | undefined => {
    if (!access.allowed) return access.reason;
    if (!changeSets.isSuccess || changeSets.isFetching || !review.canBegin)
      return "최신 목록을 먼저 확인하세요.";
    if (!lifecycleConfigs[action].enabledFor.includes(selectedStatus)) {
      return `현재 상태(${changeSetStatusLabel(selectedStatus)})에서는 ${lifecycleConfigs[action].label}할 수 없습니다.`;
    }
    return undefined;
  };
  const activeConfig = pendingAction ? lifecycleConfigs[pendingAction] : undefined;
  const dryRunResult =
    dryRun && dryRun.id === selectedId && dryRun.revision === review.revision ? dryRun.result : undefined;

  return (
    <div className="settings-tab-stack">
      <ChangeSetList
        changeSets={changeSets}
        rows={rows}
        canCreate={access.allowed && review.canBegin}
        createTriggerRef={createTriggerRef}
        onCreate={() => {
          if (createAttempt.begin()) setCreating(true);
        }}
        onSelect={(id, target) => {
          rowTriggerRef.current = target;
          setSelectedId(id);
        }}
      />

      <ChangeSetImpactForm
        form={simulateForm}
        pending={simulate.isPending}
        onSubmit={(values) => simulate.mutate(values)}
        result={simulate.data}
      />

      <FormDialog
        open={creating}
        onOpenChange={(next) => {
          setCreating(next);
          if (!next) createForm.reset();
        }}
        form={createForm}
        title="새 변경 세트"
        description="설정 변경 묶음을 만들고 승인 절차에 올립니다."
        submitLabel="만들기"
        submitDisabled={!access.allowed || createAttempt.sent}
        returnFocusRef={createTriggerRef}
        onSubmit={async (values) => {
          await createChangeSet.mutateAsync(values);
          createForm.reset();
        }}
      >
        {!access.allowed ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
        {createAttempt.sent && !createChangeSet.isPending ? (
          <InlineNotice tone="warning">
            생성 결과 확인이 필요합니다. 같은 요청을 자동으로 다시 보내지 않습니다. 초안을 확인하고 취소한 뒤
            목록을 새로고침하세요. 같은 초안이 이미 생성되었을 수 있습니다.
          </InlineNotice>
        ) : null}
        <FormField label="제목" required error={createForm.formState.errors.title?.message}>
          {(control) => <Input {...control} {...createForm.register("title")} />}
        </FormField>
        <FormField label="설명">
          {(control) => <Textarea {...control} rows={2} {...createForm.register("description")} />}
        </FormField>
        <FormField label="카나리 범위" description="적용 범위 메모로만 기록됩니다.">
          {(control) => <Input {...control} {...createForm.register("canary_scope")} />}
        </FormField>
        <FormField
          label="변경 항목(JSON)"
          description='[{"kind":"setting","key":"clickhouse.url","value":"http://ch:8123"}] 형식입니다. 비밀값과 읽기 전용 설정은 서버가 거부합니다.'
          error={createForm.formState.errors.items?.message}
        >
          {(control) => <Textarea {...control} rows={5} {...createForm.register("items")} />}
        </FormField>
      </FormDialog>

      <Sheet
        open={selected !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setSelectedId(undefined);
            setDryRun(undefined);
          }
        }}
        size="wide"
        title={selected?.title || selected?.id || "변경 세트"}
        description="변경 세트의 항목·이전 값을 확인하고 제출·승인·적용·되돌리기를 진행합니다."
        returnFocusRef={rowTriggerRef}
        footer={
          <div className="settings-form-actions">
            <Button
              disabled={!selected || changeSetDryRun.isPending || !review.canBegin}
              onClick={() =>
                selected && changeSetDryRun.mutate({ id: selected.id, revision: review.revision })
              }
            >
              {changeSetDryRun.isPending ? "확인 중" : "미리보기"}
            </Button>
            {lifecycleOrder.map((action) => {
              const reason = actionDisabledReason(action);
              const config = lifecycleConfigs[action];
              return (
                <Button
                  key={action}
                  variant={config.tone === "danger" ? "danger" : "primary"}
                  disabled={!selected || reason !== undefined}
                  title={reason}
                  onClick={(event) => {
                    if (selected && !reason) {
                      reviewTriggerRef.current = event.currentTarget;
                      review.begin(selected, action);
                    }
                  }}
                >
                  {config.label}
                </Button>
              );
            })}
          </div>
        }
      >
        {selected && dryRun?.id === selected.id && dryRun.revision !== review.revision ? (
          <InlineNotice tone="warning">
            목록이 갱신되어 이전 미리보기를 숨겼습니다. 최신 항목으로 미리보기를 다시 실행하세요.
          </InlineNotice>
        ) : null}
        {selected ? <ChangeSetDetails selected={selected} dryRunResult={dryRunResult} /> : null}
      </Sheet>

      <ConfirmDialog
        open={review.snapshot !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            review.clear();
          }
        }}
        returnFocusRef={reviewTriggerRef}
        tone={activeConfig?.tone ?? "primary"}
        requireReason
        requireTarget={activeConfig?.tone === "danger" ? review.snapshot?.row.id : undefined}
        confirmDisabled={!access.allowed || !review.matches || review.wasSent}
        title={activeConfig?.title ?? ""}
        description={activeConfig && review.snapshot ? activeConfig.description(review.snapshot.row) : ""}
        confirmLabel={activeConfig?.confirmLabel ?? "확인"}
        onConfirm={async (reason, target) => {
          if (!pendingAction || !review.snapshot) return;
          await lifecycle.mutateAsync({ action: pendingAction, id: review.snapshot.row.id, reason, target });
          review.clear();
          if (pendingAction === "delete") {
            setSelectedId(undefined);
            setDryRun(undefined);
          }
        }}
      >
        {!access.allowed ? <InlineNotice tone="warning">{access.reason}</InlineNotice> : null}
        {!review.matches || review.wasSent ? (
          <InlineNotice tone="warning">
            같은 변경을 자동으로 다시 보내지 않습니다. 취소 후 목록을 새로고침하고 다시 검토하세요.
          </InlineNotice>
        ) : null}
        {activeConfig?.reasonNote ? <p>{activeConfig.reasonNote}</p> : null}
      </ConfirmDialog>
    </div>
  );
}
