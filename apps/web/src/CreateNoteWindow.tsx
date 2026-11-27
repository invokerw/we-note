import { useLayoutEffect, useRef, useState } from "react";
import FileMarkdownOutlined from "@ant-design/icons/FileMarkdownOutlined";
import ApartmentOutlined from "@ant-design/icons/ApartmentOutlined";
import FileAddOutlined from "@ant-design/icons/FileAddOutlined";
import FolderOpenOutlined from "@ant-design/icons/FolderOpenOutlined";
import { EntryDialog } from "./EntryDialog";
import { type EntryIO } from "./libraryEntries";

const groups = [
  { title: "新建笔记", actions: [
    { label: "Markdown", icon: FileMarkdownOutlined, color: "blue" },
    { label: "思维导图", icon: ApartmentOutlined, color: "purple" },
  ] },
  { title: "更多方式", actions: [
    { label: "上传文件", icon: FileAddOutlined, color: "amber" },
    { label: "上传文件夹", icon: FolderOpenOutlined, color: "green" },
  ] },
] as const;

type Action = typeof groups[number]["actions"][number]["label"];

export function CreateNoteWindow({ anchor, phone, folder, paths, io, createAtPath, browse, close }: {
  anchor: HTMLElement;
  phone: boolean;
  folder: string;
  paths: string[];
  io: EntryIO;
  createAtPath?: EntryIO["write"];
  browse: (folder: string) => void;
  close: () => void;
}) {
  const picker = useRef<HTMLDialogElement>(null);
  const [command, setCommand] = useState<Action | null>(null);
  useLayoutEffect(() => {
    const dialog = picker.current;
    if (!dialog) return;
    dialog.showModal();
    const position = () => {
      if (phone) return;
      const trigger = anchor.getBoundingClientRect();
      const {width, height} = dialog.getBoundingClientRect();
      const top = trigger.bottom + 6 + height <= innerHeight ? trigger.bottom + 6 : trigger.top - height - 6;
      dialog.style.left = `${Math.max(8, Math.min(trigger.left, innerWidth - width - 8))}px`;
      dialog.style.top = `${Math.max(8, Math.min(top, innerHeight - height - 8))}px`;
    };
    position();
    window.addEventListener("resize", position);
    return () => {
      window.removeEventListener("resize", position);
      dialog.close();
      dialog.style.removeProperty("left");
      dialog.style.removeProperty("top");
    };
  }, [anchor, phone, command]);

  if (command) return <EntryDialog command={{ label: command, source: folder, expected: {} }}
    io={io} paths={paths} createAtPath={phone ? undefined : createAtPath} onChange={(_, destination) => browse(destination)} close={close} />;
  return (
    <dialog ref={picker} aria-label="新建笔记" className={"create-note-window" + (phone ? " handset" : "")}
      onCancel={e => { e.preventDefault(); close(); }}
      onClick={e => {
        if (e.target !== e.currentTarget) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) close();
      }}>
      {groups.map(({title, actions}) => (
        <section key={title} aria-label={title}>
          <h2>{title}</h2>
          <div className="create-note-choices">
            {actions.map(({label, icon: Icon, color}) => (
              <button key={label} type="button" onClick={() => setCommand(label)}>
                <span aria-hidden="true" className={"create-note-icon " + color}><Icon /></span>
                {label}
              </button>
            ))}
          </div>
        </section>
      ))}
      <button type="button" className="create-note-close" aria-label="关闭新建笔记窗口" onClick={close}>×</button>
    </dialog>
  );
}
