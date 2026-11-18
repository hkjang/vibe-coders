// Intentionally a dependency-free classic script: apply the saved palette before
// parsing the static recovery content, even if the React runtime cannot load.
(() => {
  let theme = "system";
  let density = "default";
  try {
    const saved = JSON.parse(localStorage.getItem("vibe.app.preferences.v1") || "null");
    const state = saved?.state;
    if (
      saved &&
      (typeof saved.version !== "number" || saved.version === 0) &&
      state &&
      typeof state === "object" &&
      !Array.isArray(state)
    ) {
      if (["light", "dark", "system"].includes(state.theme)) theme = state.theme;
      if (["compact", "default", "comfortable"].includes(state.density)) density = state.density;
    }
  } catch {
    // Storage can be disabled or malformed. System appearance needs no storage.
  }
  const resolved =
    theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme;
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.density = density;
  document.documentElement.style.colorScheme = resolved;
})();
