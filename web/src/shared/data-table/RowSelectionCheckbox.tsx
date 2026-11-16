import { useLayoutEffect, useRef } from "react";
import { Checkbox } from "@/shared/components/ui/Checkbox";

export function RowSelectionCheckbox({
  label,
  checked,
  mixed = false,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  mixed?: boolean;
  disabled: boolean;
  onChange: () => void;
}): React.JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    if (input.current) input.current.indeterminate = mixed;
  }, [mixed]);
  return (
    <Checkbox
      ref={input}
      label={<span className="sr-only">{label}</span>}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
