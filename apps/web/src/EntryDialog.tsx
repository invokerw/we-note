import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MarkdownView } from "./markdown/Markdown";
import { noteLimit } from "./plugins/archive";
import {
  containsEntry,
  entryName,
  formats,
  isFolder,
  marker,
  newContent,
  parentFolder,
  printableText,
  templates,
  wordText,
  type EntryIO,
  type Format,
} from "./libraryEntries";

export type EntryCommand = {
  label: string;
  source: string;
  expected: Record<string, string>;
};
const uploads = ["上传文件", "上传文件夹", "Word转笔记"];
function copyName(path: string) {
  const name = entryName(path);
  const ext = isFolder(path) ? -1 : name.lastIndexOf(".");
  return ext < 1
    ? name + " 副本"
    : name.slice(0, ext) + " 副本" + name.slice(ext);
}
export function EntryDialog({
  command,
  io,
  paths,
  onChange,
  close,
}: {
  command: EntryCommand;
  io: EntryIO;
  paths: string[];
  onChange: (src: string, dst: string) => void;
  close: () => void;
}) {
  const { label, source, expected } = command,
    folder = isFolder(source),
    container = folder ? source : parentFolder(source),
    format = Object.hasOwn(formats, label) ? (label as Format) : null;
  const newFolder = format === "文件夹",
    destination = label === "移动到" || label === "复制",
    upload = uploads.includes(label),
    pdf = label === "导出为PDF";
  const [name, setName] = useState(
      format
        ? formats[format]
        : label === "复制"
          ? copyName(source)
          : entryName(source),
    ),
    [dir, setDir] = useState(parentFolder(source)),
    [template, setTemplate] = useState<keyof typeof templates>("会议记录");
  const [error, setError] = useState(""),
    [working, setWorking] = useState(false),
    [preview, setPreview] = useState<string | null>(null),
    [files, setFiles] = useState<File[]>([]);
  const dialog = useRef<HTMLDialogElement>(null),
    running = useRef(false);
  const folders = new Set([""]);
  for (const path of paths) {
    let p = isFolder(path) ? path : parentFolder(path);
    while (p && !folders.has(p)) {
      folders.add(p);
      p = parentFolder(p);
    }
  }
  useLayoutEffect(() => {
    const el = dialog.current!;
    el.showModal();
    return () => el.close();
  }, []);
  useEffect(() => {
    if (!pdf) return;
    let live = true;
    io.read(source)
      .then((bytes) => {
        if (live) setPreview(printableText(source, bytes));
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [pdf, source]);
  useEffect(() => {
    if (label === "下载" || label === "复制路径") {
      const frame = requestAnimationFrame(() => void submit());
      return () => cancelAnimationFrame(frame);
    }
  }, []);
  function checkName(value: string) {
    if (
      !value.trim() ||
      /[\\/:*?"<>|\u0000-\u001f]/.test(value) ||
      [".", ".."].includes(value)
    )
      throw Error("请输入有效的名称");
  }
  function checkFree(path: string) {
    const key = path.replace(/\/$/, "").normalize().toLowerCase();
    if (
      paths.some((p) => {
        const other = p.replace(/\/$/, "").normalize().toLowerCase();
        return (
          other === key ||
          other.startsWith(key + "/") ||
          (!isFolder(p) && key.startsWith(other + "/"))
        );
      })
    )
      throw Error("目标位置已存在同名项目");
  }
  async function submit() {
    if (running.current) return;
    running.current = true;
    setError("");
    setWorking(true);
    try {
      if (label === "项目信息") {
        close();
        return;
      }
      if (label === "下载")
        await io.output(entryName(source), await io.read(source));
      else if (label === "复制路径")
        await navigator.clipboard.writeText(source);
      else if (pdf) {
        await io.print(entryName(source));
        return;
      } else if (upload) {
        if (!files.length) throw Error("请先选择文件");
        const plans = files.map((file) => {
          const relative = file.webkitRelativePath || file.name;
          const path =
            container +
            (label === "Word转笔记"
              ? relative.replace(/\.docx$/i, ".md")
              : relative);
          if (file.size > noteLimit) throw Error(file.name + " 超过 16 MiB");
          if (
            label === "Word转笔记"
              ? !/\.docx$/i.test(file.name)
              : !/\.(md|txt|json|xmind)$/i.test(path)
          )
            throw Error("不支持的文件格式：" + file.name);
          checkFree(path);
          return { file, path };
        });
        const written = new Set<File>();
        try {
          for (const { file, path } of plans) {
            const bytes = new Uint8Array(await file.arrayBuffer());
            await io.write(
              path,
              label === "Word转笔记" ? wordText(bytes) : bytes,
            );
            written.add(file);
          }
        } finally {
          setFiles(files.filter((f) => !written.has(f)));
          await io.refresh();
        }
        onChange("", container);
      } else if (format) {
        checkName(name);
        let path = container + name.trim();
        const ext = newFolder
          ? ""
          : formats[format].slice(formats[format].lastIndexOf("."));
        if (ext && !path.toLowerCase().endsWith(ext)) path += ext;
        checkFree(path);
        await io.write(
          newFolder ? path + "/" + marker : path,
          newContent(format, path, template),
        );
        await io.refresh();
        onChange("", newFolder ? path + "/" : container);
        if (!newFolder) await io.openCreated(path);
      } else {
        const op =
          label === "删除" ? "delete" : label === "复制" ? "copy" : "move";
        let dst = "";
        if (op !== "delete") {
          checkName(name);
          dst =
            (destination ? dir : parentFolder(source)) +
            name.trim() +
            (folder ? "/" : "");
          if (folder && containsEntry(source, dst))
            throw Error("不能将文件夹放入自身或子目录");
          checkFree(dst);
        }
        await io.change(op, source, dst, expected);
        await io.refresh();
        if (op !== "copy" && folder) onChange(source, dst);
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      running.current = false;
      setWorking(false);
    }
  }
  const count = paths.filter(
    (p) => !isFolder(p) && containsEntry(source, p),
  ).length;
  return createPortal(
    <dialog
      ref={dialog}
      className={"entry-dialog" + (pdf ? " print-preview" : "")}
      aria-labelledby="entry-dialog-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!working) close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 id="entry-dialog-title">
          {format
            ? "新建" + (format === "从模板新建" ? "模板笔记" : format)
            : label}
        </h2>
        <p className="entry-location">
          {format || upload
            ? container || "我的文件夹"
            : source || "我的文件夹"}
        </p>
        {label === "删除" && (
          <p>
            确认删除「{entryName(source)}」
            {folder ? `及其中的 ${count} 篇笔记` : ""}？
          </p>
        )}
        {label === "项目信息" && (
          <p>
            {folder
              ? `文件夹 · ${count} 篇笔记`
              : `文件类型 · ${source.split(".").at(-1)?.toUpperCase()}`}
          </p>
        )}
        {destination && (
          <label>
            目标文件夹
            <select value={dir} onChange={(e) => setDir(e.target.value)}>
              {[...folders]
                .sort()
                .filter((p) => !folder || !containsEntry(source, p))
                .map((p) => (
                  <option key={p} value={p}>
                    {p || "我的文件夹"}
                  </option>
                ))}
            </select>
          </label>
        )}
        {format === "从模板新建" && (
          <label>
            模板
            <select
              value={template}
              onChange={(e) => {
                const v = e.target.value as keyof typeof templates;
                setTemplate(v);
                setName(v + ".md");
              }}
            >
              {Object.keys(templates).map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
          </label>
        )}
        {(format || destination || label === "重命名") && (
          <label>
            名称
            <input
              autoFocus
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              onFocus={(e) => e.target.select()}
            />
          </label>
        )}
        {upload && (
          <label>
            {label === "上传文件夹" ? "选择文件夹" : "选择文件"}
            <input
              type="file"
              ref={(el) => {
                if (el && label === "上传文件夹")
                  el.setAttribute("webkitdirectory", "");
              }}
              multiple={label !== "Word转笔记"}
              accept={
                label === "Word转笔记" ? ".docx" : ".md,.txt,.json,.xmind"
              }
              onChange={(e) =>
                setFiles(Array.from(e.currentTarget.files || []))
              }
            />
            {files.length > 0 && <small>已选 {files.length} 个文件</small>}
          </label>
        )}
        {pdf && (
          <section className="print-sheet">
            <h1>{entryName(source)}</h1>
            {preview !== null ? (
              /\.(md|xmind)$/i.test(source) ? (
                <MarkdownView text={preview} io={{ image: io.image }} />
              ) : (
                <pre>{preview}</pre>
              )
            ) : (
              !error && "正在载入…"
            )}
          </section>
        )}
        {error && <p role="alert">{error}</p>}
        <footer>
          <button type="button" disabled={working} onClick={close}>
            {pdf || label === "项目信息" ? "关闭" : "取消"}
          </button>
          {label !== "项目信息" && (
            <button
              className="primary"
              disabled={
                working ||
                (pdf && preview === null) ||
                (upload && !files.length)
              }
            >
              {pdf
                ? "打印 / 保存为 PDF"
                : label === "删除"
                  ? "确认删除"
                  : format
                    ? "创建"
                    : upload
                      ? "导入"
                      : "确定"}
            </button>
          )}
        </footer>
      </form>
    </dialog>,
    document.body,
  );
}
