import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import { appRequestsContractHeaders } from "@/shared/api/app-request-contract";
import type { AppRequestSummary, AppRequestsQuery } from "@/shared/api/schemas";
import type { TraceSafeFlowAccess } from "../traces/trace-safe-flow-access";

export const requestSelectionIdentity = (request: AppRequestSummary) =>
  JSON.stringify([request.request_ref, request.created_at]);

export function useRequestSafeFlowSelection(
  query: AppRequestsQuery,
  access: TraceSafeFlowAccess,
  interval: number | false,
) {
  const client = useQueryClient();
  const lifetime = useId();
  const generation = useRef(0);
  const selectionSerial = useRef(0);
  const identity = JSON.stringify(query);
  const [queryLife, setQueryLife] = useState({ identity, serial: 0 });
  if (queryLife.identity !== identity) setQueryLife({ identity, serial: queryLife.serial + 1 });
  const serial = queryLife.serial;
  const key = useMemo(
    () => ["admin", "requests", "request-explorer", access.key, lifetime, serial, query],
    [access.key, lifetime, serial, query],
  );
  const [selected, setSelected] = useState<{
    identity: string;
    generation: number;
    serial: number;
    ordinal: number;
    request: AppRequestSummary;
  }>();
  const mounted = useRef(false);
  const latest = useRef({ identity, selected, serial });
  const result = useQuery({
    queryKey: key,
    enabled: access.readable,
    queryFn: async ({ signal }) => {
      access.assertRead();
      if (
        !mounted.current ||
        signal.aborted ||
        latest.current.serial !== serial ||
        latest.current.identity !== identity
      )
        throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      const response = await apiClient.request(endpoints.admin.requests, {
        headers: appRequestsContractHeaders,
        query,
        signal,
        routeId: "observability.requests",
      });
      access.assertRead();
      if (
        !mounted.current ||
        signal.aborted ||
        latest.current.serial !== serial ||
        latest.current.identity !== identity
      )
        throw new AppError("목록 조회가 취소되었습니다.", { kind: "aborted" });
      // A successful response is a new generation, even under a frozen clock or
      // TanStack structural sharing of byte-identical metadata.
      return { response, generation: ++generation.current };
    },
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[3] === access.key ? previous : undefined,
    staleTime: 10_000,
    gcTime: 0,
    refetchInterval: (state) =>
      selected || (state.state.status === "error" && !state.state.data) ? false : interval,
    refetchIntervalInBackground: false,
  });
  const validSelection = selected?.identity === identity && selected.generation === result.data?.generation;
  // Retirement is permanent: returning to a cached filter cannot revive a dialog.
  if (selected && !validSelection) setSelected(undefined);
  const activeSelected = validSelection ? selected : undefined;
  useLayoutEffect(() => {
    latest.current = { identity, selected: activeSelected, serial };
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(
    () => () => {
      void client.cancelQueries({ queryKey: key, exact: true });
    },
    [client, key],
  );
  const ready = access.readable && result.isSuccess && !result.isFetching && !result.isPlaceholderData;
  const assertReady = () => {
    access.assertRead();
    const current = client.getQueryState(key);
    if (
      !mounted.current ||
      latest.current.identity !== identity ||
      latest.current.serial !== serial ||
      !ready ||
      current?.status !== "success" ||
      current.fetchStatus !== "idle" ||
      current.isInvalidated ||
      current.data !== result.data
    )
      throw new AppError("현재 목록을 다시 확인하세요.", { kind: "aborted" });
  };
  const open = (request: AppRequestSummary, ordinal: number) => {
    try {
      assertReady();
    } catch {
      return false;
    }
    if (!result.data?.response.requests.includes(request)) return false;
    latest.current.selected = undefined;
    setSelected({
      identity,
      generation: result.data.generation,
      serial: ++selectionSerial.current,
      ordinal,
      request,
    });
    return true;
  };
  const assertSelected = () => {
    assertReady();
    if (!activeSelected || latest.current.selected !== activeSelected)
      throw new AppError("현재 요청을 다시 선택하세요.", { kind: "aborted" });
  };
  return {
    result,
    selected: activeSelected,
    ready,
    open,
    assertSelected,
    close: () => {
      latest.current.selected = undefined;
      setSelected(undefined);
    },
  };
}
