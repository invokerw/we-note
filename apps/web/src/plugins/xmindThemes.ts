export type XMindTheme = "classic" | "ocean" | "forest" | "midnight" | "youdao";

type XMindThemeDefinition = {
  name: string;
  description: string;
  background: string;
  nodeStyle: "cards" | "lines";
  nodeRadius: number;
  edge: string;
  relationship: string;
  relationshipText: string;
  relationshipOutline: string;
  root: string;
  rootText: string;
  node: string;
  nodeText: string;
  note: string;
  nodeStroke: string;
  selected: string;
  summary: string;
};

export const xmindThemes = {
  classic: {
    name: "经典卡片",
    description: "根节点和子节点使用清晰的卡片层级。",
    background: "#ffffff",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#86a6d8",
    relationship: "#a16c9d",
    relationshipText: "#744c71",
    relationshipOutline: "#ffffff",
    root: "#458cf0",
    rootText: "#ffffff",
    node: "#ffffff",
    nodeText: "#2f3a4a",
    note: "#6d7787",
    nodeStroke: "#b9cbe5",
    selected: "#3c85e9",
    summary: "#bf8b4e",
  },
  ocean: {
    name: "海洋卡片",
    description: "蓝色根节点搭配浅色子节点卡片。",
    background: "#ffffff",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#f04b45",
    relationship: "#bc687d",
    relationshipText: "#8a4055",
    relationshipOutline: "#ffffff",
    root: "#4b91f4",
    rootText: "#ffffff",
    node: "#ffffff",
    nodeText: "#333333",
    note: "#666666",
    nodeStroke: "#f0b5b1",
    selected: "#4b91f4",
    summary: "#ba7b42",
  },
  forest: {
    name: "清新绿卡",
    description: "白色画布配绿色分支和卡片节点。",
    background: "#ffffff",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#55a56b",
    relationship: "#996b90",
    relationshipText: "#704a69",
    relationshipOutline: "#ffffff",
    root: "#479b68",
    rootText: "#ffffff",
    node: "#ffffff",
    nodeText: "#2f5138",
    note: "#52705a",
    nodeStroke: "#b9d8c1",
    selected: "#397a51",
    summary: "#aa8145",
  },
  midnight: {
    name: "靛蓝卡片",
    description: "白色画布配靛蓝分支和卡片节点。",
    background: "#ffffff",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#7668d6",
    relationship: "#b06ca9",
    relationshipText: "#704b70",
    relationshipOutline: "#ffffff",
    root: "#6756c8",
    rootText: "#ffffff",
    node: "#ffffff",
    nodeText: "#38344f",
    note: "#6f6a86",
    nodeStroke: "#c8c2e8",
    selected: "#6756c8",
    summary: "#c9ab72",
  },
  youdao: {
    name: "有道线稿",
    description: "子节点使用底部短线，分支线连接到节点两端。",
    background: "#ffffff",
    nodeStyle: "lines",
    nodeRadius: 0,
    edge: "#f04b45",
    relationship: "#bc687d",
    relationshipText: "#8a4055",
    relationshipOutline: "#ffffff",
    root: "#4b91f4",
    rootText: "#ffffff",
    node: "transparent",
    nodeText: "#333333",
    note: "#666666",
    nodeStroke: "transparent",
    selected: "#4b91f4",
    summary: "#ba7b42",
  },
} satisfies Record<XMindTheme, XMindThemeDefinition>;

export function normalizeXMindTheme(value: unknown): XMindTheme {
  return value === "ocean" || value === "forest" || value === "midnight" || value === "youdao"
    ? value
    : "classic";
}
