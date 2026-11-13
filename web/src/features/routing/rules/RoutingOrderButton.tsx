import { lazy, Suspense, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import { useRoutingOrderAccess, type RoutingOrderAccess } from "./routing-order-access";

const OrderDialog = lazy(() =>
  import("./RoutingOrderDialog").then((module) => ({ default: module.RoutingOrderDialog })),
);
export function RoutingOrderButton({ canWrite }: { canWrite: boolean }) {
  const access = useRoutingOrderAccess(canWrite);
  if (!access.supported) return null;
  return <OrderButton key={access.key} access={access} />;
}
function OrderButton({ access }: { access: RoutingOrderAccess }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <Button
        ref={trigger}
        disabled={!access.write.allowed}
        title={access.reason}
        onClick={() => {
          try {
            access.assertApproval(access.approval);
            setOpen(true);
          } catch {
            /* Retired trigger. */
          }
        }}
      >
        규칙 순서 변경
      </Button>
      {open && access.readable && access.supported ? (
        <Suspense fallback={<p role="status">순서 편집기를 불러오는 중입니다…</p>}>
          <OrderDialog access={access} onClose={() => setOpen(false)} returnFocusRef={trigger} />
        </Suspense>
      ) : null}
    </>
  );
}
