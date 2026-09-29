export interface UnsavedForm {
  dirty: boolean;
  pending: boolean;
  discard: () => void;
}

interface NavigationAttempt {
  proceed: () => void;
  reset: () => void;
}

type Confirmation = { kind: "close"; owner: symbol } | ({ kind: "navigation" } & NavigationAttempt);

interface Snapshot {
  protected: boolean;
  pending: boolean;
  confirmation: Confirmation | undefined;
}

/** Only lifecycle metadata and callbacks belong here, never form values or URLs. */
export class UnsavedChangesCoordinator {
  private forms = new Map<symbol, UnsavedForm>();
  private listeners = new Set<() => void>();
  private enabled = true;
  private confirmation: Confirmation | undefined;
  private snapshot: Snapshot = { protected: false, pending: false, confirmation: undefined };

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): Snapshot => this.snapshot;
  readonly shouldBlock = (): boolean => this.snapshot.protected;

  private publish(): void {
    const forms = [...this.forms.values()];
    const pending = this.enabled && forms.some((form) => form.pending);
    const protectedChanges = this.enabled && (pending || forms.some((form) => form.dirty));
    if (
      this.snapshot.protected === protectedChanges &&
      this.snapshot.pending === pending &&
      this.snapshot.confirmation === this.confirmation
    )
      return;
    this.snapshot = { protected: protectedChanges, pending, confirmation: this.confirmation };
    for (const listener of this.listeners) listener();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.discardForSecurity();
    else this.publish();
  }

  setForm(id: symbol, form: UnsavedForm): void {
    this.forms.set(id, form);
    this.publish();
  }

  removeForm(id: symbol): void {
    this.forms.delete(id);
    if (this.confirmation?.kind === "close" && this.confirmation.owner === id) this.confirmation = undefined;
    this.publish();
  }

  requestClose(id: symbol): void {
    const form = this.forms.get(id);
    if (!form || form.pending) return;
    if (!this.enabled || !form.dirty) {
      this.removeForm(id);
      form.discard();
      return;
    }
    // A route decision protects every form and takes precedence over a local close.
    if (this.confirmation) return;
    this.confirmation = { kind: "close", owner: id };
    this.publish();
  }

  startSubmission(id: symbol): boolean {
    const form = this.forms.get(id);
    if (!this.enabled || !form || form.pending || this.confirmation) return false;
    this.forms.set(id, { ...form, pending: true });
    this.publish();
    return true;
  }

  finishSubmission(id: symbol): void {
    const form = this.forms.get(id);
    if (form) this.forms.set(id, { ...form, pending: false });
    this.publish();
  }

  requestNavigation(attempt: NavigationAttempt): void {
    if (!this.shouldBlock()) {
      // Authentication loss or a completed save cancels the stale navigation.
      attempt.reset();
      return;
    }
    if (
      this.confirmation?.kind === "navigation" &&
      this.confirmation.proceed === attempt.proceed &&
      this.confirmation.reset === attempt.reset
    )
      return;
    this.confirmation = { kind: "navigation", ...attempt };
    this.publish();
  }

  clearNavigation(): void {
    if (this.confirmation?.kind !== "navigation") return;
    this.confirmation = undefined;
    this.publish();
  }

  readonly keepEditing = (): void => {
    const previous = this.confirmation;
    this.confirmation = undefined;
    this.publish();
    if (previous?.kind === "navigation") previous.reset();
  };

  readonly discardConfirmed = (): void => {
    const previous = this.confirmation;
    // Recheck the current state, not the rendered button's possibly stale state.
    if (!previous || this.snapshot.pending) return;
    this.confirmation = undefined;
    if (previous.kind === "navigation") {
      const forms = [...this.forms.values()];
      this.forms.clear();
      this.publish();
      for (const form of forms) form.discard();
      previous.proceed();
    } else {
      const form = this.forms.get(previous.owner);
      this.removeForm(previous.owner);
      form?.discard();
    }
  };

  /** Logout/session expiry must never wait for, or resume, an old route prompt. */
  readonly discardForSecurity = (): void => {
    const previous = this.confirmation;
    const forms = [...this.forms.values()];
    this.confirmation = undefined;
    this.forms.clear();
    this.publish();
    if (previous?.kind === "navigation") previous.reset();
    for (const form of forms) form.discard();
  };
}
