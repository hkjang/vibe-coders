import { useAccessOperation } from "./use-access-operation";
import { useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Button } from "@/shared/components/ui/Button";
import { ConfirmDialog } from "@/shared/components/ui/ConfirmDialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useFeatureReadOwner, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { useMutationFeedback } from "@/shared/hooks/use-mutation-feedback";

interface Props {
  canWrite: boolean;
  writeDeniedReason: string;
}

export function BudgetNotificationAction(props: Props): React.JSX.Element | null {
  const owner = useFeatureReadOwner("access.users", "budget-notification");
  return owner.readable ? <Notification key={owner.id} {...props} owner={owner} /> : null;
}

function Notification({ canWrite, writeDeniedReason, owner }: Props & { owner: FeatureReadOwner }) {
  const { write, assertCurrent, safety, run } = useAccessOperation(
    owner,
    canWrite,
    writeDeniedReason || "예산 경보 발송에는 관리자 변경 권한이 필요합니다.",
    "budget-notification",
  );
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const send = useMutationFeedback({
    ...safety,
    mutate: () =>
      run(() =>
        apiClient.request(endpoints.domains.access.budgets.alerts, {
          query: { all: 1, notify: 1 },
          routeId: "access.users",
          retryUnauthorized: false,
        }),
      ),
    successMessage: "예산 경보 발송 요청을 처리했습니다. 실제 수신 여부는 알림 채널에서 확인하세요.",
  });
  return (
    <>
      <Button
        ref={trigger}
        variant="secondary"
        disabled={!write.allowed || send.isPending}
        title={write.reason}
        onClick={() => setOpen(true)}
      >
        경보 발송
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        returnFocusRef={trigger}
        title="예산 경보 발송"
        confirmLabel="발송"
        confirmDisabled={!write.allowed || send.isPending}
        description="현재 임계값을 넘은 예산 경보의 Mattermost 발송을 요청합니다. 발송 대상이 없거나 알림 연동이 꺼져 있으면 실제 알림은 나가지 않습니다."
        onConfirm={async () => {
          assertCurrent();
          await send.mutateAsync(undefined);
          assertCurrent();
        }}
      >
        {!write.allowed ? <InlineNotice tone="warning">{write.reason}</InlineNotice> : null}
      </ConfirmDialog>
    </>
  );
}
