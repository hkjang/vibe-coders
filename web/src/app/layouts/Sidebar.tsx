import * as Dialog from "@radix-ui/react-dialog";
import { ChevronDown, ChevronLeft, ChevronRight, X } from "lucide-react";
import { Fragment, useEffect, useMemo, type RefObject } from "react";
import { NavLink } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { featurePath, resolveFeature } from "@/config/migration-registry";
import { navigationGroups } from "@/config/navigation";
import { migrationStatusLabels, uiLabels } from "@/config/ui-labels";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { usePreferences } from "@/shared/stores/preferences";

interface SidebarProps {
  mobileTriggerRef: RefObject<HTMLButtonElement | null>;
}

export function Sidebar({ mobileTriggerRef }: SidebarProps): React.JSX.Element {
  const { user, backendVersion, features, legacyFallback } = useAuth();
  const collapsed = usePreferences((state) => state.sidebarCollapsed);
  const mobileOpen = usePreferences((state) => state.mobileSidebarOpen);
  const collapsedGroups = usePreferences((state) => state.collapsedGroups);
  const toggleSidebar = usePreferences((state) => state.toggleSidebar);
  const setMobileOpen = usePreferences((state) => state.setMobileSidebarOpen);
  const toggleGroup = usePreferences((state) => state.toggleGroup);

  const available = useMemo(
    () =>
      features
        .map((feature) => ({
          feature,
          effective: resolveFeature(feature, user, backendVersion, { legacyFallback }),
        }))
        .filter(({ effective }) => effective.permitted && effective.status !== "hidden"),
    [backendVersion, features, legacyFallback, user],
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 63.9375rem)");
    const closeOnDesktop = (event: MediaQueryListEvent): void => {
      if (!event.matches) setMobileOpen(false);
    };
    query.addEventListener("change", closeOnDesktop);
    return () => query.removeEventListener("change", closeOnDesktop);
  }, [setMobileOpen]);

  const content = (mobile: boolean): React.JSX.Element => (
    <>
      {mobile ? (
        <>
          <Dialog.Title className="sr-only">주 메뉴</Dialog.Title>
          <Dialog.Description className="sr-only">도메인별 관리 화면으로 이동합니다.</Dialog.Description>
        </>
      ) : null}
      <div className="sidebar-brand">
        <span className="brand-mark" aria-hidden="true">
          V
        </span>
        <span className="sidebar-brand-copy">
          <strong>Vibe Coders</strong>
          <small>{uiLabels.nextConsole}</small>
        </span>
        {mobile ? (
          <Dialog.Close asChild>
            <Button className="sidebar-mobile-close" size="icon" variant="ghost" aria-label="탐색 메뉴 닫기">
              <X aria-hidden="true" />
            </Button>
          </Dialog.Close>
        ) : null}
      </div>

      <nav className="sidebar-nav" aria-label={mobile ? "모바일 주 메뉴" : undefined}>
        {navigationGroups.map((group) => {
          const items = available.filter(({ feature }) => feature.group === group);
          if (!items.length) return null;
          const groupCollapsed = collapsedGroups.includes(group);
          return (
            <Fragment key={group}>
              <button
                className="sidebar-group"
                onClick={() => toggleGroup(group)}
                aria-expanded={!groupCollapsed}
                title={!mobile && collapsed ? group : undefined}
              >
                <span>{group}</span>
                <ChevronDown aria-hidden="true" data-collapsed={groupCollapsed} />
              </button>
              {!groupCollapsed ? (
                <ul>
                  {items.map(({ feature, effective }) => (
                    <li key={feature.featureId}>
                      <NavLink
                        to={featurePath(feature)}
                        title={!mobile && collapsed ? feature.title : undefined}
                        onClick={() => {
                          if (mobile) setMobileOpen(false);
                        }}
                      >
                        <span className="nav-icon" aria-hidden="true">
                          {feature.title.slice(0, 1)}
                        </span>
                        <span className="nav-copy">{feature.title}</span>
                        {effective.status !== "stable" ? (
                          <Badge tone={effective.status === "legacy" ? "warning" : "info"}>
                            {migrationStatusLabels[effective.status]}
                          </Badge>
                        ) : null}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Fragment>
          );
        })}
      </nav>

      {!mobile ? (
        <div className="sidebar-footer">
          <Button
            variant="ghost"
            onClick={toggleSidebar}
            aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
          >
            {collapsed ? <ChevronRight aria-hidden="true" /> : <ChevronLeft aria-hidden="true" />}
            <span className="nav-copy">사이드바 접기</span>
          </Button>
        </div>
      ) : null}
    </>
  );

  return (
    <>
      <aside className="app-sidebar app-sidebar-desktop" data-collapsed={collapsed} aria-label="주 메뉴">
        {content(false)}
      </aside>
      <Dialog.Root open={mobileOpen} onOpenChange={setMobileOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="sidebar-scrim" />
          <Dialog.Content
            asChild
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              mobileTriggerRef.current?.focus();
            }}
          >
            <aside className="app-sidebar app-sidebar-mobile">{content(true)}</aside>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
