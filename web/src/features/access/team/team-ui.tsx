import type { ReactNode } from "react";
import { QueryNotice, UpdatedAt } from "@/features/access/access-ui";
import { LoadingState } from "@/shared/components/state/PageStates";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Button } from "@/shared/components/ui/Button";
export function TeamQueryPanel({
  query,
  label,
  children,
}: {
  query: {
    isError: boolean;
    error: unknown;
    isPending: boolean;
    data: unknown;
    dataUpdatedAt: number;
    refetch: () => Promise<unknown>;
  };
  label: string;
  children: ReactNode;
}) {
  return (
    <>
      {query.isError ? (
        <QueryNotice
          error={query.error}
          hasData={Boolean(query.data)}
          label={label}
          onRetry={() => void query.refetch()}
        />
      ) : null}
      {query.isPending && !query.data ? (
        <LoadingState label={label + "을 불러오는 중입니다."} />
      ) : query.data ? (
        children
      ) : null}
      <UpdatedAt at={query.dataUpdatedAt} />
    </>
  );
}
export function TeamPartial({ failed, retry }: { failed: boolean; retry: () => Promise<unknown> }) {
  return failed ? (
    <InlineNotice
      tone="warning"
      title="일부 항목을 확인하지 못했습니다."
      actions={
        <Button size="small" onClick={() => void retry()}>
          다시 조회
        </Button>
      }
    >
      확인하지 못한 항목은 집계에서 제외해 표시합니다.
    </InlineNotice>
  ) : null;
}
