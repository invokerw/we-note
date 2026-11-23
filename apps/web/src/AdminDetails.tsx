import { useEffect, useState } from "react";
import { Alert, Button, Card, Modal } from "antd";
import { DataTable, formatBytes, formatDate } from "./AdminUI";
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
  const [selected, setSelected] = useState<Asset | null>(null);
  return (
    <>
      {error && <Alert title={error} type="error" showIcon />}
      <div className="gm-stat-grid">
        {Object.entries({
          blob_bytes: "去重后对象占用",
          current_file_bytes: "当前笔记",
          asset_bytes: "在用附件",
          pending_upload_bytes: "待完成上传",
          historical_bytes: "历史版本",
          reclaimable_bytes: "已删除附件（逻辑大小）",
        }).map(([key, title]) => (
          <div className="gm-stat" key={key}>
            <span>{title}</span>
            <strong>
              {storage[key] === undefined ? "—" : formatBytes(storage[key])}
            </strong>
          </div>
        ))}
      </div>
      <Card title="附件清单">
        <DataTable<Asset>
          rowKey="asset_id"
          dataSource={assets}
          columns={[
            { title: "附件名", dataIndex: "name" },
            { title: "所属用户", dataIndex: "owner_email" },
            { title: "笔记库", dataIndex: "vault_name" },
            { title: "大小", dataIndex: "content_size", render: formatBytes },
            {
              title: "操作",
              render: (_, a) => (
                <Button
                  size="small"
                  type="link"
                  danger={!a.deleted}
                  onClick={() =>
                    a.deleted
                      ? action(`assets/${a.asset_id}/restore`, "附件状态已更新")
                      : setSelected(a)
                  }
                >
                  {a.deleted ? "恢复附件" : "移入回收站"}
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="将附件移入回收站？"
        open={!!selected}
        okText="确认移入"
        okButtonProps={{ danger: true }}
        onCancel={() => setSelected(null)}
        onOk={() => {
          if (selected)
            action(`assets/${selected.asset_id}/delete`, "附件状态已更新");
          setSelected(null);
        }}
      >
        <p>{selected?.name}</p>
      </Modal>
    </>
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
      {error && <Alert type="error" title={error} />}
      <Card title="管理操作">
        <DataTable<Event>
          rowKey="id"
          dataSource={events}
          columns={[
            { title: "时间", dataIndex: "created_at", render: formatDate },
            { title: "操作", dataIndex: "action" },
            { title: "操作者 ID", dataIndex: "actor_user_id" },
            { title: "对象", dataIndex: "object_id" },
          ]}
        />
      </Card>
      <Card title="邮件投递">
        <DataTable<Delivery>
          rowKey="id"
          dataSource={mail}
          columns={[
            { title: "时间", dataIndex: "created_at", render: formatDate },
            { title: "收件人", dataIndex: "recipient" },
            { title: "类型", dataIndex: "kind" },
            {
              title: "结果",
              render: (_, m) => [m.status, m.error].filter(Boolean).join(" · "),
            },
          ]}
        />
      </Card>
    </>
  );
}
