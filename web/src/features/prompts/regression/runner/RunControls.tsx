import { useRef, useState } from "react";
import { Play } from "lucide-react";
import { Button } from "@/shared/components/ui/Button";
import type { FeatureReadOwner } from "@/shared/hooks/use-feature-read-owner";
import { RunDialog } from "./RunDialog";
import { RunResults } from "./RunResults";
import type { RunCatalog, RunReceipt } from "./run-model";
import "./run.css";

export function RunControls({
  owner,
  catalog,
  refresh,
  disabled,
  allowed,
}: {
  owner: FeatureReadOwner;
  catalog: RunCatalog;
  refresh: () => Promise<RunCatalog>;
  disabled: boolean;
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [receipt, setReceipt] = useState<RunReceipt>();
  const [showResult, setShowResult] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  return (
    <>
      {allowed ? (
        <Button
          disabled={disabled || !catalog.rows.length || !catalog.revisions}
          title={!catalog.revisions ? "서버의 실행 검토 기능을 확인한 뒤 사용할 수 있습니다." : undefined}
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            setShowResult(false);
            setOpen(true);
          }}
        >
          <Play aria-hidden="true" /> 회귀 검사 실행
        </Button>
      ) : null}
      {receipt ? (
        <Button
          onClick={(event) => {
            returnFocusRef.current = event.currentTarget;
            setShowResult(true);
          }}
        >
          이번 실행 결과
        </Button>
      ) : null}
      {open ? (
        <RunDialog
          owner={owner}
          catalog={catalog}
          refresh={refresh}
          returnFocusRef={returnFocusRef}
          close={() => setOpen(false)}
          received={(value) => {
            setReceipt(value);
            setShowResult(true);
          }}
        />
      ) : null}
      {!open && showResult && receipt ? (
        <RunResults receipt={receipt} returnFocusRef={returnFocusRef} close={() => setShowResult(false)} />
      ) : null}
    </>
  );
}
