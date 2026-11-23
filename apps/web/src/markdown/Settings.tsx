import { MarkdownView } from "./MarkdownView";
import type {
  MarkdownFontSize,
  MarkdownMode,
  MarkdownPreferences,
  MarkdownTheme,
} from "../preferences";

const themes = {
  clean: { name: "清爽知识库", description: "蓝灰标题，浅灰代码底色。" },
  paper: { name: "温暖纸张", description: "暖色纸面，衬线正文。" },
  developer: { name: "开发者编辑器", description: "靛蓝标题，深色代码块。" },
} satisfies Record<MarkdownTheme, { name: string; description: string }>;

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
        主题
        <select
          value={value.theme}
          onChange={(e) =>
            update("theme", e.target.value as MarkdownTheme)
          }
        >
          {Object.entries(themes).map(([id, theme]) => (
            <option key={id} value={id}>{theme.name}</option>
          ))}
        </select>
      </label>
      <figure className="document-mode theme-preview" data-markdown-theme={value.theme} data-markdown-font-size={value.fontSize}>
        <figcaption aria-live="polite">
          <strong>{themes[value.theme].name}预览</strong>
          {themes[value.theme].description}
        </figcaption>
        <MarkdownView text={sample} io={{}} />
      </figure>
      <label>
        默认打开模式
        <select
          value={value.defaultMode}
          onChange={(e) =>
            update("defaultMode", e.target.value as MarkdownMode)
          }
        >
          <option value="live">所见即所得</option>
          <option value="split">分屏编辑</option>
          <option value="edit">源码</option>
          <option value="read">预览模式</option>
          <option value="map">思维导图</option>
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
      <label className="settings-check">
        <input
          type="checkbox"
          checked={value.syncScroll}
          onChange={(e) => update("syncScroll", e.target.checked)}
        />
        分屏编辑同步滚动
      </label>
    </div>
  );
}
