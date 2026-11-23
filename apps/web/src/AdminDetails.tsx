import { useEffect, useState } from "react";
import { request } from "./api";

type Asset = {
  asset_id: string;
  name: string;
  owner_email: string;
  vault_name: string;
  content_size: number;
  deleted: boolean;
};
type Delivery = {
  id: string;
  recipient: string;
  kind: string;
  status: string;
  error: string;
  created_at: string;
};
type Event = {
  id: number;
  action: string;
  actor_user_id: string;
  object_id: string;
  created_at: string;
};
export function Inventory({
  token,
  action,
}: {
  token: string;
  action: (path: string, success: string) => void;
}) {
  const [storage, setStorage] = useState<Record<string, number>>({}),
    [assets, setAssets] = useState<Asset[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      request(token, "/api/v1/admin/assets")
        .then((r) => r.json())
        .then((r) => setAssets(r.assets)),
      request(token, "/api/v1/admin/storage")
        .then((r) => r.json())
        .then(setStorage),
    ]).catch((e) => setError(String(e)));
  }, [token]);
  return (
    <section className="admin-panel">
      <h2>附件与存储</h2>
      {error && <p role="alert">{error}</p>}
      <div className="admin-cards">
        {Object.entries({
          blob_bytes: "去重后对象占用",
          current_file_bytes: "当前笔记",
          asset_bytes: "在用附件",
          pending_upload_bytes: "待完成上传",
          historical_bytes: "历史版本",
          reclaimable_bytes: "已删除附件（逻辑大小）",
        }).map(([id, label]) => (
          <section className="admin-card" key={id}>
            <span>{label}</span>
            <strong>{storage[id]?.toLocaleString() ?? "—"} B</strong>
          </section>
        ))}
      </div>
      <h3>附件</h3>
      {!assets.length ? (
        <p>暂无附件</p>
      ) : (
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>附件名</th>
                <th>所属用户</th>
                <th>笔记库</th>
                <th>字节数</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.asset_id}>
                  <td>{a.name}</td>
                  <td>{a.owner_email}</td>
                  <td>{a.vault_name}</td>
                  <td>{a.content_size.toLocaleString()}</td>
                  <td>
                    <button
                      onClick={() => {
                        if (a.deleted || confirm(`将 ${a.name} 移入回收站？`))
                          action(
                            `assets/${a.asset_id}/${a.deleted ? "restore" : "delete"}`,
                            "附件状态已更新",
                          );
                      }}
                    >
                      {a.deleted ? "恢复附件" : "移入回收站"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
export function Logs({ token }: { token: string }) {
  const [events, setEvents] = useState<Event[]>([]),
    [mail, setMail] = useState<Delivery[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    Promise.all([
      request(token, "/api/v1/admin/audit")
        .then((r) => r.json())
        .then((r) => setEvents(r.events)),
      request(token, "/api/v1/admin/mail")
        .then((r) => r.json())
        .then((r) => setMail(r.deliveries)),
    ]).catch((e) => setError(String(e)));
  }, [token]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <section className="admin-panel">
        <h2>管理操作</h2>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>操作</th>
                <th>操作者 ID</th>
                <th>对象</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.created_at).toLocaleString()}</td>
                  <td>{e.action}</td>
                  <td>{e.actor_user_id}</td>
                  <td>{e.object_id}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="admin-panel">
        <h2>邮件投递</h2>
        <div className="admin-table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>收件人</th>
                <th>类型</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              {mail.map((m) => (
                <tr key={m.id}>
                  <td>{new Date(m.created_at).toLocaleString()}</td>
                  <td>{m.recipient}</td>
                  <td>{m.kind}</td>
                  <td>
                    {m.status} {m.error}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
