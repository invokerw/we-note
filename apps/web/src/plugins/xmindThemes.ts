export type XMindTheme = "classic" | "ocean" | "forest" | "midnight" | "youdao";

export type XMindThemePalette = {
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

type XMindThemeDefinition = XMindThemePalette & {
  name: string;
  description: string;
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

const darkXMindThemes: Record<XMindTheme, XMindThemePalette> = {
  classic: {
    background: "#141b26",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#8fb3e8",
    relationship: "#d593c7",
    relationshipText: "#f0c1e4",
    relationshipOutline: "#141b26",
    root: "#4d91f2",
    rootText: "#ffffff",
    node: "#232f3e",
    nodeText: "#e5edf8",
    note: "#aab6c7",
    nodeStroke: "#5a769a",
    selected: "#8ab4ff",
    summary: "#e1b46d",
  },
  ocean: {
    background: "#10202c",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#ff756c",
    relationship: "#e7a3b5",
    relationshipText: "#ffd0db",
    relationshipOutline: "#10202c",
    root: "#5a9fff",
    rootText: "#ffffff",
    node: "#203746",
    nodeText: "#e6f4fa",
    note: "#b3cbd4",
    nodeStroke: "#7b9faa",
    selected: "#a7d8ff",
    summary: "#dfb074",
  },
  forest: {
    background: "#14251d",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#7bd38d",
    relationship: "#d59ac8",
    relationshipText: "#f4c9ec",
    relationshipOutline: "#14251d",
    root: "#55b878",
    rootText: "#ffffff",
    node: "#24392b",
    nodeText: "#e2f2e5",
    note: "#b3d0b9",
    nodeStroke: "#638a6d",
    selected: "#9be3ad",
    summary: "#dbb676",
  },
  midnight: {
    background: "#171527",
    nodeStyle: "cards",
    nodeRadius: 8,
    edge: "#a39aff",
    relationship: "#e3a5dc",
    relationshipText: "#f6c8ef",
    relationshipOutline: "#171527",
    root: "#7868e3",
    rootText: "#ffffff",
    node: "#282343",
    nodeText: "#eeeaff",
    note: "#bab2d6",
    nodeStroke: "#7770a8",
    selected: "#b2aaff",
    summary: "#e9c883",
  },
  youdao: {
    background: "#141b26",
    nodeStyle: "lines",
    nodeRadius: 0,
    edge: "#ff756c",
    relationship: "#e7a3b5",
    relationshipText: "#ffd0db",
    relationshipOutline: "#141b26",
    root: "#5a9fff",
    rootText: "#ffffff",
    node: "transparent",
    nodeText: "#e6edf7",
    note: "#afbccb",
    nodeStroke: "transparent",
    selected: "#a7d8ff",
    summary: "#dfb074",
  },
};

export function xmindColors(
  theme: XMindTheme,
  scheme: "light" | "dark" = "light",
): XMindThemeDefinition {
  return scheme === "dark"
    ? { ...xmindThemes[theme], ...darkXMindThemes[theme] }
    : xmindThemes[theme];
}

export function normalizeXMindTheme(value: unknown): XMindTheme {
  return value === "ocean" || value === "forest" || value === "midnight" || value === "youdao"
    ? value
    : "classic";
}
