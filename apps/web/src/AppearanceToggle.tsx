import type { ColorScheme } from "./appearance";

export default function AppearanceToggle({
  scheme,
  onChange,
}: {
  scheme: ColorScheme;
  onChange: (scheme: ColorScheme) => void;
}) {
  const dark = scheme === "dark";
  const next = dark ? "light" : "dark";
  const label = dark ? "切换到浅色模式" : "切换到深色模式";
  return (
    <button
      className="appearance-toggle"
      aria-label={label}
      aria-pressed={dark}
      title={label}
      onClick={() => onChange(next)}
    >
      <span className="appearance-toggle-icon" aria-hidden="true">
        {dark ? "☀" : "☾"}
      </span>
      <span>{dark ? "浅色模式" : "深色模式"}</span>
    </button>
  );
}
