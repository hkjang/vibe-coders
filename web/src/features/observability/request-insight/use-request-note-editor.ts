import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { useAuth } from "@/app/auth/AuthProvider";
import { requestMutationOwners } from "@/shared/feature-access/policy";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";
import { canWriteRequestNote } from "./request-access";
import {
  confirmedRequestNote,
  requestNoteBody,
  requestNoteContractMessage,
  requestNoteKey,
  supportsRequestNoteContract,
  type RequestNoteValues,
} from "./request-note-state";
import { apiClient } from "@/shared/api/client";
import type { RequestNote } from "@/shared/api/domains/observability.schemas";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useUnsavedChanges } from "@/shared/unsaved/context";

const routeId = "observability.request-insight";
export interface RequestNoteDraft {
  requestId: string;
  baseline: RequestNote;
  kind: "edit" | "delete";
  epoch: number;
  instance: number;
  retention?: RequestNoteRetention;
}
export interface RequestNoteRetention {
  owner: object;
  isCurrent: () => boolean;
  isSuspended?: () => boolean;
}
type RetainedOutcome = "none" | "pending" | "acknowledged" | "uncertain";
interface RetainedDraft {
  target: RequestNoteDraft;
  values: Pick<RequestNoteValues, "noteMode" | "tagsMode"> &
    Partial<Pick<RequestNoteValues, "note" | "tags">>;
  dirty: boolean;
  outcome: RetainedOutcome;
}

export function useRequestNoteQuery(requestId: string, epoch: number) {
  const client = useQueryClient();
  const key = requestNoteKey(requestId, epoch);
  const query = useQuery({
    queryKey: key,
    enabled: requestId !== "",
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      apiClient.request(withPathParams(endpoints.domains.observability.requests.note, { id: requestId }), {
        signal,
        routeId,
      }),
  });
  const state = useSyncExternalStore(
    useCallback((listener) => client.getQueryCache().subscribe(listener), [client]),
    useCallback(
      () => client.getQueryState<RequestNote>(requestNoteKey(requestId, epoch)),
      [client, epoch, requestId],
    ),
  );
  return { query, confirmed: confirmedRequestNote(state, requestId) };
}

