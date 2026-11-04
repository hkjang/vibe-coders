import { useLayoutEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { readChargebackCsv } from "@/shared/api/chargeback-csv";
import { isAppError } from "@/shared/api/error";
import {
  assertFeatureRead,
  featureOwnedKey,
  type FeatureReadOwner,
} from "@/shared/hooks/use-feature-read-owner";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { downloadText } from "@/shared/utils/csv";
import { finopsChargebackQueryKey } from "./finops-shared";

export function useChargebackExport(owner: FeatureReadOwner, month: string) {
  const client = useQueryClient();
  const active = useRef<AbortController | undefined>(undefined);
  const [downloading, setDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState<string>();
  useLayoutEffect(
    () => () => {
      active.current?.abort();
    },
    [],
  );
  const download = async () => {
    if (active.current || !owner.isCurrent()) return;
    const controller = new AbortController();
    active.current = controller;
    setDownloading(true);
    setDownloadError(undefined);
    try {
      await client.fetchQuery({
        queryKey: featureOwnedKey([...finopsChargebackQueryKey, "csv", month], owner),
        gcTime: 0,
        staleTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          const combined = AbortSignal.any([signal, controller.signal]);
          assertFeatureRead(owner, combined);
          const csv = await readChargebackCsv(month, combined);
          assertFeatureRead(owner, combined);
          downloadText(`chargeback-${month}.csv`, csv, "text/csv;charset=utf-8");
          return true;
        },
      });
    } catch (cause) {
      if (owner.isCurrent() && !controller.signal.aborted) {
        const requestId = isAppError(cause) ? cause.requestId : undefined;
        setDownloadError(
          `${safeAppErrorMessage(cause, "CSV를 내려받지 못했습니다.")}${requestId ? ` 요청 ID: ${requestId}` : ""}`,
        );
      }
    } finally {
      if (owner.isCurrent() && !controller.signal.aborted) setDownloading(false);
      if (active.current === controller) active.current = undefined;
    }
  };
  return { download, downloading, downloadError };
}
