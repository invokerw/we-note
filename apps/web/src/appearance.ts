import { useEffect, useState } from "react";

export type ColorScheme = "light" | "dark";

const storageKey = "wenote-color-scheme-v1";
const listeners = new Set<(scheme: ColorScheme) => void>();
let current: ColorScheme | undefined;

function normalize(value: unknown): ColorScheme {
  return value === "dark" ? "dark" : "light";
}

export function loadColorScheme(): ColorScheme {
  if (current) return current;
  try {
    current = normalize(localStorage.getItem(storageKey));
  } catch {
    current = "light";
  }
  return current;
}

export function applyColorScheme(scheme: ColorScheme) {
  current = scheme;
  if (typeof document !== "undefined") {
    document.documentElement.dataset.colorScheme = scheme;
    document.documentElement.style.colorScheme = scheme;
  }
  for (const listener of listeners) listener(scheme);
}

export function setColorScheme(scheme: ColorScheme) {
  try {
    localStorage.setItem(storageKey, scheme);
  } catch {
    // Continue with the in-memory setting when storage is unavailable.
  }
  applyColorScheme(scheme);
}

export function useColorScheme(): [ColorScheme, (scheme: ColorScheme) => void] {
  const [scheme, setScheme] = useState(loadColorScheme);
  useEffect(() => {
    const update = (next: ColorScheme) => setScheme(next);
    listeners.add(update);
    applyColorScheme(loadColorScheme());
    return () => {
      listeners.delete(update);
    };
  }, []);
  return [scheme, setColorScheme];
}

applyColorScheme(loadColorScheme());
