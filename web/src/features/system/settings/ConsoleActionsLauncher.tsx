import { lazy, Suspense, useRef, useState } from "react";
import { useAuth } from "@/app/auth/AuthProvider";
import { versionAtLeast } from "@/config/migration-registry";
import { Button } from "@/shared/components/ui/Button";
import { SectionCard } from "@/shared/components/ui/SectionCard";
const Dialog = lazy(() =>
  import("./ConsoleActionsDialog").then((module) => ({ default: module.ConsoleActionsDialog })),
);
export function ConsoleActionsLauncher(): React.JSX.Element | null {
  const auth = useAuth(),
    trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!versionAtLeast(auth.backendVersion, "v0.86.181")) return null;
  return (
    <SectionCard
      title="콘솔 작업 결과"
      description="저장·삭제·승인 등 작업의 완료율과 확인되지 않은 결과를 살펴봅니다."
    >
      <Button ref={trigger} onClick={() => setOpen(true)}>
        작업 결과 열기
      </Button>
      {open ? (
        <Suspense fallback={<p role="status">작업 결과 화면을 불러오는 중입니다.</p>}>
          <Dialog onClose={() => setOpen(false)} returnFocusRef={trigger} />
        </Suspense>
      ) : null}
    </SectionCard>
  );
}
