import { useEffect, useRef, useState } from "react";
import { ClipboardCopy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/components/ui/Button";
import { useLibraryOwner } from "./library-context";
import { hiddenLibraryText } from "./library-model";

export function LibraryCopyButton({ value }: { value: string }) {
  const owner = useLibraryOwner();
  const mounted = useRef(true);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (
    <Button
      disabled={!value || pending || value.includes(hiddenLibraryText)}
      onClick={() => {
        if (!owner.isCurrent() || pending) return;
        setPending(true);
        void Promise.resolve()
          .then(() => navigator.clipboard.writeText(value))
          .then(() => {
            if (mounted.current && owner.isCurrent()) toast.success("본문을 복사했습니다.");
          })
          .catch(() => {
            if (mounted.current && owner.isCurrent())
              toast.error("본문을 복사하지 못했습니다.", { duration: Infinity });
          })
          .finally(() => {
            if (mounted.current) setPending(false);
          });
      }}
    >
      <ClipboardCopy aria-hidden="true" /> 본문 복사
    </Button>
  );
}
