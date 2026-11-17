import { useLayoutEffect, useRef, useState } from "react";
import { isAppError } from "@/shared/api/error";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { downloadText } from "@/shared/utils/csv";
import { readAuditCsv } from "./audit-export";

export function useAuditCsvDownload(owner: FeatureReadOwner) {
  const controller = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [complete, setComplete] = useState(false);
  useLayoutEffect(
    () => () => {
      controller.current?.abort();
      controller.current = undefined;
    },
    [owner],
  );

  const cancel = () => {
    controller.current?.abort();
    controller.current = undefined;
    setPending(false);
  };
  const start = async () => {
    if (controller.current || !owner.isCurrent()) return;
    const task = new AbortController();
    controller.current = task;
    setPending(true);
    setError(undefined);
    setComplete(false);
    try {
      assertFeatureRead(owner, task.signal);
      const csv = await readAuditCsv(task.signal);
      assertFeatureRead(owner, task.signal);
      if (controller.current !== task) return;
      // Response.text() may consume the UTF-8 BOM. Include exactly one for Excel.
      downloadText(
        `audit-${new Date().toISOString().slice(0, 10)}.csv`,
        `\uFEFF${csv.replace(/^\uFEFF/u, "")}`,
        "text/csv;charset=utf-8",
      );
      setComplete(true);
    } catch (failure) {
      if (
        controller.current === task &&
        owner.isCurrent() &&
        !task.signal.aborted &&
        !(isAppError(failure) && failure.kind === "aborted")
      )
        setError(failure);
    } finally {
      if (controller.current === task) {
        controller.current = undefined;
        if (owner.isCurrent()) setPending(false);
      }
    }
  };
  return { pending, error, complete, start, cancel };
}
