import { Component, createRef, type ErrorInfo, type PropsWithChildren, type ReactNode } from "react";

interface State {
  error?: Error;
}

export class AppErrorBoundary extends Component<PropsWithChildren, State> {
  override state: State = {};
  private readonly headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Do not include props, API payloads, prompts, or user content in browser telemetry.
    console.error("app_error_boundary", { name: error.name, componentStack: info.componentStack });
    this.headingRef.current?.focus();
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    // AuthProvider may itself have failed. Only the authenticated route-level
    // boundary can offer a permission-aware Legacy link.
    return (
      <main className="fatal-error" id="main-content">
        <section className="page-state page-state-error" role="alert">
          <h1 ref={this.headingRef} tabIndex={-1}>
            신규 콘솔에서 오류가 발생했습니다.
          </h1>
          <p>화면을 다시 불러오세요. 문제가 계속되면 관리자에게 문의하세요.</p>
          <div className="state-actions">
            <button className="button button-primary button-default" onClick={() => window.location.reload()}>
              다시 불러오기
            </button>
          </div>
        </section>
      </main>
    );
  }
}
