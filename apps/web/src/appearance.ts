import { useSyncExternalStore } from "react";

export type ColorScheme = "light" | "dark";
type Mode = ColorScheme | "system" | "schedule";
export type Appearance = { mode: Mode; lightStart: string; darkStart: string };
const defaults: Appearance = {
  mode: "system",
  lightStart: "07:00",
  darkStart: "19:00",
};
const storageKey = "wenote-appearance-v2";
const legacyKey = "wenote-color-scheme-v1";
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export function readAppearance(
  raw: string | null,
  legacy: string | null,
): Appearance {
  if (raw) {
    try {
      const data = JSON.parse(raw);
      if (["system", "light", "dark", "schedule"].includes(data?.mode)) {
        const { mode, lightStart, darkStart } = data;
        if (
          typeof lightStart === "string" &&
          typeof darkStart === "string" &&
          timePattern.test(lightStart) &&
          timePattern.test(darkStart) &&
          lightStart !== darkStart
        ) {
          return { mode, lightStart, darkStart };
        }
        return { ...defaults, mode };
      }
    } catch {
      /* Fall back to an explicit preference from the previous version. */
    }
  }
  return {
    ...defaults,
    mode: legacy === "dark" || legacy === "light" ? legacy : "system",
  };
}

export function resolveScheme(
  p: Appearance,
  systemDark: boolean,
  now: Date,
): ColorScheme {
  if (p.mode === "system") return systemDark ? "dark" : "light";
  if (p.mode !== "schedule") return p.mode;
  const clock = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const light =
    p.lightStart < p.darkStart
      ? clock >= p.lightStart && clock < p.darkStart
      : clock >= p.lightStart || clock < p.darkStart;
  return light ? "light" : "dark";
}

function load(): Appearance {
  try {
    return readAppearance(
      localStorage.getItem(storageKey),
      localStorage.getItem(legacyKey),
    );
  } catch {
    return defaults;
  }
}

let preference = typeof window !== "undefined" ? load() : defaults;
let scheme: ColorScheme = "light";
let timer: number | undefined;
const media =
  typeof window !== "undefined"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : undefined;
const listeners = new Set<() => void>();
function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
function refresh() {
  const now = new Date();
  scheme = resolveScheme(preference, media?.matches ?? false, now);
  document.documentElement.dataset.colorScheme = scheme;
  document.documentElement.style.colorScheme = scheme;
  window.clearTimeout(timer);
  // Compare local clock minutes again after sleep, clock adjustments and DST changes.
  if (preference.mode === "schedule" && !document.hidden) {
    timer = window.setTimeout(refresh, 60000 - (now.getTime() % 60000));
  }
  for (const notify of listeners) notify();
}
export function setAppearance(next: Appearance) {
  preference = next;
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
  } catch {
    /* Keep the session preference. */
  }
  refresh();
}
export function useAppearance() {
  return useSyncExternalStore(subscribe, () => preference);
}
export function useColorScheme() {
  return useSyncExternalStore(subscribe, () => scheme);
}
if (typeof window !== "undefined") {
  refresh();
  media?.addEventListener("change", refresh);
  window.addEventListener("pageshow", refresh);
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  window.addEventListener("storage", (event) => {
    if (
      event.key === storageKey ||
      event.key === legacyKey ||
      event.key === null
    ) {
      preference = load();
      refresh();
    }
  });
}
