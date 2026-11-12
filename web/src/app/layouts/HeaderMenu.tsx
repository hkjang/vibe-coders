import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useLocation } from "react-router";

/** Native disclosure semantics with predictable keyboard and outside dismissal. */
export function HeaderMenu({
  className,
  label,
  icon,
  children,
  menuRef,
}: {
  className: string;
  label: string;
  icon: ReactNode;
  children: ReactNode;
  menuRef?: RefObject<HTMLDetailsElement | null>;
}) {
  const localRef = useRef<HTMLDetailsElement>(null);
  const ref = menuRef ?? localRef;
  const { pathname } = useLocation();
  useEffect(() => {
    if (ref.current) ref.current.open = false;
  }, [pathname, ref]);
  useEffect(() => {
    const dismissOutside = (event: Event) => {
      const menu = ref.current;
      if (menu?.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
    };
    const dismissEscape = (event: KeyboardEvent) => {
      const menu = ref.current;
      if (!menu?.open || event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      menu.open = false;
      menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("focusin", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("focusin", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, [ref]);
  return (
    <details ref={ref} className={className} name="console-header-menu">
      <summary aria-label={label} title={label}>
        {icon}
      </summary>
      {children}
    </details>
  );
}
