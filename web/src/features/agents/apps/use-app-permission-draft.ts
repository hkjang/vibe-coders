import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { appPermissionKey, appPermissionSchema, type AppPermissionValues } from "./app-permission-form";
import { withPathParams } from "@/features/agents/endpoint-path";
import { apiClient } from "@/shared/api/client";
import type { WorkApp } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useUnsavedChanges } from "@/shared/unsaved/context";

export interface AppPermissionDraft {
  app: WorkApp;
  kind: "grant" | "revoke";
  subject?: AppPermissionValues;
  epoch: number;
  instance: number;
}

/** A sheet-local bridge protects parent actions as well as the common form's own close path. */
export function useAppPermissionDraft(canWrite: boolean) {
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("App permissions require an unsaved changes coordinator");
  const client = useQueryClient();
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const [selection, setSelection] = useState<AppPermissionDraft>();
  const target = selection?.epoch === epoch ? selection : undefined;
  const active = useRef<AppPermissionDraft | undefined>(undefined);
  const writable = useRef(canWrite);
  const flight = useRef<AppPermissionDraft | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const nextInstance = useRef(0);
  const [guardId] = useState(() => Symbol("app-permission-parent"));
  const leaveAction = useRef<(() => void) | undefined>(undefined);
  const afterClose = useRef<{ action: () => void; epoch: number } | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const addTrigger = useRef<HTMLElement | null>(null);
  const focusKey = useRef("");
  useLayoutEffect(() => {
    writable.current = canWrite;
    active.current = target;
  }, [canWrite, target]);

  const close = useCallback(
    (instance: number): void => {
      if (active.current?.instance !== instance) return;
      active.current = undefined;
      leaveAction.current = undefined;
      coordinator.removeForm(guardId);
      setSelection(undefined);
      setDirty(false);
      setPending(false);
    },
    [coordinator, guardId],
  );

  useLayoutEffect(() => {
    if (target) {
      coordinator.setForm(guardId, {
        dirty,
        pending,
        discard: (reason) => {
          const action = reason === "close" ? leaveAction.current : undefined;
          close(target.instance);
          // Let the common FormDialog unregister before a parent close changes
          // the URL; otherwise that navigation could prompt for the same draft twice.
          afterClose.current = action ? { action, epoch: target.epoch } : undefined;
        },
      });
    } else coordinator.removeForm(guardId);
  }, [close, coordinator, dirty, guardId, pending, target]);
  useLayoutEffect(() => {
    if (target) return;
    const next = afterClose.current;
    afterClose.current = undefined;
    if (next?.epoch === tokenStore.getSessionEpoch()) next.action();
  }, [target]);
  useLayoutEffect(
    () => () => {
      active.current = undefined;
      coordinator.removeForm(guardId);
    },
    [coordinator, guardId],
  );

  const open = (app: WorkApp, trigger: HTMLElement, subject?: AppPermissionValues): void => {
    if (!writable.current || active.current || epoch !== tokenStore.getSessionEpoch()) return;
    const draft: AppPermissionDraft = {
      app: { ...app },
      kind: subject ? "revoke" : "grant",
      subject: subject ? { ...subject } : undefined,
      epoch: tokenStore.getSessionEpoch(),
      instance: ++nextInstance.current,
    };
    active.current = draft;
    setDirty(false);
    setPending(false);
    returnFocusRef.current = trigger;
    focusKey.current = JSON.stringify([app.id, subject?.subject_type, subject?.subject_id]);
    setSelection(draft);
  };
  const rememberTrigger = (node: HTMLElement | null, appId: string, subject?: AppPermissionValues): void => {
    if (!subject && node) addTrigger.current = node;
    if (focusKey.current !== JSON.stringify([appId, subject?.subject_type, subject?.subject_id])) return;
    if (node) returnFocusRef.current = node;
    else if (subject && addTrigger.current?.isConnected) returnFocusRef.current = addTrigger.current;
    // Unmounting the add button must not erase an explicit parent-collapse target.
  };
  const requestLeave = (action: () => void): void => {
    if (!active.current || active.current.epoch !== tokenStore.getSessionEpoch()) {
      action();
      return;
    }
    if (coordinator.getSnapshot().pending || flight.current?.instance === active.current.instance) return;
    leaveAction.current = action;
    coordinator.requestClose(guardId);
  };
  const submit = async (draft: AppPermissionDraft, values: AppPermissionValues): Promise<void> => {
    const isCurrent = (): boolean =>
      active.current?.instance === draft.instance && draft.epoch === tokenStore.getSessionEpoch();
    if (!isCurrent() || !writable.current) {
      throw new AppError("현재 세션의 앱 변경 권한을 확인한 뒤 다시 시도하세요.", { kind: "permission" });
    }
    if (flight.current?.instance === draft.instance)
      throw new AppError("처리 중입니다.", { kind: "aborted" });
    const tuple = appPermissionSchema.parse(draft.subject ?? values);
    flight.current = draft;
    setPending(true);
    try {
      if (draft.kind === "grant")
        await apiClient.request(
          withPathParams(endpoints.domains.agents.apps.grantPermission, { id: draft.app.id }),
          { body: { ...tuple }, routeId: "agents.apps" },
        );
      else
        await apiClient.request(
          withPathParams(endpoints.domains.agents.apps.revokePermission, { id: draft.app.id }),
          { query: { ...tuple }, routeId: "agents.apps" },
        );
      if (!isCurrent()) return;
      await client.invalidateQueries({ queryKey: appPermissionKey(draft.app.id) });
      if (isCurrent())
        toast.success(
          draft.kind === "grant" ? "추가 접근 권한을 저장했습니다." : "추가 접근 권한을 회수했습니다.",
        );
    } finally {
      if (flight.current?.instance === draft.instance) flight.current = undefined;
      if (isCurrent()) setPending(false);
    }
  };

  return {
    target,
    pending: Boolean(target) && pending,
    close,
    open,
    rememberTrigger,
    requestLeave,
    returnFocusRef,
    setDirty,
    submit,
  };
}

export type AppPermissionEditor = ReturnType<typeof useAppPermissionDraft>;
