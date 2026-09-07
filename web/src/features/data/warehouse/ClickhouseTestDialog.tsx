import { useState, type RefObject } from "react";

import { apiClient } from "@/shared/api/client";
import type { ClickhouseTest } from "@/shared/api/domains/data.schemas";
import { endpoints } from "@/shared/api/endpoints";
import { isAppError } from "@/shared/api/error";
import { FormField } from "@/shared/components/form/FormField";
import { Button } from "@/shared/components/ui/Button";
import { Dialog } from "@/shared/components/ui/Dialog";
import { InlineNotice } from "@/shared/components/ui/InlineNotice";
import { Input } from "@/shared/components/ui/Input";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { formatNumber } from "@/shared/utils/format";

interface ClickhouseTestDialogProps {
  onOpenChange: (open: boolean) => void;
  open: boolean;
  returnFocusRef: RefObject<HTMLElement | null>;
}

const emptyOverrides = { url: "", user: "", password: "", database: "", table: "" };

/**
 * Connection check for ClickHouse. Overrides are write-only: they are sent once and
 * never stored, echoed back, or written to the URL.
 */
export function ClickhouseTestDialog({
  onOpenChange,
  open,
  returnFocusRef,
}: ClickhouseTestDialogProps): React.JSX.Element {
  const [overrides, setOverrides] = useState(emptyOverrides);
  const [result, setResult] = useState<ClickhouseTest | undefined>();
  const [error, setError] = useState<{ message: string; requestId?: string } | undefined>();
  const [pending, setPending] = useState(false);

  const close = (next: boolean): void => {
    if (!next) {
      setOverrides(emptyOverrides);
      setResult(undefined);
      setError(undefined);
    }
    onOpenChange(next);
  };

  const run = async (): Promise<void> => {
    setPending(true);
    setError(undefined);
    setResult(undefined);
    try {
      const body = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value.trim() !== ""));
      setResult(await apiClient.request(endpoints.domains.data.pipeline.testConnection, { body }));
    } catch (cause) {
      setError({
        message: safeAppErrorMessage(cause, "연결을 확인하지 못했습니다."),
        requestId: isAppError(cause) ? cause.requestId : undefined,
      });
    } finally {
      setPending(false);
    }
  };

  const field = (key: keyof typeof emptyOverrides, label: string, type = "text"): React.JSX.Element => (
    <FormField label={label} description="비우면 현재 설정값을 사용합니다.">
      {(control) => (
        <Input
          {...control}
          type={type}
          value={overrides[key]}
          autoComplete={type === "password" ? "new-password" : "off"}
          onChange={(event) => setOverrides((current) => ({ ...current, [key]: event.target.value }))}
        />
      )}
    </FormField>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!pending) close(next);
      }}
      returnFocusRef={returnFocusRef}
      title="ClickHouse 연결 테스트"
      description="현재 설정 또는 임시 값으로 접속을 확인합니다. 입력한 비밀번호는 저장하지 않습니다."
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)} disabled={pending}>
            닫기
          </Button>
          <Button variant="primary" onClick={() => void run()} disabled={pending}>
            {pending ? "확인 중" : "연결 테스트"}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        {field("url", "ClickHouse URL")}
        {field("user", "사용자")}
        {field("password", "비밀번호", "password")}
        {field("database", "데이터베이스")}
        {field("table", "테이블")}
      </div>
      {result ? (
        <InlineNotice
          tone={result.ok ? "success" : "danger"}
          title={result.ok ? "연결에 성공했습니다." : "연결에 실패했습니다."}
        >
          <p>{result.ok ? `응답 시간 ${formatNumber(result.latency_ms)}ms` : result.message}</p>
          {result.table_checked ? (
            <p>
              테이블 {result.table_checked}:{" "}
              {result.table_ok ? "확인됨" : (result.table_message ?? "확인 실패")}
            </p>
          ) : null}
        </InlineNotice>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error.message}
          {error.requestId ? <span className="request-id"> 요청 ID: {error.requestId}</span> : null}
        </p>
      ) : null}
    </Dialog>
  );
}
