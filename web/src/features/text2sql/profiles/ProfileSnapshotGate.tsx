import { Fragment, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { ProfileReviewSnapshot } from "@/shared/api/domains/text2sql-profile-review";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { useText2SqlQuery } from "../overview/use-text2sql-query";
import { text2sqlRouteId } from "../overview/use-text2sql-queries";

interface Props {
  model?: string;
  title: string;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  children: (snapshot: ProfileReviewSnapshot, error: Error | null) => ReactNode;
}
const emptySnapshot: ProfileReviewSnapshot = { review_supported: true, profile: null, revision: "absent" };

export function ProfileSnapshotGate(props: Props): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <SnapshotLoader {...props} />
  ) : (
    <UnsavedChangesProvider>
      <SnapshotLoader {...props} />
    </UnsavedChangesProvider>
  );
}
function SnapshotLoader(props: Props): React.JSX.Element {
  const query = useText2SqlQuery({
    key: ["text2sql", "profile-review", props.model],
    enabled: Boolean(props.model),
    automatic: false,
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.profiles.review, {
        query: { view: "review", virtual_model: props.model ?? "" },
        signal,
        routeId: text2sqlRouteId,
      }),
  });
  // Keep owned drafts across temporary refresh failures; the query owner clears
  // data and disposes the editor when authentication or read permission is lost.
  const ready = !props.model || query.data?.profile?.virtual_model === props.model;
  const enteringEditor = useRef(false);
  useLayoutEffect(() => {
    enteringEditor.current = ready;
  }, [ready]);
  if (!ready)
    return (
      <Dialog
        open
        title={props.title}
        description="현재 프로필과 검토 지원 여부를 확인합니다."
        onCloseAutoFocus={(event) => {
          if (enteringEditor.current) event.preventDefault();
        }}
        returnFocusRef={props.returnFocusRef}
        onOpenChange={(open) => {
          if (!open) props.onClose();
        }}
        footer={
          <>
            <Button onClick={props.onClose}>닫기</Button>
            <Button disabled={query.isFetching} onClick={() => query.refetch()}>
              다시 조회
            </Button>
          </>
        }
      >
        <InlineNotice
          tone={query.isFetching ? "info" : "warning"}
          title={query.isFetching ? "프로필 조회 중" : "프로필을 확인할 수 없습니다"}
        >
          {query.isFetching
            ? "최신 설정을 불러오고 있습니다."
            : "권한, 프로필 존재 여부와 서버의 검토 지원 여부를 확인하세요. 구버전 작업 방식으로 전환하지 않습니다."}
        </InlineNotice>
      </Dialog>
    );
  return <Fragment key={query.owner.id}>{props.children(query.data ?? emptySnapshot, query.error)}</Fragment>;
}
