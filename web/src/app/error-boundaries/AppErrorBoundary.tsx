import { Component, createRef, useEffect, useRef, type PropsWithChildren, type ReactNode } from "react";

import { RootLegacyRecovery } from "./RootLegacyRecovery";

function ErrorObservation({ error, onError }: { error: unknown; onError?: (error: unknown) => void }): null {
  const observed = useRef<{ error: unknown } | undefined>(undefined);
  useEffect(() => {
    if (!onError || observed.current?.error === error) return;
    observed.current = { error };
    // Parent layout effects establish session ownership before observation.
    try {
      onError?.(error);
    } catch {
      /* Recovery must survive observer failures. */
    }
  }, [error, onError]);
  return null;
}

interface State {
  error?: Error;
}

export class AppErrorBoundary extends Component<
  PropsWithChildren<{ onError?: (error: unknown) => void }>,
  State
> {
  override state: State = {};
  private readonly headingRef = createRef<HTMLHeadingElement>();

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(): void {
    this.headingRef.current?.focus();
  }

  override render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error" id="main-content">
        <ErrorObservation error={this.state.error} onError={this.props.onError} />
        <section className="page-state page-state-error" role="alert">
          <h1 ref={this.headingRef} tabIndex={-1}>
            신규 콘솔에서 오류가 발생했습니다.
          </h1>
          <p>화면을 다시 불러오세요. 문제가 계속되면 관리자에게 문의하세요.</p>
          <div className="state-actions">
            <button className="button button-primary button-default" onClick={() => window.location.reload()}>
              다시 불러오기
            </button>
            <RootLegacyRecovery />
          </div>
        </section>
      </main>
    );
  }
}
