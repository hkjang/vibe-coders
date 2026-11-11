import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";
import { useAuth } from "@/app/auth/AuthProvider";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { PromptSearchQuery } from "@/shared/api/domains/prompts";
import { Button } from "@/shared/components/ui/Button";
import { assertFeatureRead, featureOwnedKey } from "@/shared/hooks/use-feature-read-owner";
import { downloadCsv } from "@/shared/utils/csv";
import { useLibraryOwner } from "./library-context";
import { projectLibraryCsv } from "./library-csv";
import { libraryRouteId, safeLibraryError } from "./library-model";
import { validateLibraryQuery } from "./library-api";

export function LibraryCsvButton({ query }: { query: PromptSearchQuery }) {
  const owner = useLibraryOwner();
  const client = useQueryClient();
  const { credentialPrefixes } = useAuth();
  const [pending, setPending] = useState(false);
  const active = useRef(false);
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(
    () => () => {
      active.current = false;
      abort.current?.abort();
    },
    [],
  );
  const download = async () => {
    if (active.current || !owner.isCurrent()) return;
    active.current = true;
    setPending(true);
    const controller = new AbortController();
    abort.current = controller;
    const queryKey = featureOwnedKey(["prompts", "csv", query], owner);
    try {
      const csv = await client.fetchQuery({
        queryKey,
        retry: false,
        gcTime: 0,
        staleTime: 0,
        queryFn: async ({ signal }) => {
          try {
            assertFeatureRead(owner, signal);
            validateLibraryQuery(query, credentialPrefixes);
            const combined = AbortSignal.any([signal, controller.signal]);
            const response = await apiClient.request(endpoints.domains.prompts.exportCsv, {
              query,
              signal: combined,
              cache: "no-store",
              redirect: "error",
              routeId: libraryRouteId,
            });
            assertFeatureRead(owner, combined);
            return projectLibraryCsv(response, credentialPrefixes);
          } catch (error) {
            throw safeLibraryError(error, credentialPrefixes);
          }
        },
      });
      assertFeatureRead(owner, controller.signal);
      downloadCsv(`prompts-${new Date().toISOString().slice(0, 10)}`, csv);
      toast.success("검색 조건의 요청 메타데이터를 내보냈습니다.");
    } catch {
      if (active.current && owner.isCurrent())
        toast.error("CSV를 내보내지 못했습니다. 조회 권한과 검색 조건을 확인하세요.", { duration: Infinity });
    } finally {
      client.removeQueries({ queryKey, exact: true });
      if (active.current) {
        active.current = false;
        setPending(false);
      }
    }
  };
  return (
    <Button disabled={pending} onClick={() => void download()}>
      <Download aria-hidden="true" /> {pending ? "내보내는 중" : "CSV 다운로드"}
    </Button>
  );
}
