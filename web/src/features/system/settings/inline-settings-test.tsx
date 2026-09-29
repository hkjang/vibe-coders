import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render } from "@testing-library/react";
import { StrictMode, type PropsWithChildren, type ReactNode } from "react";

import type { KeycloakConfig, NotificationConfig } from "@/shared/api/domains/system.schemas";
import { UnsavedChangesProvider } from "@/shared/unsaved/UnsavedChangesProvider";

export const ssoConfig: KeycloakConfig = {
  enabled: true,
  issuer_url: "https://identity.example/realms/test",
  client_id: "console",
  client_secret_set: true,
  redirect_uri: "https://console.example/auth/callback",
  scopes: ["openid", "profile"],
  default_role: "viewer",
  role_claim: "roles",
  group_claim: "groups",
  allow_local_login: true,
  auto_login: false,
  role_map: { "external-admin": "admin" },
  version: 4,
  source: "db",
};
export const notificationConfig: NotificationConfig = {
  enabled: true,
  channel: "operations",
  webhook_url: "********",
  webhook_url_set: true,
  events: ["cost"],
  available_events: ["cost", "secret", "approval", "provider"],
};
export const roleOptions = [
  { value: "admin", label: "admin" },
  { value: "viewer", label: "viewer" },
];

export function setupInline(ui: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <StrictMode>
      <QueryClientProvider client={client}>
        <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
      </QueryClientProvider>
    </StrictMode>
  );
  return { ...render(ui, { wrapper }), client };
}

export function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Result>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}
