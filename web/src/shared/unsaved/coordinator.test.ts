import { describe, expect, it, vi } from "vitest";

import { UnsavedChangesCoordinator } from "@/shared/unsaved/coordinator";

describe("UnsavedChangesCoordinator", () => {
  it("closes clean forms immediately and confirms only the dirty owner", () => {
    const coordinator = new UnsavedChangesCoordinator();
    const first = Symbol();
    const second = Symbol();
    const closeFirst = vi.fn();
    const closeSecond = vi.fn();
    coordinator.setForm(first, { dirty: false, pending: false, discard: closeFirst });
    coordinator.setForm(second, { dirty: true, pending: false, discard: closeSecond });
    coordinator.requestClose(first);
    expect(closeFirst).toHaveBeenCalledTimes(1);
    expect(closeFirst).toHaveBeenCalledWith("close");
    expect(coordinator.getSnapshot().confirmation).toBeUndefined();
    coordinator.requestClose(second);
    coordinator.keepEditing();
    expect(closeSecond).not.toHaveBeenCalled();
    expect(coordinator.shouldBlock()).toBe(true);
    coordinator.requestClose(second);
    coordinator.discardConfirmed();
    expect(closeSecond).toHaveBeenCalledTimes(1);
    expect(closeSecond).toHaveBeenCalledWith("close");
    expect(coordinator.shouldBlock()).toBe(false);
  });

  it("retains other dirty forms after unregistering an owner and clears its stale prompt", () => {
    const coordinator = new UnsavedChangesCoordinator();
    const first = Symbol();
    const second = Symbol();
    coordinator.setForm(first, { dirty: true, pending: false, discard: vi.fn() });
    coordinator.setForm(second, { dirty: true, pending: false, discard: vi.fn() });
    coordinator.requestClose(first);
    coordinator.removeForm(first);
    expect(coordinator.getSnapshot().confirmation).toBeUndefined();
    expect(coordinator.shouldBlock()).toBe(true);
    coordinator.removeForm(second);
    expect(coordinator.shouldBlock()).toBe(false);
  });

  it("blocks repeated submission and rechecks pending before allowing navigation discard", () => {
    const coordinator = new UnsavedChangesCoordinator();
    const owner = Symbol();
    const discard = vi.fn();
    const proceed = vi.fn();
    const reset = vi.fn();
    coordinator.setForm(owner, { dirty: true, pending: false, discard });
    expect(coordinator.startSubmission(owner)).toBe(true);
    expect(coordinator.startSubmission(owner)).toBe(false);
    coordinator.requestClose(owner);
    expect(coordinator.getSnapshot().confirmation).toBeUndefined();
    coordinator.requestNavigation({ proceed, reset });
    coordinator.discardConfirmed();
    expect(discard).not.toHaveBeenCalled();
    expect(proceed).not.toHaveBeenCalled();
    coordinator.finishSubmission(owner);
    coordinator.discardConfirmed();
    expect(discard).toHaveBeenCalledTimes(1);
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
    expect(coordinator.shouldBlock()).toBe(false);
  });

  it("uses one navigation decision for every mounted form and never discards on keep editing", () => {
    const coordinator = new UnsavedChangesCoordinator();
    const discard = vi.fn();
    for (let index = 0; index < 3; index++)
      coordinator.setForm(Symbol(), { dirty: true, pending: false, discard });
    const attempt = { proceed: vi.fn(), reset: vi.fn() };
    coordinator.requestNavigation(attempt);
    coordinator.keepEditing();
    expect(attempt.reset).toHaveBeenCalledTimes(1);
    expect(discard).not.toHaveBeenCalled();
    coordinator.requestNavigation(attempt);
    coordinator.discardConfirmed();
    expect(discard).toHaveBeenCalledTimes(3);
    expect(discard).toHaveBeenCalledWith("navigation");
    expect(attempt.proceed).toHaveBeenCalledTimes(1);
  });

  it("security loss discards even pending forms and cancels rather than resumes a stale route", () => {
    const coordinator = new UnsavedChangesCoordinator();
    const discard = vi.fn();
    const attempt = { proceed: vi.fn(), reset: vi.fn() };
    coordinator.setForm(Symbol(), { dirty: true, pending: true, discard });
    coordinator.requestNavigation(attempt);
    coordinator.setEnabled(false);
    expect(discard).toHaveBeenCalledTimes(1);
    expect(discard).toHaveBeenCalledWith("security");
    expect(attempt.reset).toHaveBeenCalledTimes(1);
    expect(attempt.proceed).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot()).toEqual({ protected: false, pending: false, confirmation: undefined });
    coordinator.discardConfirmed();
    coordinator.setEnabled(true);
    expect(coordinator.shouldBlock()).toBe(false);
  });
});
