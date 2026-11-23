import { cssLanguage } from "@codemirror/lang-css";
import { htmlLanguage } from "@codemirror/lang-html";
import { javascriptLanguage, jsxLanguage, tsxLanguage, typescriptLanguage } from "@codemirror/lang-javascript";
import { jsonLanguage } from "@codemirror/lang-json";
import { languageDataProp, StreamLanguage, syntaxHighlighting, type Language } from "@codemirror/language";
import { c, cpp, csharp, java, kotlin } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { standardSQL } from "@codemirror/legacy-modes/mode/sql";
import { yaml } from "@codemirror/legacy-modes/mode/yaml";
import { tagHighlighter, tags } from "@lezer/highlight";

const languages = new Map<string, Language>();
function register(names: string, language: Language) {
  for (const name of names.split(" ")) languages.set(name, language);
}
register("js javascript mjs cjs", javascriptLanguage);
register("ts typescript", typescriptLanguage);
register("jsx", jsxLanguage);
register("tsx", tsxLanguage);
register("json", jsonLanguage);
register("html htm", htmlLanguage);
register("css", cssLanguage);
register("py python python3", StreamLanguage.define(python));
register("bash sh shell zsh", StreamLanguage.define(shell));
register("go golang", StreamLanguage.define(go));
register("rust rs", StreamLanguage.define(rust));
register("java", StreamLanguage.define(java));
register("kotlin kt", StreamLanguage.define(kotlin));
register("c h", StreamLanguage.define(c));
register("cpp c++ cxx hpp", StreamLanguage.define(cpp));
register("csharp c# cs", StreamLanguage.define(csharp));
register("sql", StreamLanguage.define(standardSQL));
register("yaml yml", StreamLanguage.define(yaml));

export function fenceLanguage(info: string) {
  return languages.get(info.trim().split(/\s+/, 1)[0].toLowerCase()) ?? null;
}

export const codeTokens = tagHighlighter([
  { tag: tags.keyword, class: "md-keyword" },
  { tag: [tags.string, tags.regexp], class: "md-string" },
  { tag: [tags.number, tags.bool, tags.null, tags.atom], class: "md-literal" },
  { tag: [tags.function(tags.variableName), tags.propertyName, tags.tagName, tags.typeName], class: "md-name" },
  { tag: tags.comment, class: "md-comment" },
]);
const fenceScopes = new Set(Array.from(languages.values(), language => language.data));
export const liveCodeHighlight = syntaxHighlighting({
  ...codeTokens,
  scope: type => {
    const data = type.prop(languageDataProp);
    return !!data && fenceScopes.has(data);
  },
});
