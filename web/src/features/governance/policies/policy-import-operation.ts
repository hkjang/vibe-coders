import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import {
  confirmPolicyAck,
  type PolicyImportAck,
  type PolicyImportBody,
} from "@/shared/api/domains/policy-import";
import { readPolicyExport } from "@/shared/api/domains/policy-import-export";
import { importProblem } from "@/shared/api/domains/policy-import-json";
import { useDraftGuard } from "@/shared/unsaved/use-draft-guard";
import type { PolicyImportAccess } from "./policy-import-access";
import { protectedJson } from "./policy-editor-security";
import {
  downloadPolicyBytes,
  importImpacts,
  parseCurrentExport,
  parseImportFile,
  readImportFile,
  samePolicies,
  type ImportSelection,
} from "./policy-import-state";

export interface ImportReview {
  selected: ImportSelection;
  baseline: PolicyImportBody;
  plan: PolicyImportAck;
  approval: object;
  prefix: string;
}
type Phase = "idle" | "reading" | "planning" | "checking" | "saving" | "refreshing" | "exporting";
export function usePolicyImportOperation(access: PolicyImportAccess, close: () => void) {
  const cache = useQueryClient();
  const [selected, setSelected] = useState<ImportSelection>();
  const selection = useRef<ImportSelection | undefined>(undefined);
  const [review, setReview] = useState<ImportReview>();
  const reviewed = useRef<ImportReview | undefined>(undefined);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<unknown>();
  const [ack, setAck] = useState<PolicyImportAck>();
  const completed = useRef(false);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [unconfirmed, setUnconfirmed] = useState(false);
  const reconciliation = useRef<PolicyImportBody | undefined>(undefined);
  const [reconciled, setReconciled] = useState(false);
  const mounted = useRef(false);
  const flight = useRef<{ controller: AbortController; token: object } | undefined>(undefined);
  const guard = useDraftGuard({ dirty: !!selected && !ack, onDiscard: close });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.controller.abort();
      flight.current = undefined;
      selection.current = undefined;
      reviewed.current = undefined;
      reconciliation.current = undefined;
    };
  }, []);
  const owned = () => {
    access.assertRead();
    if (!mounted.current) throw new AppError("이전 가져오기 화면입니다.", { kind: "aborted" });
  };
  const current = (task: NonNullable<typeof flight.current>) => {
    owned();
    if (flight.current !== task || task.controller.signal.aborted)
      throw new AppError("이전 가져오기 작업입니다.", { kind: "aborted" });
  };
  const run = (nextPhase: Phase, operation: (task: NonNullable<typeof flight.current>) => Promise<void>) => {
    if (!mounted.current || flight.current) return;
    try {
      owned();
    } catch {
      return;
    }
    const task = { controller: new AbortController(), token: {} };
    flight.current = task;
    setPhase(nextPhase);
    setError(undefined);
    void guard
      .run(
        () => operation(task),
        (cause) => {
          try {
            current(task);
            setError(cause);
          } catch {
            /* Security disposal publishes nothing. */
          }
        },
        () => {},
      )
      .finally(() => {
        if (flight.current === task) {
          flight.current = undefined;
          if (mounted.current) setPhase("idle");
        }
      });
  };
  const get = async (task: NonNullable<typeof flight.current>) => {
    current(task);
    const bytes = await readPolicyExport({
      signal: task.controller.signal,
      assertCurrent: () => current(task),
    });
    current(task);
    return parseCurrentExport(bytes);
  };
  const refreshList = async (task: NonNullable<typeof flight.current>) => {
    current(task);
    // Retire an already admitted list observer request before fetching this
    // completion's list; invalidate(refetchType:none) alone does not cancel it.
    await cache.cancelQueries({ queryKey: ["governance", "policies"], exact: true });
    current(task);
    await cache.invalidateQueries({ queryKey: ["governance", "policies"], refetchType: "none" });
    current(task);
    const fresh = await apiClient.request(endpoints.domains.governance.policies.list, {
      signal: task.controller.signal,
      routeId: "governance.policies",
    });
    current(task);
    // Only the existing parsed list response enters its existing cache. The raw
    // export baseline (including exact-number metadata) never enters QueryCache.
    cache.setQueryData(["governance", "policies"], fresh);
  };
  const selectFile = (file: File) => {
    if (flight.current || completed.current || reconciliation.current) return;
    run("reading", async (task) => {
      selection.current = undefined;
      reviewed.current = undefined;
      setSelected(undefined);
      setReview(undefined);
      setReconciled(false);
      const bytes = await readImportFile(file, task.controller.signal);
      current(task);
      const next = parseImportFile(bytes, file.name);
      selection.current = next;
      setSelected(next);
    });
  };
  const prepare = (candidate: ImportSelection | undefined) => {
    if (!candidate || candidate !== selection.current || completed.current || reconciliation.current) return;
    try {
      access.assertWrite();
    } catch (cause) {
      setError(cause);
      return;
    }
    const approval = access.approval;
    const prefix = access.prefixKey;
    run("planning", async (task) => {
      reviewed.current = undefined;
      setReview(undefined);
      setReconciled(false);
      const baseline = await get(task);
      current(task);
      access.assertWrite();
      access.assertApproval(approval);
      access.assertPrefixes(prefix);
      if (selection.current !== candidate)
        throw new AppError("파일이 바뀌었습니다. 다시 검토하세요.", { kind: "aborted" });
      const result = await apiClient.request(endpoints.domains.governance.policyImport.apply, {
        body: candidate.body,
        query: { dry_run: "1" },
        signal: task.controller.signal,
        routeId: "governance.policies",
      });
      current(task);
      access.assertWrite();
      access.assertApproval(approval);
      access.assertPrefixes(prefix);
      const plan = confirmPolicyAck(result, candidate.body, true);
      const next = { selected: candidate, baseline, plan, approval, prefix };
      reviewed.current = next;
      setReview(next);
    });
  };
  const apply = (
    candidate: ImportReview,
    confirmation: { text: string; activation: boolean; removal: boolean; protected: boolean },
    confirmationCurrent: () => boolean,
  ) => {
    if (!confirmationCurrent()) return;
    if (
      completed.current ||
      reconciliation.current ||
      reviewed.current !== candidate ||
      selection.current !== candidate.selected
    )
      return;
    const impacts = importImpacts(candidate.selected.body, candidate.baseline);
    if (
      confirmation.text !== "정책 가져오기" ||
      (impacts.some((row) => row.activates) && !confirmation.activation) ||
      (impacts.some((row) => row.removed > 0) && !confirmation.removal) ||
      (protectedJson(candidate.selected.body, access.prefixes) && !confirmation.protected)
    )
      return;
    try {
      access.assertWrite();
      access.assertApproval(candidate.approval);
      access.assertPrefixes(candidate.prefix);
    } catch (cause) {
      setError(cause);
      return;
    }
    run("checking", async (task) => {
      const baseline = await get(task);
      current(task);
      access.assertWrite();
      access.assertApproval(candidate.approval);
      access.assertPrefixes(candidate.prefix);
      if (!confirmationCurrent())
        throw new AppError("확인 항목이 바뀌었습니다. 현재 항목을 다시 확인하세요.", { kind: "aborted" });
      if (
        reviewed.current !== candidate ||
        selection.current !== candidate.selected ||
        !samePolicies(baseline, candidate.baseline)
      ) {
        reviewed.current = undefined;
        setReview(undefined);
        return importProblem("현재 정책이 바뀌었습니다. 서버 계획부터 다시 검토하세요.");
      }
      setPhase("saving");
      reconciliation.current = candidate.baseline;
      setUnconfirmed(true);
      const response = await apiClient.request(endpoints.domains.governance.policyImport.apply, {
        body: candidate.selected.body,
        signal: task.controller.signal,
        routeId: "governance.policies",
      });
      current(task);
      // An already confirmed write is not converted to failure by write-scope withdrawal.
      const result = confirmPolicyAck(response, candidate.selected.body, false);
      completed.current = true;
      reconciliation.current = undefined;
      setUnconfirmed(false);
      setAck(result);
      setPhase("refreshing");
      try {
        await get(task);
        current(task);
        await refreshList(task);
        current(task);
        setRefreshFailed(false);
      } catch (cause) {
        current(task);
        setRefreshFailed(true);
        setError(cause);
      }
    });
  };
  const refresh = () =>
    run("refreshing", async (task) => {
      const fresh = await get(task);
      current(task);
      const original = reconciliation.current;
      if (original) {
        if (!samePolicies(original, fresh))
          return importProblem(
            "현재 내용이 이전 원본과 다릅니다. 적용 여부를 단정하지 말고 최신 내용을 확인하세요. 다시 보내기는 잠겨 있습니다.",
          );
        reconciliation.current = undefined;
        setUnconfirmed(false);
        reviewed.current = undefined;
        setReview(undefined);
        setReconciled(true);
      }
      if (completed.current) {
        await refreshList(task);
        current(task);
        setRefreshFailed(false);
      }
    });
  const backup = (confirmed: () => boolean) => {
    if (!confirmed()) return;
    run("exporting", async (task) => {
      const bytes = await readPolicyExport({
        signal: task.controller.signal,
        assertCurrent: () => current(task),
      });
      current(task);
      if (!confirmed()) return;
      // Validate the envelope without converting the original export download bytes.
      parseCurrentExport(bytes);
      downloadPolicyBytes(bytes, () => current(task));
    });
  };
  const edit = (candidate: ImportReview) => {
    if (flight.current || completed.current || reconciliation.current || reviewed.current !== candidate)
      return;
    try {
      owned();
    } catch {
      return;
    }
    reviewed.current = undefined;
    setReview(undefined);
  };
  return {
    selected,
    review,
    phase,
    error,
    ack,
    refreshFailed,
    unconfirmed,
    reconciled,
    pending: guard.pending || phase !== "idle",
    selectFile,
    prepare,
    apply,
    refresh,
    backup,
    edit,
    close: guard.requestClose,
  };
}
