import { useState } from "react";
import {
  topic,
  topics,
  setTopicNote,
  type Workbook,
  type Topic,
  type Sheet,
} from "./xmind";
function Tree({
  n,
  select,
  active,
}: {
  n: Topic;
  select: (id: string) => void;
  active: string;
}) {
  const ch = Object.values(n.children ?? {}).flat();
  const button = (
    <button
      style={{
        backgroundColor: /^#[a-f\d]{6}$/i.test(
          n.style?.properties?.["svg:fill"] || "",
        )
          ? n.style!.properties!["svg:fill"]
          : undefined,
      }}
      aria-pressed={active === n.id}
      onClick={() => select(n.id)}
    >
      {n.title || "未命名"}
    </button>
  );
  return (
    <li>
      {ch.length ? (
        <details open>
          <summary>{button}</summary>
          <ul>
            {ch.map((c) => (
              <Tree key={c.id} n={c} select={select} active={active} />
            ))}
          </ul>
        </details>
      ) : (
        button
      )}
    </li>
  );
}
export function MapEditor({
  book,
  index,
  switchSheet,
  edit,
}: {
  book: Workbook;
  index: number;
  switchSheet: (i: number) => void;
  edit: (book: Workbook) => void;
}) {
  const [selected, select] = useState(""),
    [target, setTarget] = useState("");
  const sheet = book.sheets[index],
    nodes = topics(sheet.rootTopic),
    node = nodes.find((n) => n.id === selected) || sheet.rootTopic;
  function change(fn: (n: Topic, s: Sheet) => void) {
    const s = structuredClone(sheet);
    fn(
      topics(s.rootTopic).find((n) => n.id === node.id)!,
      s,
    );
    topics(s.rootTopic);
    edit({
      ...book,
      sheets: book.sheets.map((old, i) => (i === index ? s : old)),
    });
  }
  const children = node.children?.attached || [];
  return (
    <>
      <label>
        工作表
        <select
          value={index}
          onChange={(e) => {
            switchSheet(Number(e.target.value));
            select("");
            setTarget("");
          }}
        >
          {book.sheets.map((s, i) => (
            <option key={i} value={i}>
              {s.title || s.rootTopic.title}
            </option>
          ))}
        </select>
      </label>
      <nav className="mindmap" aria-label="XMind 主题树">
        <ul>
          <Tree
            n={sheet.rootTopic}
            active={node.id}
            select={(id) => {
              select(id);
              setTarget("");
            }}
          />
        </ul>
      </nav>
      <fieldset>
        <legend>主题</legend>
        <label>
          主题标题
          <input
            value={node.title ?? ""}
            onChange={(e) =>
              change((n) => {
                n.title = e.target.value;
              })
            }
          />
        </label>
        <label>
          主题颜色
          <input
            type="color"
            value={node.style?.properties?.["svg:fill"] || "#e8f0e4"}
            onChange={(e) =>
              change((n) => {
                const style = (n.style ??= { id: crypto.randomUUID() });
                (style.properties ??= {})["svg:fill"] = e.target.value;
              })
            }
          />
        </label>
        <label>
          主题备注
          <textarea
            value={node.notes?.plain?.content || ""}
            onChange={(e) =>
              change((n) => {
                setTopicNote(n, e.target.value);
              })
            }
          />
        </label>
        <button
          onClick={() =>
            change((n) => {
              const child = topic("新主题");
              ((n.children ??= {}).attached ??= []).push(child);
              select(child.id);
            })
          }
        >
          添加子主题
        </button>
        {children.length > 1 && (
          <div>
            {children.map((c, i) => (
              <button
                key={c.id}
                disabled={!i}
                onClick={() =>
                  change((n) => {
                    const a = n.children!.attached;
                    [a[i - 1], a[i]] = [a[i], a[i - 1]];
                  })
                }
              >
                上移 {c.title}
              </button>
            ))}
          </div>
        )}
        <button
          disabled={!children.length}
          onClick={() =>
            change((n) => {
              const c = topic("概要");
              ((n.children ??= {}).summary ??= []).push(c);
              (n.summaries ??= []).push({
                id: crypto.randomUUID(),
                range: `(0,${children.length - 1})`,
                topicId: c.id,
              });
              select(c.id);
            })
          }
        >
          添加概要
        </button>
      </fieldset>
      <fieldset>
        <legend>关系线</legend>
        <label>
          目标主题
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">选择主题</option>
            {nodes
              .filter((n) => n.id !== node.id)
              .map((n) => (
                <option key={n.id} value={n.id}>
                  {n.title}
                </option>
              ))}
          </select>
        </label>
        <button
          disabled={!target || target === node.id}
          onClick={() =>
            change((n, s) => {
              (s.relationships ??= []).push({
                id: crypto.randomUUID(),
                end1Id: n.id,
                end2Id: target,
                title: "",
                controlPoints: {
                  0: { angle: 0, amount: 0.33 },
                  1: { angle: 0, amount: 0.33 },
                },
              });
              setTarget("");
            })
          }
        >
          添加关系线
        </button>
        {sheet.relationships?.map((r, i) => (
          <div key={r.id}>
            {nodes.find((n) => n.id === r.end1Id)?.title} →{" "}
            {nodes.find((n) => n.id === r.end2Id)?.title}{" "}
            <input
              aria-label="关系线名称"
              value={r.title || ""}
              onChange={(e) =>
                change((_, s) => {
                  s.relationships![i].title = e.target.value;
                })
              }
            />
            <button
              onClick={() =>
                change((_, s) => {
                  s.relationships!.splice(i, 1);
                })
              }
            >
              移除关系线
            </button>
          </div>
        ))}
      </fieldset>
    </>
  );
}
