import { Component, type ErrorInfo, type PropsWithChildren, type ReactNode } from "react";

interface State {
  error?: Error;
}

export class AppErrorBoundary extends Component<PropsWithChildren, State> {
  override state: State = {};

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Do not include props, API payloads, prompts, or user content in browser telemetry.
    console.error("app_error_boundary", { name: error.name, componentStack: info.componentStack });
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" id="main-content">
        <section className="page-state page-state-error" role="alert">
          <h1>신규 콘솔에서 오류가 발생했습니다.</h1>
          <p>기존 관리자 화면은 영향을 받지 않았습니다.</p>
          <div className="state-actions">
            <button className="button button-primary button-default" onClick={() => window.location.reload()}>
              다시 불러오기
            </button>
            <a className="button button-secondary button-default" href="/admin">
              기존 관리자 화면 열기
            </a>
          </div>
        </section>
      </main>
    );
  }
}
