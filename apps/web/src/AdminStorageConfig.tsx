import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Select, Space } from "antd";
import { request } from "./api";

type Kind = "startup" | "local" | "s3" | "webdav";
type Config = {
  kind: Kind;
  directory?: string;
  endpoint?: string;
  bucket?: string;
  region?: string;
  prefix?: string;
  username?: string;
  secret?: string;
  has_secret?: boolean;
};
export const storageNames = {
  startup: "服务启动配置",
  local: "本地目录",
  s3: "S3",
  webdav: "WebDAV",
};

export function StorageConfigPanel({
  token,
  scope,
}: {
  token: string;
  scope: "online" | "backup";
}) {
  const online = scope === "online";
  const path = "/api/v1/admin/storage/" + scope;
  const [saved, setSaved] = useState<Config>();
  const [draft, setDraft] = useState<Config>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [form] = Form.useForm<Config>();
  const kind = Form.useWatch("kind", form) ?? saved?.kind;
  useEffect(() => {
    let active = true;
    request(token, path)
      .then((r) => r.json())
      .then((value: Config) => {
        if (active) setSaved(value);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [token, path]);
  async function save(value: Config) {
    setBusy(true);
    setMessage("");
    setError("");
    try {
      const response = await request(token, path, "PUT", value);
      const config: Config = await response.json();
      setSaved(config);
      form.setFieldValue("secret", "");
      setDraft(undefined);
      setMessage(online ? "在线内容已校验，存储已切换" : "备份存储已保存");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setDraft(undefined);
    } finally {
      setBusy(false);
    }
  }
  const title = online ? "在线笔记与附件" : "备份存储";
  const required = [{ required: true, message: "请填写此项" }];
  return (
    <Card title={title} loading={!saved && !error}>
      {saved && (
        <Form
          form={form}
          layout="vertical"
          name={scope}
          disabled={busy}
          initialValues={{ region: "us-east-1", ...saved }}
          onFinish={(value) => (online ? setDraft(value) : void save(value))}
        >
          <Form.Item
            name="kind"
            label="存储方式"
            extra={
              online
                ? "迁移范围包括笔记正文、历史版本、附件、加密笔记库和导出文件。账户、索引与同步记录保存在服务器 SQLite 数据库。"
                : "远程备份上传并读回校验后会保留一份本地副本。"
            }
          >
            <Select
              options={(online
                ? (["startup", "local", "s3", "webdav"] as const)
                : (["local", "s3", "webdav"] as const)
              ).map((value) => ({ value, label: storageNames[value] }))}
            />
          </Form.Item>
          {(!online || kind === "local") && (
            <Form.Item
              name="directory"
              label={online ? "在线数据目录" : "本地备份目录"}
              rules={required}
            >
              <Input />
            </Form.Item>
          )}
          {(kind === "s3" || kind === "webdav") && (
            <div className="gm-fields" key={kind}>
              <Form.Item
                name="endpoint"
                label={kind === "s3" ? "S3 服务地址" : "WebDAV 目录地址"}
                rules={kind === "webdav" ? required : []}
                preserve={false}
              >
                <Input
                  placeholder={
                    kind === "s3"
                      ? "使用 AWS 默认地址时留空"
                      : "https://example.com/dav/wenote/"
                  }
                />
              </Form.Item>
              {kind === "s3" && (
                <>
                  <Form.Item
                    name="bucket"
                    label="存储桶"
                    rules={required}
                    preserve={false}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item
                    name="region"
                    label="区域"
                    rules={required}
                    preserve={false}
                  >
                    <Input />
                  </Form.Item>
                  <Form.Item name="prefix" label="对象前缀" preserve={false}>
                    <Input />
                  </Form.Item>
                </>
              )}
              <Form.Item
                name="username"
                label={kind === "s3" ? "Access Key ID" : "WebDAV 用户名"}
                rules={kind === "s3" ? required : []}
                preserve={false}
              >
                <Input autoComplete="off" />
              </Form.Item>
              <Form.Item
                name="secret"
                label={kind === "s3" ? "Secret Access Key" : "WebDAV 密码"}
                preserve={false}
              >
                <Input.Password
                  autoComplete="new-password"
                  placeholder={
                    saved.has_secret && saved.kind === kind
                      ? "同一账户和地址留空可保留凭据"
                      : undefined
                  }
                />
              </Form.Item>
            </div>
          )}
          <Button type="primary" htmlType="submit" loading={busy}>
            {online ? "迁移在线存储" : "保存备份存储"}
          </Button>
        </Form>
      )}
      {error && <Alert type="error" showIcon title={error} role="alert" />}
      {message && (
        <Alert type="success" showIcon title={message} role="status" />
      )}
      <Modal
        title="迁移在线存储"
        open={!!draft}
        confirmLoading={busy}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        cancelButtonProps={{ disabled: busy }}
        onCancel={() => setDraft(undefined)}
        onOk={() => draft && void save(draft)}
        okText="确认迁移"
        cancelText="取消"
      >
        <Space orientation="vertical">
          <strong>
            {draft && storageNames[draft.kind]}{" "}
            {draft?.directory || draft?.endpoint || draft?.bucket}
          </strong>
          <span>
            迁移期间会暂停访问。服务器将复制并逐个校验已有内容，成功后切换到新位置，原位置保留副本。
          </span>
        </Space>
      </Modal>
    </Card>
  );
}
