"use client";

import { useSyncExternalStore } from "react";
import { THEME_STORAGE_KEY } from "./theme";

function getTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function getServerTheme() {
  return "light" as const;
}

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  function syncTheme(event: StorageEvent) {
    if (event.key === THEME_STORAGE_KEY || event.key === null) {
      document.documentElement.dataset.theme = event.newValue === "dark" ? "dark" : "light";
    }
  }
  window.addEventListener("storage", syncTheme);
  return () => {
    observer.disconnect();
    window.removeEventListener("storage", syncTheme);
  };
}

export default function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getTheme, getServerTheme);
  const label = theme === "dark" ? "切换到浅色主题" : "切换到黑色主题";

  function toggleTheme() {
    const next = getTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Switching still works when the browser does not allow persistence.
    }
  }

  return (
    <button type="button" className="icon-button theme-toggle" onClick={toggleTheme} aria-label={label} title={label}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {theme === "dark" ? <>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42" />
        </> : <path d="M20.9 13.3A9 9 0 0 1 10.7 3.1 9 9 0 1 0 20.9 13.3Z" />}
      </svg>
    </button>
  );
}
