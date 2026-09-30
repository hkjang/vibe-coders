import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import {
  confirmedFitness,
  exactFitnessSkillName,
  fitnessBody,
  fitnessKey,
  type FitnessFormValues,
} from "./skill-fitness-state";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import type { Skill, SkillFitness } from "@/shared/api/domains/agents.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { tokenStore } from "@/shared/auth/token-store";
import { useUnsavedChanges } from "@/shared/unsaved/context";
import { skillMutationOwners } from "@/shared/feature-access/policy";
import { useFeatureMutationAccess } from "@/shared/feature-access/use-feature-mutation-access";

const routeId = "agents.skills";
export interface SkillFitnessDraft {
  skill: Skill;
  baseline: Pick<SkillFitness, "passing_count" | "required">;
  epoch: number;
  instance: number;
}
export function useSkillFitnessQuery(name: string, epoch: number) {
  const client = useQueryClient();
  const query = useQuery({
    queryKey: fitnessKey(name, epoch),
    enabled: exactFitnessSkillName(name),
    retry: false,
    gcTime: 0,
    refetchOnMount: "always",
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.agents.skills.fitness, { query: { skill: name }, signal, routeId }),
  });
  const state = useSyncExternalStore(
    useCallback((listener) => client.getQueryCache().subscribe(listener), [client]),
    useCallback(() => client.getQueryState<SkillFitness>(fitnessKey(name, epoch)), [client, epoch, name]),
  );
  return { query, confirmed: confirmedFitness(state, name) };
}

export function useSkillFitnessEditor() {
  const auth = useAuth();
  const mutationAccess = useFeatureMutationAccess(
    skillMutationOwners,
    auth.user?.scopes.includes("admin:write") ?? false,
    "스킬 근거 기록에는 admin:write 권한이 필요합니다.",
  );
  const writable = mutationAccess.allowed;
  const access = useRef(writable);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const client = useQueryClient();
  const coordinator = useUnsavedChanges();
  if (!coordinator) throw new Error("Skill evidence requires a draft coordinator");
  const [selection, setSelection] = useState<SkillFitnessDraft>();
  const target = selection?.epoch === epoch ? selection : undefined;
  const active = useRef<SkillFitnessDraft | undefined>(undefined);
  const flight = useRef<SkillFitnessDraft | undefined>(undefined);
  const sequence = useRef(0);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [committed, setCommitted] = useState<{ name: string; epoch: number }>();
  const [owner] = useState(() => Symbol("skill-fitness-parent"));
  const leaveAction = useRef<(() => void) | undefined>(undefined);
  const afterClose = useRef<{ action: () => void; epoch: number } | undefined>(undefined);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    access.current = writable;
    active.current = target;
  }, [target, writable]);
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
              .find({ queryKey: fitnessKey(previous.name, previous.epoch), exact: true }) &&
          confirmedFitness(event.query.state, previous.name)
            ? undefined
            : previous,
        );
      }),
    [client],
  );
  const current = (draft: SkillFitnessDraft): boolean =>
    active.current === draft && draft.epoch === tokenStore.getSessionEpoch();
  const open = (skill: Skill, trigger: HTMLElement): void => {
    if (
      !access.current ||
      active.current ||
      epoch !== tokenStore.getSessionEpoch() ||
      !exactFitnessSkillName(skill.name)
    )
      return;
    const latest = confirmedFitness(client.getQueryState(fitnessKey(skill.name, epoch)), skill.name);
    if (!latest) return;
    const draft: SkillFitnessDraft = Object.freeze({
      skill: Object.freeze({ ...skill }),
      baseline: Object.freeze({ passing_count: latest.passing_count, required: latest.required }),
      epoch,
      instance: ++sequence.current,
    });
    active.current = draft;
    setSelection(draft);
    setDirty(false);
    setPending(false);
    setCommitted(undefined);
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
  const submit = async (draft: SkillFitnessDraft, values: FitnessFormValues): Promise<void> => {
    mutationAccess.assertCurrent();
    if (!current(draft) || !access.current)
      throw new AppError("현재 세션의 스킬 쓰기 권한을 확인하세요.", { kind: "permission" });
    if (
      !exactFitnessSkillName(draft.skill.name) ||
      !confirmedFitness(client.getQueryState(fitnessKey(draft.skill.name, draft.epoch)), draft.skill.name)
    )
      throw new AppError("현재 스킬의 적합성 근거를 다시 조회한 뒤 시도하세요.", { kind: "contract" });
    if (flight.current?.instance === draft.instance)
      throw new AppError("처리 중입니다.", { kind: "aborted" });
    const body = fitnessBody(draft.skill.name, values);
    flight.current = draft;
    setPending(true);
    setCommitted(undefined);
    try {
      const saved = await apiClient.request(endpoints.domains.agents.skills.recordFitness, { body, routeId });
      if (!current(draft)) return;
      if (saved.skill_name !== draft.skill.name)
        throw new AppError("기록 응답의 스킬을 확인할 수 없습니다. 다시 전송하기 전에 목록을 조회하세요.", {
          kind: "contract",
        });
      setCommitted({ name: draft.skill.name, epoch: draft.epoch });
      toast.success("적합성 근거를 기록했습니다.");
      void client.invalidateQueries({ queryKey: ["agents", "skills"] }).catch(() => undefined);
    } finally {
      if (flight.current?.instance === draft.instance) flight.current = undefined;
      if (current(draft)) setPending(false);
    }
  };
  return {
    epoch,
    target,
    writable,
    writeDisabledReason: mutationAccess.reason,
    pending: Boolean(target) && pending,
    committed: committed?.epoch === epoch ? committed : undefined,
    returnFocusRef,
    open,
    close,
    requestLeave,
    setDirty,
    submit,
  };
}
export type SkillFitnessEditor = ReturnType<typeof useSkillFitnessEditor>;
