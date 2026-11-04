import { Download } from "lucide-react";
import { useContext, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { tokenStore } from "@/shared/auth/token-store";
import { isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { downloadCsv } from "@/shared/utils/csv";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { loadProviderExport, providerExportCsv, type ProviderExportFilters } from "./provider-csv";

interface Props {
  filters: ProviderExportFilters;
  blocked: boolean;
}

export function ProviderExportControl({ filters, blocked }: Props): React.JSX.Element {
  const auth = useAuth();
  const feature = useContext(FeatureAccessContext);
  const epoch = useSyncExternalStore(tokenStore.subscribeSession, tokenStore.getSessionEpoch);
  const allowed =
    feature?.featureId === "gateway.providers" &&
    feature.permitted === true &&
    feature.status !== "legacy" &&
    feature.status !== "hidden" &&
    auth.user?.scopes.includes("admin:read") === true &&
    !blocked;
  const routingAllowed = auth.user?.scopes.includes("routing:read") === true;
  const owner = JSON.stringify([
    epoch,
    auth.mode,
    auth.user?.id,
    auth.user?.team_id,
    auth.user?.role,
    auth.user?.roles,
    auth.user?.scopes,
    feature,
    filters,
    blocked,
    auth.credentialPrefixes,
  ]);
  return (
    <ProviderExport
      key={owner}
      filters={filters}
      allowed={allowed}
      epoch={epoch}
      routingAllowed={routingAllowed}
      prefixes={auth.credentialPrefixes}
    />
  );
}

function ProviderExport({
  filters,
  allowed,
  epoch,
  routingAllowed,
  prefixes,
}: {
  filters: ProviderExportFilters;
  allowed: boolean;
  epoch: number;
  routingAllowed: boolean;
  prefixes: readonly string[];
}): React.JSX.Element {
  const mounted = useRef(false);
  const flight = useRef<AbortController | undefined>(undefined);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ error: boolean; message: string; requestId?: string }>();
  const description = useId();
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      flight.current?.abort();
    };
  }, []);
  const current = () => mounted.current && epoch === tokenStore.getSessionEpoch() && allowed;
  const run = async () => {
    if (!current() || flight.current) return;
    const controller = new AbortController();
    flight.current = controller;
    setPending(true);
    setNotice(undefined);
    try {
      const snapshot = await loadProviderExport(filters.range, routingAllowed, controller.signal);
      if (!current() || controller.signal.aborted) return;
      const result = providerExportCsv(snapshot, filters, prefixes, new Date().toISOString());
      if (result.count) downloadCsv("공급자-목록.csv", result.csv);
      setNotice({
        error: false,
        message: result.count
          ? `${result.count.toLocaleString("ko-KR")}개 공급자의 CSV 다운로드를 요청했습니다.`
          : "현재 필터에 맞는 공급자가 없어 파일을 만들지 않았습니다.",
      });
    } catch (cause) {
      controller.abort();
      if (current()) {
        const requestId = isAppError(cause) ? cause.requestId : undefined;
        setNotice({
          error: true,
          message: safeAppErrorMessage(cause, "목록을 내보내지 못했습니다. 다시 시도하세요."),
          requestId:
            requestId &&
            /^[A-Za-z0-9_-]{1,128}$/u.test(requestId) &&
            !containsPotentialSecret(requestId, prefixes)
              ? requestId
              : undefined,
        });
      }
    } finally {
      if (flight.current === controller) flight.current = undefined;
      if (mounted.current) setPending(false);
    }
  };
  return (
    <section className="provider-export" aria-label="공급자 목록 내보내기">
      <Button
        onClick={() => void run()}
        disabled={!allowed}
        aria-disabled={pending || undefined}
        aria-busy={pending || undefined}
        aria-describedby={description}
      >
        <Download aria-hidden="true" /> {pending ? "내보낼 목록 조회 중" : "CSV 내보내기"}
      </Button>
      <p id={description}>
        현재 필터·정렬의 전체 목록을 새로 조회합니다. 페이지 구분은 적용하지 않으며 설정·운영 상태는 각각
        조회한 값입니다.
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
