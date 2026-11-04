import { useQueryClient } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useId, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { assertFeatureRead, type FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { downloadCsv } from "@/shared/utils/csv";
import { modelOwnedKey, useModelReadOwner } from "./model-read-owner";
import { loadModelExport, modelExportCsv, type ModelExportFilters } from "./model-csv";

let exportSequence = 0;
interface Props {
  filters: ModelExportFilters;
  blocked: boolean;
}

export function ModelExportControl({ filters, blocked }: Props): React.JSX.Element {
  const { credentialPrefixes } = useAuth();
  const owner = useModelReadOwner();
  return (
    <ModelExport
      key={JSON.stringify([owner.id, filters, blocked, credentialPrefixes])}
      filters={filters}
      blocked={blocked}
      owner={owner}
      prefixes={credentialPrefixes}
    />
  );
}

function ModelExport({
  filters,
  blocked,
  owner,
  prefixes,
}: Props & { owner: FeatureReadOwner; prefixes: readonly string[] }): React.JSX.Element {
  const client = useQueryClient();
  const mounted = useRef(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string; requestId?: string }>();
  const description = useId();
  const allowed = owner.readable && !owner.denied && !blocked;
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
    };
  }, []);
  const current = () => mounted.current && owner.isCurrent() && !blocked;
  const run = async () => {
    if (!current() || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    const queryKey = modelOwnedKey(["admin", "models", "export", ++exportSequence], owner);
    setPending(true);
    setNotice(undefined);
    try {
      const snapshot = await client.fetchQuery({
        queryKey,
        staleTime: 0,
        gcTime: 0,
        retry: false,
        queryFn: async ({ signal }) => {
          const combined = AbortSignal.any([signal, controller.signal]);
          assertFeatureRead(owner, combined);
          const result = await loadModelExport(filters.range, combined);
          assertFeatureRead(owner, combined);
          return result;
        },
      });
      if (!current() || controller.signal.aborted) return;
      const result = modelExportCsv(snapshot, filters, prefixes, new Date().toISOString());
      if (result.count) downloadCsv("모델-목록.csv", result.csv);
      setNotice({
        error: false,
        message: result.count
          ? `${result.count.toLocaleString("ko-KR")}개 모델의 CSV 다운로드를 요청했습니다.${result.partial ? " 부분 응답 또는 이전 데이터가 포함되어 있습니다." : ""}`
          : `현재 수신 결과에 필터와 일치하는 모델이 없어 파일을 만들지 않았습니다.${result.partial ? " 일부 목록이 누락되거나 이전 데이터일 수 있습니다." : ""}`,
      });
    } catch (cause) {
      controller.abort();
      if (current()) {
        const requestId = isAppError(cause) ? cause.requestId : undefined;
        setNotice({
          error: true,
          message: safeAppErrorMessage(cause, "모델 목록을 내보내지 못했습니다. 다시 시도하세요."),
          requestId:
            requestId &&
            /^[A-Za-z0-9_-]{1,128}$/u.test(requestId) &&
            !containsPotentialSecret(requestId, prefixes)
              ? requestId
              : undefined,
        });
      }
    } finally {
      client.removeQueries({ queryKey, exact: true });
      if (flight.current === controller) flight.current = undefined;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section className="provider-export" aria-label="모델 목록 내보내기">
      <Button
        onClick={() => void run()}
        disabled={!allowed}
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        aria-describedby={description}
      >
        <Download aria-hidden="true" /> {pending ? "내보낼 모델 조회 중" : "CSV 내보내기"}
      </Button>
      <p id={description}>
        적용된 필터·정렬의 최신 수신 목록을 내보냅니다. 페이지 구분은 적용하지 않습니다. 목록·품질·가격·지침은
        각각 조회하며, 공급자 오류나 응답 제한으로 전체 모델이 포함되지 않을 수 있습니다. 민감한 값은
        가립니다.
      </p>
      {notice ? (
        <InlineNotice className="provider-export-notice" tone={notice.error ? "danger" : "info"}>
          {notice.message}
          {notice.requestId ? <p>요청 ID: {notice.requestId}</p> : null}
        </InlineNotice>
      ) : null}
    </section>
  );
}
