import { useLayoutEffect, useRef, useState } from "react";
import { Button } from "@/shared/components/ui/Button";
import { PolicyImportDialog } from "./PolicyImportDialog";
import { usePolicyImportAccess, type PolicyImportAccess } from "./policy-import-access";

function Entry({ access }: { access: PolicyImportAccess }) {
  const [open, setOpen] = useState(false);
  const mounted = useRef(false);
  const selected = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      selected.current = false;
    };
  }, []);
  return (
    <>
      <Button
        ref={trigger}
        disabled={!access.read}
        onClick={() => {
          try {
            access.assertRead();
            if (!mounted.current || selected.current) return;
          } catch {
            return;
          }
          selected.current = true;
          setOpen(true);
        }}
      >
        정책 가져오기
      </Button>
      {open ? (
        <PolicyImportDialog
          access={access}
          returnFocusRef={trigger}
          close={() => {
            if (!mounted.current) return;
            selected.current = false;
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
export function PolicyImportEntry({ canWrite }: { canWrite: boolean }) {
  const access = usePolicyImportAccess(canWrite);
  return <Entry key={JSON.stringify([access.key, access.read])} access={access} />;
}
