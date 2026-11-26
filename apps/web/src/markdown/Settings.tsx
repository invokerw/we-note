import { markdownModes, type MarkdownMode } from "./modes";
import { MarkdownView } from "./MarkdownView";
import type { MarkdownFontSize, MarkdownPreferences } from "../preferences";

const sample = [
  "## 笔记索引",
  "",
  "用 `limit` 控制显示的笔记数量。",
  "",
  "```js",
  "// 最近编辑的笔记",
  'const notes = { sort: "recent", limit: 5 };',
  "```",
].join("\n");

export default function MarkdownSettings({
  value,
  onChange,
}: {
  value: MarkdownPreferences;
  onChange: (patch: Partial<MarkdownPreferences>) => void;
}) {
  const update = <K extends keyof MarkdownPreferences>(
    key: K,
    next: MarkdownPreferences[K],
  ) => onChange({ [key]: next } as Partial<MarkdownPreferences>);
  return (
    <div className="settings-panel">
      <label>
        默认打开模式
        <select
          value={value.defaultMode}
          onChange={(e) =>
            update("defaultMode", e.target.value as MarkdownMode)
          }
        >
          {markdownModes.map(([id, label]) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <label>
        正文字号
        <select
          value={value.fontSize}
          onChange={(e) =>
            update("fontSize", e.target.value as MarkdownFontSize)
          }
        >
          <option value="small">小</option>
          <option value="medium">标准</option>
          <option value="large">大</option>
        </select>
      </label>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.rememberNoteMode}
          onChange={(e) => update("rememberNoteMode", e.target.checked)}
        />
        记住每篇笔记上次打开的模式
      </label>
      <figure
        className="document-mode theme-preview"
        data-markdown-theme="clean"
        data-markdown-font-size={value.fontSize}
      >
        <figcaption>正文字号预览</figcaption>
        <MarkdownView text={sample} io={{}} />
      </figure>
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.syncScroll}
          onChange={(e) => update("syncScroll", e.target.checked)}
        />
        分屏编辑同步滚动
      </label>
      <fieldset>
        <legend>保存时自动格式化</legend>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.autoFormatOnSave}
            onChange={(e) => update("autoFormatOnSave", e.target.checked)}
          />
          启用保存时自动格式化
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.cjkLatinSpacing}
            onChange={(e) => update("cjkLatinSpacing", e.target.checked)}
          />
          中日韩文字与英文之间加空格
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.cjkDigitSpacing}
            onChange={(e) => update("cjkDigitSpacing", e.target.checked)}
          />
          中日韩文字与数字之间加空格
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.latinDigitSpacing}
            onChange={(e) => update("latinDigitSpacing", e.target.checked)}
          />
          英文与数字之间加空格
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.trimTrailingWhitespace}
            onChange={(e) => update("trimTrailingWhitespace", e.target.checked)}
          />
          清理普通行尾空格
        </label>
        <label className="settings-check">
          <input
            type="checkbox"
            checked={value.normalizeBlankLines}
            onChange={(e) => update("normalizeBlankLines", e.target.checked)}
          />
          整理连续空行
        </label>
      </fieldset>
    </div>
  );
}
