import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { useAuth } from "@/app/auth/AuthProvider";
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
export function useRequestNoteEditor() {
  const auth = useAuth();
  const client = useQueryClient();
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("Request notes require a draft coordinator");
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const supported = supportsRequestNoteContract(auth.backendVersion);
  const writable = canWriteRequestNote(auth);
  const access = useRef({ writable, supported });
  const [selection, setSelection] = useState<RequestNoteDraft>();
  const target = selection?.epoch === epoch ? selection : undefined;
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
  useLayoutEffect(() => {
    active.current = target;
    access.current = { writable, supported };
  }, [supported, target, writable]);
  const close = useCallback(
    (instance: number): void => {
      if (active.current?.instance !== instance) return;
      active.current = undefined;
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
    active.current === draft && draft.epoch === tokenStore.getSessionEpoch();
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
    if (!current(draft) || !access.current.writable)
      throw new AppError("현재 세션의 요청 메모 쓰기 권한을 확인하세요.", { kind: "permission" });
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
    setPending(true);
    setCommitted(undefined);
    setUnsupportedInstance(undefined);
    try {
      if (draft.kind === "edit")
        await apiClient.request(
          withPathParams(endpoints.domains.observability.requests.saveNote, { id: draft.requestId }),
          { body, routeId },
        );
      else
        await apiClient.request(
          withPathParams(endpoints.domains.observability.requests.removeNote, { id: draft.requestId }),
          { routeId },
        );
      if (!current(draft)) return;
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
    target,
    pending: Boolean(target) && pending,
    recipientUnsupported: Boolean(target) && unsupportedInstance === target?.instance,
    committed: committed?.epoch === epoch ? committed : undefined,
    returnFocusRef,
    open,
    close,
    requestLeave,
    setDirty,
    submit,
  };
}
export type RequestNoteEditor = ReturnType<typeof useRequestNoteEditor>;
