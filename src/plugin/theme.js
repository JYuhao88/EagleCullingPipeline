export const EAGLE_THEMES = ["LIGHT", "LIGHTGRAY", "GRAY", "DARK", "BLUE", "PURPLE"];
const DARK_THEMES = new Set(["GRAY", "DARK", "BLUE", "PURPLE"]);

export function normalizeTheme(theme, prefersDark = true) {
  const name = String(theme || "").toUpperCase();
  if (EAGLE_THEMES.includes(name)) return name;
  return prefersDark ? "DARK" : "LIGHT";
}

export function isDarkTheme(theme) {
  return DARK_THEMES.has(normalizeTheme(theme));
}

export function applyTheme(theme, doc = globalThis.document) {
  const prefersDark = globalThis.matchMedia?.("(prefers-color-scheme: dark)")?.matches ?? true;
  const name = normalizeTheme(theme, prefersDark);
  if (!doc?.documentElement) return name;
  doc.documentElement.dataset.theme = name;
  doc.documentElement.style.colorScheme = isDarkTheme(name) ? "dark" : "light";
  if (doc.body) doc.body.setAttribute("theme", name);
  return name;
}

export async function initEagleTheme({ eagle = globalThis.eagle, doc = globalThis.document } = {}) {
  let theme = null;
  try { theme = await eagle?.app?.theme; } catch { theme = null; }
  if (String(theme || "").toUpperCase() === "AUTO" || !theme) {
    try {
      const dark = await eagle?.app?.isDarkColors?.();
      if (typeof dark === "boolean") theme = dark ? "DARK" : "LIGHT";
    } catch { /* fall back to prefers-color-scheme */ }
  }
  const applied = applyTheme(theme, doc);
  eagle?.onThemeChanged?.(next => { applyTheme(next, doc); });
  return applied;
}