/** Page-local ownership lets a nested note form protect sheet and disclosure actions. */
export function useRequestNoteEditor(retention?: RequestNoteRetention) {
  const auth = useAuth();
  const client = useQueryClient();
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("Request notes require a draft coordinator");
  const coordination = useSyncExternalStore(coordinator.subscribe, coordinator.getSnapshot);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const supported = supportsRequestNoteContract(auth.backendVersion);
  const mutationAccess = useFeatureMutationAccess(
    requestMutationOwners,
    canWriteRequestNote(auth),
    "요청 메모 작성에는 admin:write 권한이 필요합니다.",
  );
  const writable = mutationAccess.allowed;
  const access = useRef({ writable, supported });
  const [selection, setSelection] = useState<RequestNoteDraft>();
  const target =
    selection?.epoch === epoch &&
    (!selection.retention || (selection.retention.owner === retention?.owner && retention.isCurrent()))
      ? selection
      : undefined;
  const active = useRef<RequestNoteDraft | undefined>(undefined);
  const flight = useRef<RequestNoteDraft | undefined>(undefined);
  const sequence = useRef(0);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [unsupportedInstance, setUnsupportedInstance] = useState<number>();
  const [committed, setCommitted] = useState<{ id: string; epoch: number; kind: "edit" | "delete" }>();
  const [owner] = useState(() => Symbol("request-note-parent"));
  const leaveAction = useRef<(() => void) | undefined>(undefined);
  const afterClose = useRef<{ action: () => void; epoch: number } | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [retained, setRetained] = useState<RetainedDraft>();
  const retainedRef = useRef<RetainedDraft | undefined>(undefined);
  const transmission = useRef<
    { draft: RequestNoteDraft; outcome: Exclude<RetainedOutcome, "none">; retired: boolean } | undefined
  >(undefined);
  useLayoutEffect(() => {
    active.current = target;
    access.current = { writable, supported };
  }, [supported, target, writable]);
  const close = useCallback(
    (instance: number): void => {
      if (active.current?.instance !== instance) return;
      active.current = undefined;
      retainedRef.current = undefined;
      setRetained(undefined);
      leaveAction.current = undefined;
      coordinator.removeForm(owner);
      setSelection(undefined);
      setDirty(false);
      setPending(false);
    },
    [coordinator, owner],
  );
  useLayoutEffect(() => {
    if (target)
      coordinator.setForm(owner, {
        dirty,
        pending,
        discard: (reason) => {
          const action = reason === "close" ? leaveAction.current : undefined;
          close(target.instance);
          afterClose.current = action ? { action, epoch: target.epoch } : undefined;
        },
      });
    else coordinator.removeForm(owner);
  }, [close, coordinator, dirty, owner, pending, target]);
  useLayoutEffect(() => {
    if (target) return;
    const next = afterClose.current;
    afterClose.current = undefined;
    if (next?.epoch === tokenStore.getSessionEpoch()) next.action();
  }, [target]);
  useLayoutEffect(
    () => () => {
      active.current = undefined;
      coordinator.removeForm(owner);
    },
    [coordinator, owner],
  );
  useLayoutEffect(
    () =>
      client.getQueryCache().subscribe((event) => {
        if (event.type !== "updated" || event.action.type !== "success") return;
        setCommitted((previous) =>
          previous &&
          event.query ===
            client
              .getQueryCache()
              .find({ queryKey: requestNoteKey(previous.id, previous.epoch), exact: true }) &&
          confirmedRequestNote(event.query.state, previous.id)
            ? undefined
            : previous,
        );
      }),
    [client],
  );
  const current = (draft: RequestNoteDraft): boolean =>
    active.current === draft &&
    draft.epoch === tokenStore.getSessionEpoch() &&
    (!draft.retention || draft.retention.isCurrent());
  const retain = useCallback(
    (draft: RequestNoteDraft, values: RequestNoteValues, wasDirty: boolean): void => {
      if (
        !draft.retention ||
        active.current !== draft ||
        draft.epoch !== tokenStore.getSessionEpoch() ||
        !draft.retention.isCurrent()
      )
        return;
      const sent = transmission.current?.draft === draft ? transmission.current : undefined;
      if (sent) sent.retired = true;
      const next: RetainedDraft = {
        target: draft,
        dirty: wasDirty,
        outcome: sent?.outcome ?? "none",
        // Preserve user-selected replacement text, not a second copy of server originals.
        values: {
          noteMode: values.noteMode,
          tagsMode: values.tagsMode,
          ...(values.noteMode === "replace" ? { note: values.note } : {}),
          ...(values.tagsMode === "replace" ? { tags: values.tags } : {}),
        },
      };
      retainedRef.current = next;
      setRetained(next);
    },
    [],
  );
  const open = (requestId: string, kind: "edit" | "delete", trigger: HTMLElement): void => {
    if (
      !access.current.writable ||
      !access.current.supported ||
      active.current ||
      epoch !== tokenStore.getSessionEpoch()
    )
      return;
    const baseline = confirmedRequestNote(client.getQueryState(requestNoteKey(requestId, epoch)), requestId);
    if (!baseline || (kind === "delete" && !baseline.exists)) return;
    const draft: RequestNoteDraft = {
      requestId,
      kind,
      baseline: { ...baseline, tags: [...baseline.tags], redacted_fields: [...baseline.redacted_fields] },
      epoch,
      instance: ++sequence.current,
      ...(retention ? { retention } : {}),
    };
    Object.freeze(draft.baseline.tags);
    Object.freeze(draft.baseline.redacted_fields);
    Object.freeze(draft.baseline);
    Object.freeze(draft);
    active.current = draft;
    setSelection(draft);
    setDirty(false);
    setPending(false);
    setCommitted(undefined);
    setUnsupportedInstance(undefined);
    retainedRef.current = undefined;
    setRetained(undefined);
    transmission.current = undefined;
    returnFocusRef.current = trigger;
  };
  const requestLeave = (action: () => void): void => {
    if (!active.current || active.current.epoch !== tokenStore.getSessionEpoch()) {
      action();
      return;
    }
    if (coordinator.getSnapshot().pending || flight.current?.instance === active.current.instance) return;
    leaveAction.current = action;
    coordinator.requestClose(owner);
  };
  const submit = async (draft: RequestNoteDraft, values: RequestNoteValues): Promise<void> => {
    mutationAccess.assertCurrent();
    if (!current(draft) || !access.current.writable)
      throw new AppError("현재 세션의 요청 메모 쓰기 권한을 확인하세요.", { kind: "permission" });
    if (draft.retention?.isSuspended?.())
      throw new AppError("조회 권한을 다시 확인한 뒤 초안을 재개하세요.", { kind: "permission" });
    if (retainedRef.current?.target === draft && retainedRef.current.outcome !== "none")
      throw new AppError("이전에 전송한 저장 요청입니다. 현재 메모를 다시 조회해 결과를 확인하세요.", {
        kind: "contract",
      });
    if (!access.current.supported) throw new AppError(requestNoteContractMessage, { kind: "contract" });
    const latest = confirmedRequestNote(
      client.getQueryState(requestNoteKey(draft.requestId, draft.epoch)),
      draft.requestId,
    );
    if (!latest || (draft.kind === "delete" && !latest.exists))
      throw new AppError("현재 메모·태그를 다시 조회한 뒤 시도하세요.", { kind: "contract" });
    if (flight.current?.instance === draft.instance)
      throw new AppError("처리 중입니다.", { kind: "aborted" });
    const body = requestNoteBody(values);
    flight.current = draft;
    const sent = draft.retention
      ? { draft, outcome: "pending" as Exclude<RetainedOutcome, "none">, retired: false }
      : undefined;
    if (sent) transmission.current = sent;
    setPending(true);
    setCommitted(undefined);
    setUnsupportedInstance(undefined);
    try {
      if (draft.kind === "edit")
        await apiClient.request(
          withPathParams(endpoints.domains.observability.requests.saveNote, { id: draft.requestId }),
          { body, routeId, ...(draft.retention ? { retryUnauthorized: false } : {}) },
        );
      else
        await apiClient.request(
          withPathParams(endpoints.domains.observability.requests.removeNote, { id: draft.requestId }),
          { routeId, ...(draft.retention ? { retryUnauthorized: false } : {}) },
        );
      if (!current(draft)) return;
      if (sent && draft.retention?.isSuspended?.()) sent.retired = true;
      if (sent) sent.outcome = "acknowledged";
      if (sent?.retired) {
        const saved = retainedRef.current;
        if (saved?.target === draft) {
          const next = { ...saved, outcome: "acknowledged" as const };
          retainedRef.current = next;
          setRetained(next);
        }
        return;
      }
      setCommitted({ id: draft.requestId, epoch: draft.epoch, kind: draft.kind });
      toast.success(
        draft.kind === "edit" ? "요청 메모·태그를 저장했습니다." : "요청 메모·태그를 삭제했습니다.",
      );
      for (const key of [
        requestNoteKey(draft.requestId, draft.epoch),
        ["admin", "requests"],
        ["observability", "llm", "prompts"],
      ])
        void client.invalidateQueries({ queryKey: key }).catch(() => undefined);
    } catch (cause) {
      if (sent && draft.retention?.isSuspended?.()) sent.retired = true;
      if (sent) sent.outcome = "uncertain";
      if (current(draft) && sent?.retired && retainedRef.current?.target === draft) {
        const next = { ...retainedRef.current, outcome: "uncertain" as const };
        retainedRef.current = next;
        setRetained(next);
      }
      if (current(draft) && draft.kind === "edit" && isAppError(cause) && cause.status === 405)
        setUnsupportedInstance(draft.instance);
      throw cause;
    } finally {
      if (flight.current?.instance === draft.instance) flight.current = undefined;
      if (current(draft)) setPending(false);
    }
  };
  return {
    epoch,
    supported,
    writable,
    writeDisabledReason: mutationAccess.reason,
    target,
    pending: Boolean(target) && pending,
    recipientUnsupported: Boolean(target) && unsupportedInstance === target?.instance,
    committed: committed?.epoch === epoch ? committed : undefined,
    returnFocusRef,
    retain,
    retainedDraft: retained?.target === target && target?.retention?.isCurrent() ? retained : undefined,
    awaitingParentDecision:
      coordination.confirmation?.kind === "close" && coordination.confirmation.owner === owner,
    open,
    close,
    requestLeave,
    setDirty,
    submit,
  };
}
export type RequestNoteEditor = ReturnType<typeof useRequestNoteEditor>;
