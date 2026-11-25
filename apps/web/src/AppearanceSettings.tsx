import { useState } from "react";
import { setAppearance, useAppearance } from "./appearance";

const modes = [
  ["system", "跟随系统"],
  ["light", "浅色"],
  ["dark", "深色"],
  ["schedule", "按时间切换"],
] as const;
const times = [
  ["lightStart", "浅色开始"],
  ["darkStart", "深色开始"],
] as const;

export default function AppearanceSettings() {
  const preference = useAppearance();
  const [draft, setDraft] =
    useState<Pick<typeof preference, "lightStart" | "darkStart">>();
  const schedule = draft ?? preference;
  return (
    <>
      <fieldset className="appearance-modes">
        <legend>主题模式</legend>
        {modes.map(([mode, label]) => (
          <label key={mode}>
            <input
              type="radio"
              name="appearance-mode"
              checked={preference.mode === mode}
              onChange={() => {
                setDraft(undefined);
                setAppearance({ ...preference, mode });
              }}
            />
            {label}
          </label>
        ))}
      </fieldset>
      {preference.mode === "schedule" && (
        <fieldset className="appearance-times">
          <legend>每日切换时间（本机时间）</legend>
          {times.map(([key, label]) => (
            <label key={key}>
              {label}
              <input
                type="time"
                value={schedule[key]}
                required
                aria-invalid={!!draft}
                aria-describedby={draft ? "appearance-time-error" : undefined}
                onChange={(event) => {
                  const next = {
                    lightStart: schedule.lightStart,
                    darkStart: schedule.darkStart,
                    [key]: event.target.value,
                  };
                  if (
                    !next.lightStart ||
                    !next.darkStart ||
                    next.lightStart === next.darkStart
                  )
                    setDraft(next);
                  else {
                    setDraft(undefined);
                    setAppearance({ ...preference, ...next });
                  }
                }}
              />
            </label>
          ))}
          {draft && (
            <p id="appearance-time-error" role="status">
              {!draft.lightStart || !draft.darkStart
                ? "请填写两个开始时间。"
                : "两个开始时间需要不同。"}
            </p>
          )}
        </fieldset>
      )}
    </>
  );
}
