import { useColorScheme } from "../appearance";
import type { CSSProperties } from "react";
import type { XMindPreferences } from "../preferences";
import { xmindColors, xmindThemes, type XMindTheme } from "./xmindThemes";

const previewNodes = [
  { x: 210, y: 74, width: 104, height: 36, title: "项目规划", root: true },
  { x: 74, y: 30, width: 94, height: 32, title: "目标拆解" },
  { x: 74, y: 118, width: 94, height: 32, title: "执行步骤" },
  { x: 346, y: 30, width: 94, height: 32, title: "资料整理" },
  { x: 346, y: 118, width: 94, height: 32, title: "复盘改进" },
];

function ThemePreview({ theme }: { theme: XMindTheme }) {
  const scheme = useColorScheme();
  const colors = xmindColors(theme, scheme);
  const previewEdges = colors.nodeStyle === "lines"
    ? [
        "M 158 74 C 142 74 138 44 111 44",
        "M 158 74 C 142 74 138 132 111 132",
        "M 262 74 C 278 74 282 44 309 44",
        "M 262 74 C 278 74 282 132 309 132",
      ]
    : [
        "M 158 74 C 142 74 138 30 121 30",
        "M 158 74 C 142 74 138 118 121 118",
        "M 262 74 C 278 74 282 30 299 30",
        "M 262 74 C 278 74 282 118 299 118",
      ];
  const style = {
    "--xmind-preview-bg": colors.background,
    "--xmind-preview-edge": colors.edge,
    "--xmind-preview-root": colors.root,
    "--xmind-preview-node": colors.node,
    "--xmind-preview-root-text": colors.rootText,
    "--xmind-preview-node-text": colors.nodeText,
    "--xmind-preview-stroke": colors.nodeStroke,
  } as CSSProperties;
  return (
    <figure
      className="mindmap-theme-preview"
      data-xmind-theme={theme}
      data-xmind-node-style={colors.nodeStyle}
      style={style}
    >
      <figcaption aria-live="polite">
        <strong>{colors.name}预览</strong>
        {colors.description}
      </figcaption>
      <svg viewBox="0 0 520 180" role="img" aria-label={`${colors.name}脑图主题预览`}>
        <g className="mindmap-preview-edges" aria-hidden="true">
          {previewEdges.map((path) => <path key={path} d={path} />)}
        </g>
        {previewNodes.map((node) => (
          <g key={node.title} transform={`translate(${node.x - node.width / 2} ${node.y - node.height / 2})`}>
            <rect
              width={node.width}
              height={node.height}
              rx={node.root ? colors.nodeRadius : 8}
              className={node.root ? "mindmap-preview-root" : "mindmap-preview-node"}
            />
            <text
              x={node.width / 2}
              y={node.height / 2 + 5}
              textAnchor="middle"
              className={node.root ? "mindmap-preview-root-text" : "mindmap-preview-node-text"}
            >
              {node.title}
            </text>
            {!node.root && (
              <line
                className="mindmap-preview-node-line"
                x1={10}
                x2={node.width - 10}
                y1={node.height - 2}
                y2={node.height - 2}
              />
            )}
          </g>
        ))}
      </svg>
    </figure>
  );
}

export default function MapSettings({
  value,
  onChange,
}: {
  value: XMindPreferences;
  onChange: (patch: Partial<XMindPreferences>) => void;
}) {
  return (
    <div className="settings-panel">
      <label>
        主题
        <select
          value={value.theme}
          onChange={(e) => onChange({ theme: e.target.value as XMindTheme })}
        >
          {Object.entries(xmindThemes).map(([id, theme]) => (
            <option key={id} value={id}>
              {theme.name}
            </option>
          ))}
        </select>
      </label>
      <ThemePreview theme={value.theme} />
    </div>
  );
}
