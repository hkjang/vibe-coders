import { useQuery } from "@tanstack/react-query";
import { useId, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { AppError, isAppError } from "@/shared/api/error";
import { Button } from "@/shared/components/ui/Button";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { RequestComparisonResult } from "./RequestComparisonResult";
import { useTraceSafeFlowAccess, type TraceSafeFlowAccess } from "../traces/trace-safe-flow-access";
import { comparisonIdError, loadRequestComparison } from "./request-comparison";

interface Props {
  request: AppRequestSummary;
  assertSelected: () => void;
}

export function RequestComparePanel(props: Props): React.JSX.Element {
  const access = useTraceSafeFlowAccess("observability.requests");
  return (
    <Comparison
      key={JSON.stringify([access.key, access.prefixes, props.request.request_ref, props.request.created_at])}
      {...props}
      access={access}
    />
  );
}

function Comparison({
  request,
  assertSelected,
  access,
}: Props & { access: TraceSafeFlowAccess }): React.JSX.Element {
  const lifetime = useId();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const submissionSerial = useRef(0);
  const [other, setOther] = useState("");
  const [submitted, setSubmitted] = useState<{ id: string; serial: number }>();
  const [error, setError] = useState<string>();
  const latest = useRef(assertSelected);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    latest.current = assertSelected;
  });
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const assertCurrent = () => {
    access.assertRead();
    latest.current();
    if (!mounted.current) throw new AppError("비교 조회가 취소되었습니다.", { kind: "aborted" });
  };
  const diff = useQuery({
    enabled: access.readable && submitted !== undefined,
    queryKey: ["observability", "requests", "safe-comparison", access.key, lifetime, submitted],
    queryFn: ({ signal }) =>
      loadRequestComparison(request, submitted?.id ?? "", access.prefixes, signal, assertCurrent),
    retry: false,
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (diff.isFetching) return;
    try {
      assertCurrent();
    } catch {
      return;
    }
    const id = other.trim();
    const invalid = comparisonIdError(id, access.prefixes);
    if (invalid) {
      setSubmitted(undefined);
      setError(invalid);
      input.current?.focus();
      return;
    }
    setError(undefined);
    setSubmitted({ id, serial: ++submissionSerial.current });
  };
  if (!access.readable) return <p role="status">현재 요청 조회 권한을 확인하세요.</p>;
  const pair = diff.isSuccess && !diff.isFetching ? diff.data : undefined;
  const rawRequestId = isAppError(diff.error) ? diff.error.requestId : undefined;
  const requestId =
    rawRequestId &&
    /^[A-Za-z0-9_-]{1,128}$/u.test(rawRequestId) &&
    !containsPotentialSecret(rawRequestId, access.prefixes)
      ? rawRequestId
      : undefined;
  return (
    <section className="request-compare" aria-label="다른 요청과 비교">
      <h3>다른 요청과 비교</h3>
      <p>
        조회 가능한 두 요청의 운영 지표만 비교합니다. 프롬프트·응답 원문은 조회하지 않습니다. 두 조회는 동일
        시점의 원자적 스냅샷이 아닙니다.
      </p>
      <form className="request-compare-form" onSubmit={submit}>
        <label htmlFor={inputId}>비교할 요청 ID</label>
        <Input
          id={inputId}
          ref={input}
          maxLength={512}
          value={other}
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => {
            setOther(event.target.value);
            setError(undefined);
          }}
          placeholder="req_..."
        />
        <Button type="submit" aria-disabled={diff.isFetching || undefined}>
          비교
        </Button>
      </form>
      {error ? (
        <p id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
      {diff.isFetching ? <p role="status">두 요청의 운영 지표를 확인하는 중입니다.</p> : null}
      {diff.isError ? (
        <InlineNotice tone="warning" title="두 요청을 비교하지 못했습니다.">
          요청 ID와 조회 권한을 확인한 뒤 비교 버튼으로 다시 조회하세요.
          {requestId ? <p>요청 ID: {requestId}</p> : null}
        </InlineNotice>
      ) : null}
      {pair ? (
        <RequestComparisonResult
          key={submitted?.serial}
          left={pair.left}
          right={pair.right}
          prefixes={access.prefixes}
        />
      ) : null}
    </section>
  );
}
