import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/shared/components/ui/Button";

interface CopyButtonProps {
  label?: string;
  size?: "default" | "icon" | "small";
  value: string;
}

/** Copies `value` to the clipboard and confirms briefly; degrades quietly without clipboard access. */
export function CopyButton({ label = "복사", size = "small", value }: CopyButtonProps): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Button
      size={size}
      variant="ghost"
      aria-label={size === "icon" ? label : undefined}
      onClick={() => {
        void navigator.clipboard
          ?.writeText(value)
          .then(() => setCopied(true))
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
      {size === "icon" ? null : copied ? "복사됨" : label}
    </Button>
  );
}
