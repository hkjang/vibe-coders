import { useEffect, useState } from "react";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { meKeyDeadline } from "./me-key-lifecycle";

// Local deadline updates require no API polling, including while a refresh is paused.
export function useKeyExpiryClock(keys: readonly ApiKeyPublic[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const update = () => {
      clearTimeout(timer);
      const current = Date.now();
      setNow(current);
      if (document.hidden) return;
      const next = Math.min(...keys.map(meKeyDeadline).filter((at) => at > current));
      if (Number.isFinite(next)) timer = setTimeout(update, Math.min(next - current, 86_400_000));
    };
    timer = setTimeout(update, 0);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [keys]);
  return now;
}
