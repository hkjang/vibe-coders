/** Catch module loading/evaluation failures before React can install its own
 * boundary. Static markup remains useful even when this loader cannot run.
 * Do not render/log the exception, URLs, session state or authentication data.
 */
export async function startConsole(
  load: () => Promise<unknown>,
  reload: () => void = () => window.location.reload(),
): Promise<void> {
  try {
    await load();
  } catch {
    const state = document.getElementById("app-startup-state");
    const heading = document.getElementById("app-startup-title");
    const description = document.getElementById("app-startup-description");
    const retry = document.getElementById("app-startup-retry");
    // A runtime may already have mounted a more specific recovery screen.
    if (!state || !heading || !description || !(retry instanceof HTMLButtonElement)) return;
    state.setAttribute("role", "alert");
    state.setAttribute("aria-live", "assertive");
    heading.textContent = "신규 콘솔을 불러오지 못했습니다.";
    description.textContent = "현재 주소로 다시 시도하거나 콘솔 처음 화면을 열어 주세요.";
    retry.hidden = false;
    retry.addEventListener(
      "click",
      () => {
        retry.disabled = true;
        reload();
      },
      { once: true },
    );
    // Announce failure without taking focus away from an operator who has
    // already reached the static recovery link while the module was loading.
    if (!document.activeElement || document.activeElement === document.body) heading.focus();
  }
}
