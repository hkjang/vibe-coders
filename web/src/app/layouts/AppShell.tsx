import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Menu, MonitorCog, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link, Outlet, useLocation } from "react-router";

import { useAuth } from "@/app/auth/AuthProvider";
import { CommandPalette } from "@/app/layouts/CommandPalette";
import { Sidebar } from "@/app/layouts/Sidebar";
import { featureByPath } from "@/config/migration-registry";
import { healthStatusLabels, preferenceLabels, roleLabel, uiLabels } from "@/config/ui-labels";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { Badge } from "@/shared/components/ui/Badge";
import { Button } from "@/shared/components/ui/Button";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import {
  usePreferences,
  type DensityPreference,
  type RefreshInterval,
  type ThemePreference,
} from "@/shared/stores/preferences";

const refreshValues = new Set([0, 60, 300]);

export function AppShell(): React.JSX.Element {
  const auth = useAuth();
  const location = useLocation();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const mobileMenuTriggerRef = useRef<HTMLButtonElement>(null);
  const theme = usePreferences((state) => state.theme);
  const density = usePreferences((state) => state.density);
  const refreshInterval = usePreferences((state) => state.refreshInterval);
  const setTheme = usePreferences((state) => state.setTheme);
  const setDensity = usePreferences((state) => state.setDensity);
  const setRefreshInterval = usePreferences((state) => state.setRefreshInterval);
  const setMobileSidebarOpen = usePreferences((state) => state.setMobileSidebarOpen);
  const currentFeature = featureByPath(location.pathname, auth.features);
  const showBreadcrumbGroup = currentFeature && currentFeature.group !== currentFeature.title;
  const showLegacyAdmin = canOpenLegacyAdmin(auth);

  const health = useQuery({
    queryKey: ["gateway", "health"],
    queryFn: ({ signal }) => apiClient.request(endpoints.health, { signal, routeId: "shell" }),
    staleTime: 10_000,
    refetchInterval: refreshInterval ? refreshInterval * 1_000 : false,
    refetchIntervalInBackground: false,
  });
  const healthState = health.isError
    ? health.data
      ? "degraded"
      : "disconnected"
    : health.data?.status === "ok"
      ? "healthy"
      : "checking";
  const healthLabel = healthStatusLabels[healthState];
  const healthTone =
    healthState === "healthy"
      ? "success"
      : healthState === "degraded"
        ? "warning"
        : healthState === "disconnected"
          ? "danger"
          : "muted";

  useEffect(() => {
    const openPalette = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", openPalette);
    return () => window.removeEventListener("keydown", openPalette);
  }, []);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">
        본문으로 건너뛰기
      </a>
      <Sidebar mobileTriggerRef={mobileMenuTriggerRef} />
      <div className="app-column">
        <header className="app-header">
          <Button
            ref={mobileMenuTriggerRef}
            className="mobile-menu-button"
            size="icon"
            variant="ghost"
            onClick={() => setMobileSidebarOpen(true)}
            aria-label="탐색 메뉴 열기"
          >
            <Menu aria-hidden="true" />
          </Button>
          <nav className="breadcrumb" aria-label="현재 위치">
            <Link to="/overview">Vibe Coders</Link>
            <span aria-hidden="true">/</span>
            {showBreadcrumbGroup ? (
              <>
                <span>{currentFeature.group}</span>
                <span aria-hidden="true">/</span>
              </>
            ) : null}
            {currentFeature ? (
              <strong aria-current="page">{currentFeature.title}</strong>
            ) : (
              <strong aria-current="page">{uiLabels.console}</strong>
            )}
          </nav>

          <button
            className="header-search"
            onClick={() => setPaletteOpen(true)}
            aria-label="명령 팔레트 열기"
          >
            <Search aria-hidden="true" />
            <span>검색</span>
            <kbd>⌘K</kbd>
          </button>

          <div className="header-controls">
            <Badge tone={healthTone}>
              <span className="status-dot" aria-hidden="true" />
              {healthLabel}
            </Badge>
            <label className="compact-select">
              <span className="sr-only">자동 새로고침 간격</span>
              <select
                value={refreshInterval}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  if (refreshValues.has(value)) setRefreshInterval(value as RefreshInterval);
                }}
              >
                <option value={0}>자동 갱신 끔</option>
                <option value={60}>1분</option>
                <option value={300}>5분</option>
              </select>
            </label>
            <details className="preference-menu">
              <summary aria-label="화면 표시 설정">
                <MonitorCog aria-hidden="true" />
              </summary>
              <div className="popover-card">
                <label>
                  {preferenceLabels.theme}
                  <select value={theme} onChange={(event) => setTheme(event.target.value as ThemePreference)}>
                    <option value="light">{preferenceLabels.light}</option>
                    <option value="dark">{preferenceLabels.dark}</option>
                    <option value="system">{preferenceLabels.system}</option>
                  </select>
                </label>
                <label>
                  {preferenceLabels.density}
                  <select
                    value={density}
                    onChange={(event) => setDensity(event.target.value as DensityPreference)}
                  >
                    <option value="compact">{preferenceLabels.compact}</option>
                    <option value="default">{preferenceLabels.default}</option>
                    <option value="comfortable">{preferenceLabels.comfortable}</option>
                  </select>
                </label>
              </div>
            </details>
            {showLegacyAdmin ? (
              <a className="header-legacy" href="/admin">
                기존 화면 <ExternalLink aria-hidden="true" />
              </a>
            ) : null}
            <details className="user-menu">
              <summary aria-label="사용자 메뉴">
                <span className="avatar" aria-hidden="true">
                  {(auth.user?.name ?? auth.user?.email ?? "A").slice(0, 1).toUpperCase()}
                </span>
              </summary>
              <div className="popover-card user-card">
                <strong>{auth.user?.name ?? auth.user?.email ?? uiLabels.legacyAdministrator}</strong>
                <span>역할: {roleLabel(auth.user?.role)}</span>
                <span>팀: {auth.user?.team_id || "-"}</span>
                <span>백엔드 {auth.backendVersion}</span>
                <span>UI {auth.uiVersion}</span>
                <span>API {auth.apiVersion}</span>
                {showLegacyAdmin ? (
                  <a className="button button-secondary button-default" href="/admin">
                    {uiLabels.legacyAdmin} 열기 <ExternalLink aria-hidden="true" />
                  </a>
                ) : null}
                <Button variant="secondary" onClick={() => void auth.logout()}>
                  로그아웃
                </Button>
              </div>
            </details>
          </div>
        </header>
        <main className="app-main" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
