import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useLocation } from "react-router";

/** Keep a selected destination visible without moving focus or the main page. */
export function SidebarNavigation({
  children,
  mobile,
  collapsed,
  menuSignature,
}: {
  children: ReactNode;
  mobile: boolean;
  collapsed: boolean;
  menuSignature: string;
}) {
  const ref = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    const nav = ref.current;
    if (!nav) return;
    const revealCurrent = () => {
      if (!nav.clientHeight) return;
      const bounds = nav.getBoundingClientRect();
      const style = getComputedStyle(nav);
      const top = bounds.top + parseFloat(style.paddingTop || "0");
      const bottom = bounds.bottom - parseFloat(style.paddingBottom || "0");
      const active = [...nav.querySelectorAll<HTMLElement>('a[aria-current="page"]')]
        .map((link) => link.getBoundingClientRect())
        .filter((box) => box.height > 0);
      // A favorite and its grouped item may both be active. Respect whichever
      // is already visible instead of jumping to the other copy.
      if (active.some((box) => box.top >= top && box.bottom <= bottom)) return;
      const selected = active[0];
      if (!selected) return; // Deliberately collapsed groups stay collapsed.
      if (selected.top < top || selected.height > bottom - top) nav.scrollTop += selected.top - top;
      else if (selected.bottom > bottom) nav.scrollTop += selected.bottom - bottom;
    };
    revealCurrent();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(nav);
    return () => observer.disconnect();
    // Polling with unchanged menu metadata must not reset a user's scrolling.
  }, [pathname, collapsed, menuSignature]);
  return (
    <nav ref={ref} className="sidebar-nav" aria-label={mobile ? "모바일 주 메뉴" : undefined}>
      {children}
    </nav>
  );
}
