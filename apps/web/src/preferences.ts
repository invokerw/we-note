import { normalizeXMindTheme, type XMindTheme } from "./plugins/xmindThemes";
export type MarkdownTheme = "clean" | "paper" | "developer";
export type MarkdownMode = "read" | "split" | "edit" | "live" | "map";
export type MarkdownFontSize = "small" | "medium" | "large";

export type MarkdownPreferences = {
  theme: MarkdownTheme;
  defaultMode: MarkdownMode;
  rememberNoteMode: boolean;
  splitRatio: number;
  syncScroll: boolean;
  fontSize: MarkdownFontSize;
  autoFormatOnSave: boolean;
  cjkLatinSpacing: boolean;
  cjkDigitSpacing: boolean;
  latinDigitSpacing: boolean;
  trimTrailingWhitespace: boolean;
  normalizeBlankLines: boolean;
};

export type XMindPreferences = {
  theme: XMindTheme;
};

export type UserPreferences = {
  version: 1;
  plugins: Record<string, unknown>;
};

export const defaultMarkdownPreferences: MarkdownPreferences = {
  theme: "clean",
  defaultMode: "live",
  rememberNoteMode: true,
  splitRatio: 50,
  syncScroll: true,
  fontSize: "medium",
  autoFormatOnSave: true,
  cjkLatinSpacing: true,
  cjkDigitSpacing: true,
  latinDigitSpacing: true,
  trimTrailingWhitespace: true,
  normalizeBlankLines: true,
};

export const defaultXMindPreferences: XMindPreferences = {
  theme: "classic",
};

export const defaultUserPreferences: UserPreferences = {
  version: 1,
  plugins: {
    "com.wenote.md": defaultMarkdownPreferences,
    "com.wenote.xmind": defaultXMindPreferences,
  },
};

const localKey = "wenote-user-preferences-v1";
const noteModeKey = "wenote-note-modes-v1";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function markdown(value: unknown): MarkdownPreferences {
  const input = object(value);
  const theme = input.theme;
  const defaultMode = input.defaultMode;
  const fontSize = input.fontSize;
  return {
    theme:
      theme === "paper" || theme === "developer" ? theme : "clean",
    defaultMode:
      defaultMode === "read" ||
      defaultMode === "split" ||
      defaultMode === "edit" ||
      defaultMode === "live" ||
      defaultMode === "map"
        ? defaultMode
        : "live",
    rememberNoteMode: input.rememberNoteMode !== false,
    splitRatio:
      typeof input.splitRatio === "number"
        ? Math.max(25, Math.min(75, Math.round(input.splitRatio)))
        : 50,
    syncScroll: input.syncScroll !== false,
    fontSize:
      fontSize === "small" || fontSize === "large" ? fontSize : "medium",
    autoFormatOnSave: input.autoFormatOnSave !== false,
    cjkLatinSpacing: input.cjkLatinSpacing !== false,
    cjkDigitSpacing: input.cjkDigitSpacing !== false,
    latinDigitSpacing: input.latinDigitSpacing !== false,
    trimTrailingWhitespace: input.trimTrailingWhitespace !== false,
    normalizeBlankLines: input.normalizeBlankLines !== false,
  };
}

function xmind(value: unknown): XMindPreferences {
  return {
    theme: normalizeXMindTheme(object(value).theme),
  };
}

export function normalizePreferences(value: unknown): UserPreferences {
  const input = object(value),
    plugins = object(input.plugins);
  return {
    version: 1,
    plugins: {
      ...plugins,
      "com.wenote.md": markdown(plugins["com.wenote.md"]),
      "com.wenote.xmind": xmind(plugins["com.wenote.xmind"]),
    },
  };
}

export function markdownPreferences(
  value: UserPreferences,
): MarkdownPreferences {
  return markdown(value.plugins["com.wenote.md"]);
}

export function xmindPreferences(value: UserPreferences): XMindPreferences {
  return xmind(value.plugins["com.wenote.xmind"]);
}

export function updatePluginPreferences(
  value: UserPreferences,
  pluginId: string,
  settings: unknown,
): UserPreferences {
  return normalizePreferences({
    ...value,
    plugins: { ...value.plugins, [pluginId]: settings },
  });
}

export function loadLocalPreferences(): UserPreferences {
  try {
    return normalizePreferences(
      JSON.parse(localStorage.getItem(localKey) || "null"),
    );
  } catch {
    return defaultUserPreferences;
  }
}

export function saveLocalPreferences(value: UserPreferences) {
  localStorage.setItem(localKey, JSON.stringify(normalizePreferences(value)));
}

export function mergeRemotePreferences(
  current: UserPreferences,
  remote: unknown,
): UserPreferences {
  const plugins = object(object(remote).plugins);
  return normalizePreferences({
    ...current,
    plugins: { ...current.plugins, ...plugins },
  });
}

function noteModes(): Record<string, MarkdownMode> {
  try {
    return object(JSON.parse(localStorage.getItem(noteModeKey) || "null")) as Record<
      string,
      MarkdownMode
    >;
  } catch {
    return {};
  }
}

export function loadNoteMode(
  vault: string,
  fileId: string,
): MarkdownMode | undefined {
  const mode = noteModes()[vault + ":" + fileId];
  return mode === "read" ||
    mode === "split" ||
    mode === "edit" ||
    mode === "live" ||
    mode === "map"
    ? mode
    : undefined;
}

export function saveNoteMode(vault: string, fileId: string, mode: MarkdownMode) {
  const modes = noteModes();
  modes[vault + ":" + fileId] = mode;
  localStorage.setItem(noteModeKey, JSON.stringify(modes));
}
