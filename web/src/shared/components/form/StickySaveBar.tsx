import { useLayoutEffect, useRef, type ReactNode } from "react";
import "./sticky-save-bar.css";

const messages = {
  pending: "설정 요청을 처리하고 있습니다.",
  dirty: "저장하지 않은 변경사항이 있습니다.",
  clean: "새 변경사항이 없습니다.",
};

/** Keep the caller's real submit buttons, permission checks and confirmation flow in its form. */
export function StickySaveBar({
  label,
  dirty,
  pending,
  children,
}: {
  label: string;
  dirty: boolean;
  pending: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current;
    const form = bar?.closest("form");
    if (!bar || !form) return;
    const previous = form.style.getPropertyValue("--save-bar-height");
    const measure = () => {
      form.style.setProperty("--save-bar-height", `${bar.getBoundingClientRect().height}px`);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    observer?.observe(bar);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      if (previous) form.style.setProperty("--save-bar-height", previous);
      else form.style.removeProperty("--save-bar-height");
    };
  }, []);

  return (
    <div ref={ref} className="sticky-save-bar" role="group" aria-label={label}>
      <p role="status">{pending ? messages.pending : dirty ? messages.dirty : messages.clean}</p>
      <div className="sticky-save-bar-actions">{children}</div>
    </div>
  );
}
