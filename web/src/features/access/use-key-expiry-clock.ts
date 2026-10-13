import { useEffect, useState } from "react";
import type { ApiKeyPublic } from "@/shared/api/domains/access.schemas";
import { keyDeadline } from "./key-lifecycle";

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
      const next = Math.min(...keys.map(keyDeadline).filter((at) => at > current));
      if (Number.isFinite(next)) timer = setTimeout(update, Math.min(next - current, 86_400_000));
    };
    const current = Date.now();
    const deadlines = keys.map(keyDeadline);
    // Loading an ordinary key catalog must not replace table controls between
    // pointer-down and click. Only publish a new clock value at a deadline.
    const crossed = deadlines.some((at) => at > now && at <= current);
    const next = Math.min(...deadlines.filter((at) => at > current));
    if (crossed) timer = setTimeout(update, 0);
    else if (!document.hidden && Number.isFinite(next))
      timer = setTimeout(update, Math.min(next - current, 86_400_000));
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [keys, now]);
  return now;
}
