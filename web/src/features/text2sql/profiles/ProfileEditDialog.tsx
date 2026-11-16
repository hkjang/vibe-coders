import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import type { Text2SQLConnectionRow } from "@/shared/api/domains/text2sql";
import type { ProfileReviewInput, ProfileReviewSnapshot } from "@/shared/api/domains/text2sql-profile-review";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { useZodForm } from "@/shared/components/form/use-zod-form";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { useText2SqlQuery } from "../overview/use-text2sql-query";
import { useText2SqlMutation } from "../overview/use-text2sql-mutation";
import { text2sqlInvalidations, text2sqlRouteId } from "../overview/use-text2sql-queries";
import { ProfileFormFields } from "./ProfileFormFields";
import { ProfileChangeReview } from "./ProfileChangeReview";
import { profileDefaults, profileFields, profileFormSchema, type ProfileFormValues } from "./profile-form";

interface Props {
  model?: string;
  canWrite: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  connections: readonly Text2SQLConnectionRow[];
  connectionsLoading: boolean;
  connectionsError: unknown;
}
const emptySnapshot: ProfileReviewSnapshot = { review_supported: true, profile: null, revision: "absent" };
const title = (model?: string) => (model ? "런타임 프로필 수정" : "런타임 프로필 추가");

export function ProfileEditDialog(props: Props): React.JSX.Element {
  const coordinator = useUnsavedChanges();
  return coordinator ? (
    <ProfileLoader {...props} />
  ) : (
    <UnsavedChangesProvider>
      <ProfileLoader {...props} />
    </UnsavedChangesProvider>
  );
}

function ProfileLoader(props: Props): React.JSX.Element {
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
  // A failed refresh must not discard an owned draft. The query owner clears
  // cached data on authentication or read-permission loss.
  const ready = !props.model || query.data?.profile?.virtual_model === props.model;
  const enteringEditor = useRef(false);
  useLayoutEffect(() => {
    enteringEditor.current = ready;
  }, [ready]);
  if (!ready) {
    return (
      <Dialog
        open
        title={title(props.model)}
        description="현재 프로필과 저장 검토 지원 여부를 확인합니다."
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
            : "권한, 프로필 존재 여부와 서버의 검토 저장 지원 여부를 확인하세요. 구버전 저장 방식으로 전환하지 않습니다."}
        </InlineNotice>
      </Dialog>
    );
  }
  return (
    <ProfileEditor
      key={query.owner.id}
      {...props}
      initial={query.data ?? emptySnapshot}
      readError={query.error}
    />
  );
}

