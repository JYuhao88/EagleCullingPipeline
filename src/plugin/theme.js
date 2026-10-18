export const EAGLE_THEMES = ["LIGHT", "LIGHTGRAY", "GRAY", "DARK", "BLUE", "PURPLE"];
const DARK_THEMES = new Set(["GRAY", "DARK", "BLUE", "PURPLE"]);

// Eagle's own rules: a preference it cannot read shows GRAY, and Auto shows GRAY or LIGHT with the system.
export function normalizeTheme(theme, prefersDark = true) {
  const name = String(theme || "").toUpperCase();
  if (EAGLE_THEMES.includes(name)) return name;
  if (name === "AUTO") return prefersDark ? "GRAY" : "LIGHT";
  return "GRAY";
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

const known = value => EAGLE_THEMES.includes(String(value || "").toUpperCase());

export async function initEagleTheme({ eagle = globalThis.eagle, doc = globalThis.document,
  search = globalThis.location?.search } = {}) {
  let theme = null;
  try { theme = await eagle?.app?.theme; } catch { theme = null; }
  // eagle.app.theme follows theme changes but is the raw preference name: "Auto", or "undefined" when Eagle saved the
  // theme as a bare string. The right panel's URL carries the theme Eagle actually shows.
  const fromUrl = new URLSearchParams(search || "").get("theme");
  if (!known(theme) && known(fromUrl)) theme = fromUrl;
  if (!known(theme) && [theme, fromUrl].some(value => String(value || "").toUpperCase() === "AUTO")) {
    try {
      const dark = await eagle?.app?.isDarkColors?.();
      theme = typeof dark === "boolean" ? (dark ? "GRAY" : "LIGHT") : "AUTO";
    } catch { theme = "AUTO"; }
  }
  const applied = applyTheme(theme, doc);
  eagle?.onThemeChanged?.(next => { applyTheme(next, doc); });
  return applied;
}
