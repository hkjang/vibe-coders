import { lazy, Suspense, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";

const Dialog = lazy(() =>
  import("./ConsoleDiagnosticsDialog").then((module) => ({ default: module.ConsoleDiagnosticsDialog })),
);

export function ConsoleDiagnosticsLauncher(): React.JSX.Element | null {
  const auth = useAuth();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (!versionAtLeast(auth.backendVersion, "v0.86.180")) return null;
  return (
    <SectionCard
      title="콘솔 오류 관측"
      description="API 오류와 화면 오류의 발생 위치·분류·요청 ID를 확인합니다."
    >
      <Button ref={trigger} onClick={() => setOpen(true)}>
        오류 관측 열기
      </Button>
      {open ? (
        <Suspense fallback={<p role="status">오류 관측 화면을 불러오는 중입니다.</p>}>
          <Dialog onClose={() => setOpen(false)} returnFocusRef={trigger} />
        </Suspense>
      ) : null}
    </SectionCard>
  );
}
