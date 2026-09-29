import type { ComponentPropsWithoutRef } from "react";

import { useObserveLegacyOpen } from "@/shared/telemetry/legacy-observation";

/** Observation must never prevent normal anchor navigation, including keyboard use. */
export function LegacyLink({
  onClick,
  onAuxClick,
  ...props
}: ComponentPropsWithoutRef<"a">): React.JSX.Element {
  const observe = useObserveLegacyOpen();
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && event.button === 0) observe?.();
      }}
      onAuxClick={(event) => {
        onAuxClick?.(event);
        if (!event.defaultPrevented && event.button === 1) observe?.();
      }}
    />
  );
}
