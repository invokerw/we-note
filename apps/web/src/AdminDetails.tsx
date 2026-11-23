import { useEffect, useState } from "react";
import { Alert, Card } from "antd";
import { DataTable, formatDate } from "./AdminUI";
import { request } from "./api";

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
