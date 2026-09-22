export const THEME_STORAGE_KEY = "watch4gpu.theme";

// Apply the saved palette before the page paints, including before hydration.
export const THEME_INIT_SCRIPT = `(() => {
  let theme = "light";
  try {
    if (localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)}) === "dark") theme = "dark";
  } catch {}
  document.documentElement.dataset.theme = theme;
})();`;
