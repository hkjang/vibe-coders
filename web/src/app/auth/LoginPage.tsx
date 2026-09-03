import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowUpRight, KeyRound } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { z } from "zod";

import { useAuth } from "@/app/auth/AuthProvider";
import { uiLabels } from "@/config/ui-labels";
import { tokenStore } from "@/shared/auth/token-store";
import { Button } from "@/shared/components/ui/Button";
import { safeAppErrorMessage } from "@/shared/errors/operational-messages";
import { canOpenLegacyAdmin } from "@/shared/permissions/legacy-admin";
import { safeReturnTo, stageSsoReturnTo } from "@/shared/utils/safe-return-to";

const loginSchema = z.object({
  email: z.email("올바른 이메일 주소를 입력하세요."),
  password: z.string().min(1, "비밀번호를 입력하세요."),
});

type LoginValues = z.input<typeof loginSchema>;

export function LoginPage(): React.JSX.Element {
  const auth = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [serverError, setServerError] = useState<string>();
  const [legacyToken, setLegacyToken] = useState(tokenStore.getLegacyToken());
  const returnTo = safeReturnTo(searchParams.get("return_to"));
  const form = useForm<LoginValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  if (auth.mode === "authenticated" || auth.mode === "legacy" || auth.mode === "open") {
    return <Navigate replace to={returnTo} />;
  }

  const submit = form.handleSubmit(async (values) => {
    setServerError(undefined);
    try {
      await auth.login(values.email, values.password);
      navigate(returnTo, { replace: true });
    } catch (error) {
      setServerError(safeAppErrorMessage(error, "로그인할 수 없습니다."));
    }
  });

  const startSso = (): void => {
    const loginUrl = new URL(auth.sso.login_url, window.location.origin);
    loginUrl.searchParams.set("return_to", stageSsoReturnTo(returnTo));
    window.location.assign(loginUrl.toString());
  };

  const saveLegacyToken = async (): Promise<void> => {
    setServerError(undefined);
    try {
      await auth.setLegacyToken(legacyToken);
      navigate(returnTo, { replace: true });
    } catch (error) {
      setServerError(safeAppErrorMessage(error, "기존 관리자 토큰을 확인할 수 없습니다."));
    }
  };

  return (
    <main className="login-page" id="main-content">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand brand-login">
          <span className="brand-mark" aria-hidden="true">
            V
          </span>
          <span>Vibe Coders</span>
        </div>
        <div>
          <div className="eyebrow">차세대 관리자 콘솔</div>
          <h1 id="login-title">관리자 로그인</h1>
          <p>기존 게이트웨이 계정 또는 Keycloak SSO를 사용합니다.</p>
        </div>

        {serverError || auth.error ? (
          <div className="form-error" role="alert">
            {serverError ?? auth.error}
          </div>
        ) : null}

        {auth.authenticationMode === "legacy_token" ? (
          <div className="login-form">
            <div className="field">
              <label htmlFor="legacy-token">기존 관리자 토큰</label>
              <input
                id="legacy-token"
                type="password"
                autoComplete="off"
                value={legacyToken}
                onChange={(event) => setLegacyToken(event.target.value)}
                aria-describedby="legacy-token-help"
              />
              <p id="legacy-token-help" className="field-help">
                브라우저 탭의 세션 저장소에만 저장하며 로컬 저장소에는 저장하지 않습니다.
              </p>
            </div>
            <Button variant="primary" onClick={() => void saveLegacyToken()}>
              <KeyRound aria-hidden="true" /> 콘솔 열기
            </Button>
          </div>
        ) : (
          <form className="login-form" onSubmit={(event) => void submit(event)} noValidate>
            {auth.sso.allow_local_login ? (
              <>
                <div className="field">
                  <label htmlFor="login-email">이메일</label>
                  <input
                    id="login-email"
                    type="email"
                    autoComplete="username"
                    aria-invalid={Boolean(form.formState.errors.email)}
                    aria-describedby={form.formState.errors.email ? "login-email-error" : undefined}
                    {...form.register("email")}
                  />
                  {form.formState.errors.email ? (
                    <p id="login-email-error" className="field-error">
                      {form.formState.errors.email.message}
                    </p>
                  ) : null}
                </div>
                <div className="field">
                  <label htmlFor="login-password">비밀번호</label>
                  <input
                    id="login-password"
                    type="password"
                    autoComplete="current-password"
                    aria-invalid={Boolean(form.formState.errors.password)}
                    aria-describedby={form.formState.errors.password ? "login-password-error" : undefined}
                    {...form.register("password")}
                  />
                  {form.formState.errors.password ? (
                    <p id="login-password-error" className="field-error">
                      {form.formState.errors.password.message}
                    </p>
                  ) : null}
                </div>
                <Button variant="primary" type="submit" disabled={form.formState.isSubmitting}>
                  {form.formState.isSubmitting ? "로그인 중…" : "로그인"}
                </Button>
              </>
            ) : null}
            {auth.sso.keycloak_enabled ? (
              <Button variant="secondary" onClick={startSso}>
                Keycloak SSO <ArrowUpRight aria-hidden="true" />
              </Button>
            ) : null}
          </form>
        )}

        <footer className="login-meta">
          <span>백엔드 {auth.backendVersion}</span>
          <span>UI {auth.uiVersion}</span>
          <span>API {auth.apiVersion}</span>
          {canOpenLegacyAdmin(auth) ? <a href="/admin">{uiLabels.legacyAdmin}</a> : null}
        </footer>
      </section>
    </main>
  );
}