function ProfileEditor({
  initial,
  readError,
  ...props
}: Props & {
  initial: ProfileReviewSnapshot;
  readError: Error | null;
}): React.JSX.Element {
  const [baseline, setBaseline] = useState(initial);
  const [review, setReview] = useState<ProfileReviewInput>();
  const [error, setError] = useState<{ message: string; requestId?: string }>();
  const [needsReview, setNeedsReview] = useState(false);
  const form = useZodForm<ProfileFormValues, ProfileFormValues>(
    profileFormSchema,
    profileDefaults(initial.profile),
  );
  const heading = useRef<HTMLHeadingElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const formId = useId();
  const guard = useDraftGuard({ dirty: form.formState.isDirty, onDiscard: props.onClose });
  const snapshot = useText2SqlMutation({
    readOnly: true,
    mutate: (model: string) =>
      apiClient.request(endpoints.domains.text2sql.profiles.review, {
        query: { view: "review", virtual_model: model },
        routeId: text2sqlRouteId,
      }),
  });
  const save = useText2SqlMutation({
    authorized: props.canWrite,
    mutate: (body: ProfileReviewInput) =>
      apiClient.request(endpoints.domains.text2sql.profiles.saveReviewed, { body, routeId: text2sqlRouteId }),
    invalidates: text2sqlInvalidations.overview,
    successMessage: "프로필 변경과 감사 기록을 저장했습니다.",
  });
  const { setFocus } = form;
  useEffect(() => {
    if (!props.canWrite) cancel.current?.focus();
    else if (review) heading.current?.focus();
    else setFocus(props.model ? "upstream_model" : "virtual_model");
  }, [review, props.model, props.canWrite, setFocus]);
  const fail = (cause: unknown): void => {
    const code = isAppError(cause) ? cause.code : undefined;
    const conflict = code === "text2sql_profile_conflict";
    setNeedsReview(true);
    setError({
      message: conflict
        ? "다른 변경이 확인되었습니다. 입력을 유지한 채 최신 기준으로 다시 검토하세요."
        : code === "profile_exists"
          ? "같은 이름의 프로필이 있습니다. 목록의 수정 버튼을 사용하세요."
          : code === "profile_missing"
            ? "프로필이 삭제되었습니다. 최신 목록을 확인하세요."
            : code === "text2sql_profile_unchanged"
              ? "변경된 설정이 없습니다. 입력 내용을 수정하세요."
              : safeAppErrorMessage(cause, "프로필을 저장하지 못했습니다. 최신 기준을 다시 확인하세요."),
      requestId: isAppError(cause) ? cause.requestId : undefined,
    });
  };
  const prepare = (values: ProfileFormValues, refresh = false): void => {
    if (!props.canWrite) return;
    setError(undefined);
    void guard.run(
      async () => {
        const current =
          !props.model || refresh || needsReview
            ? await snapshot.mutateAsync(values.virtual_model)
            : baseline;
        if (current.profile && current.profile.virtual_model !== values.virtual_model)
          throw new AppError("프로필 식별자가 일치하지 않습니다.", { kind: "contract" });
        if (!props.model && current.profile)
          throw new AppError("같은 이름의 프로필이 있습니다. 목록의 수정 버튼을 사용하세요.", {
            code: "profile_exists",
            kind: "contract",
          });
        if (props.model && !current.profile)
          throw new AppError("프로필이 삭제되었습니다. 최신 목록을 확인하세요.", {
            kind: "contract",
            code: "profile_missing",
          });
        if (current.profile && profileFields.every(([key]) => current.profile?.[key] === values[key]))
          throw new AppError("변경된 설정이 없습니다.", {
            kind: "contract",
            code: "text2sql_profile_unchanged",
          });
        return { baseline: current, body: { ...values, expected_revision: current.revision } };
      },
      fail,
      (next) => {
        setBaseline(next.baseline);
        setReview(next.body);
        setNeedsReview(false);
      },
    );
  };
  const submit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!props.canWrite || guard.pending) return;
    if (!review) {
      void form.handleSubmit((values) => prepare(values))();
      return;
    }
    if (needsReview) return;
    setError(undefined);
    void guard.run(() => save.mutateAsync(review), fail);
  };
  return (
    <Dialog
      open
      scrollBody
      wide={Boolean(review)}
      title={title(props.model)}
      description="변경 전후 설정과 적용 범위를 검토하고 사유와 함께 저장합니다."
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        if (!props.canWrite) cancel.current?.focus();
        else setFocus(props.model ? "upstream_model" : "virtual_model");
      }}
      returnFocusRef={props.returnFocusRef}
      onOpenChange={(open) => {
        if (!open) guard.requestClose();
      }}
      footer={
        <>
          <Button ref={cancel} disabled={guard.pending} onClick={() => guard.requestClose()}>
            취소
          </Button>
          {review ? (
            <Button
              disabled={guard.pending}
              onClick={() => {
                setReview(undefined);
                setError(undefined);
              }}
            >
              입력 수정
            </Button>
          ) : null}
          {review && needsReview ? (
            <Button disabled={guard.pending || !props.canWrite} onClick={() => prepare(review, true)}>
              최신 기준으로 다시 검토
            </Button>
          ) : null}
          <Button
            type="submit"
            form={formId}
            variant="primary"
            disabled={guard.pending || !props.canWrite || Boolean(review && needsReview)}
          >
            {guard.pending ? "확인 중" : review ? "검토한 변경 저장" : "변경 검토"}
          </Button>
        </>
      }
    >
      {!props.canWrite ? (
        <InlineNotice tone="warning" title="현재 수정 권한이 없습니다">
          입력은 유지됩니다. 권한이 복구된 뒤 다시 검토하세요.
        </InlineNotice>
      ) : null}
      {readError ? (
        <InlineNotice tone="warning" title="최신 프로필 조회 실패">
          입력 내용과 처음 불러온 검토 기준을 유지합니다. 저장 시 다른 변경이 확인되면 최신 기준으로 다시
          검토해야 합니다.
          {isAppError(readError) && readError.requestId ? ` (요청 ID: ${readError.requestId})` : ""}
        </InlineNotice>
      ) : null}
      {error ? (
        <InlineNotice tone="danger" title="프로필 작업 확인 필요">
          {error.message}
          {error.requestId ? ` (요청 ID: ${error.requestId})` : ""}
        </InlineNotice>
      ) : null}
      <form id={formId} onSubmit={submit}>
        {review ? (
          <ProfileChangeReview
            before={baseline.profile}
            after={review}
            heading={heading}
            connections={props.connections}
            connectionsLoading={props.connectionsLoading}
            connectionsError={props.connectionsError}
          />
        ) : (
          <fieldset className="t2s-profile-fields" disabled={guard.pending || !props.canWrite}>
            <ProfileFormFields form={form} editing={Boolean(props.model)} connections={props.connections} />
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}
