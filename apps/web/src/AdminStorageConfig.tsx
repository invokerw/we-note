import { useEffect, useState } from "react";
import { Alert, Button, Card, Form, Input, Modal, Select, Space } from "antd";
import { PlusOutlined } from "@ant-design/icons";
import { DataTable, Status } from "./AdminUI";
import { request } from "./api";

export const storageNames = {
  startup: "服务启动配置",
  local: "本地目录",
  s3: "S3",
  webdav: "WebDAV",
};
type Kind = keyof typeof storageNames;
type Profile = {
  id: string;
  name: string;
  kind: Kind;
  directory?: string;
  endpoint?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  username?: string;
  secret?: string;
  has_secret?: boolean;
};
type Scope = "online" | "backup";
type Catalog = {
  profiles: Profile[];
  online: string;
  backup: string;
  revision: number;
};
type Dialog =
  | { mode: "edit"; profile?: Profile }
  | { mode: "delete"; profile: Profile }
  | { mode: "bind"; profile: Profile; scope: Scope };
const path = "/api/v1/admin/storage-catalog";
const scopeNames = { online: "在线内容", backup: "备份" };
const required = [{ required: true, whitespace: true, message: "请填写此项" }];
function address(p: Profile) {
  if (p.kind === "s3") return [p.bucket, p.prefix].filter(Boolean).join("/");
  if (p.kind === "webdav") return p.endpoint;
  if (p.kind === "local") return p.directory;
  return "使用服务启动时指定的位置";
}

function ProfileFields({
  profile,
  onSave,
  disabled,
}: {
  profile?: Profile;
  onSave: (value: Profile) => void;
  disabled: boolean;
}) {
  const [form] = Form.useForm<Profile>();
  const kind = Form.useWatch("kind", form) ?? profile?.kind ?? "local";
  return (
    <Form
      id="storage-profile-fields"
      form={form}
      layout="vertical"
      disabled={disabled}
      initialValues={{ kind: "local", region: "us-east-1", ...profile }}
      onFinish={onSave}
    >
      <Form.Item name="name" label="位置名称" rules={required}>
        <Input maxLength={80} placeholder="例如：工作室 NAS" autoFocus />
      </Form.Item>
      <Form.Item name="kind" label="存储类型">
        <Select
          options={(Object.keys(storageNames) as Kind[])
            .filter((k) => k !== "startup" || profile?.kind === "startup")
            .map((value) => ({ value, label: storageNames[value] }))}
        />
      </Form.Item>
      {kind === "local" && (
        <Form.Item name="directory" label="本地目录" rules={required}>
          <Input placeholder="/data/wenote" />
        </Form.Item>
      )}
      {(kind === "s3" || kind === "webdav") && (
        <>
          <Form.Item
            name="endpoint"
            label={kind === "s3" ? "S3 服务地址" : "WebDAV 目录地址"}
            rules={kind === "webdav" ? required : []}
          >
            <Input
              placeholder={
                kind === "s3"
                  ? "使用 AWS 默认地址时留空"
                  : "https://example.com/dav/wenote/"
              }
            />
          </Form.Item>
          <div className="gm-fields">
            {kind === "s3" && (
              <>
                <Form.Item name="bucket" label="存储桶" rules={required}>
                  <Input />
                </Form.Item>
                <Form.Item name="region" label="区域" rules={required}>
                  <Input />
                </Form.Item>
                <Form.Item name="prefix" label="对象前缀">
                  <Input />
                </Form.Item>
              </>
            )}
            <Form.Item
              name="username"
              label={kind === "s3" ? "Access Key ID" : "WebDAV 用户名"}
              rules={kind === "s3" ? required : []}
            >
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item
              name="secret"
              label={kind === "s3" ? "Secret Access Key" : "WebDAV 密码"}
            >
              <Input.Password
                autoComplete="new-password"
                placeholder={
                  profile?.has_secret && profile.kind === kind
                    ? "同一账户和地址留空可保留凭据"
                    : undefined
                }
              />
            </Form.Item>
          </div>
          <Form.Item
            name="directory"
            label="备份的本地副本目录"
            extra="留空时沿用服务器当前的备份目录。"
          >
            <Input />
          </Form.Item>
        </>
      )}
    </Form>
  );
}

export function StorageConfigPanel({ token }: { token: string }) {
  const [catalog, setCatalog] = useState<Catalog>();
  const [dialog, setDialog] = useState<Dialog>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    request(token, path)
      .then((r) => r.json())
      .then((c) => {
        if (active) setCatalog(c);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [token]);
  function open(next: Dialog) {
    setError("");
    setMessage("");
    setDialog(next);
  }
  async function change(
    suffix: string,
    method: string,
    input: object,
    success: string,
  ) {
    if (!catalog || busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await request(token, path + suffix, method, {
        ...input,
        revision: catalog.revision,
      });
      setCatalog(await response.json());
      setDialog(undefined);
      setMessage(success);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      try {
        const fresh: Catalog = await (await request(token, path)).json();
        if (fresh.revision !== catalog.revision) {
          setCatalog(fresh);
          setDialog(undefined);
        }
      } catch {
        /* Keep the original operation error visible. */
      }
    } finally {
      setBusy(false);
    }
  }
  const editID = dialog?.mode === "edit" ? dialog.profile?.id : undefined;
  const usesOnline = !!editID && editID === catalog?.online,
    usesBackup = !!editID && editID === catalog?.backup;
  const alert = error && (
    <Alert type="error" showIcon title={error} role="alert" />
  );
  return (
    <div className="gm-settings">
      {!dialog && alert}
      {message && (
        <Alert type="success" title={message} showIcon role="status" />
      )}
      <Card
        title="存储位置"
        loading={!catalog && !error}
        extra={
          <Button
            type="primary"
            aria-label="添加存储位置"
            icon={<PlusOutlined />}
            disabled={!catalog || busy}
            onClick={() => open({ mode: "edit" })}
          >
            添加存储位置
          </Button>
        }
      >
        <DataTable<Profile>
          rowKey="id"
          dataSource={catalog?.profiles || []}
          columns={[
            {
              title: "名称",
              dataIndex: "name",
              render: (name, p) => (
                <div className="gm-location">
                  <strong>{name}</strong>
                  <small title={address(p)}>{address(p)}</small>
                </div>
              ),
            },
            { title: "类型", render: (_, p) => storageNames[p.kind] },
            {
              title: "当前用途",
              render: (_, p) => (
                <Space size={4} wrap>
                  {catalog?.online === p.id && (
                    <Status color="purple">在线内容</Status>
                  )}
                  {catalog?.backup === p.id && (
                    <Status color="blue">备份</Status>
                  )}
                  {catalog?.online !== p.id && catalog?.backup !== p.id && (
                    <Status>未使用</Status>
                  )}
                </Space>
              ),
            },
            {
              title: "操作",
              render: (_, p) => (
                <Space size={0}>
                  <Button
                    type="link"
                    onClick={() => open({ mode: "edit", profile: p })}
                  >
                    编辑
                  </Button>
                  <Button
                    type="link"
                    danger
                    disabled={
                      p.id === catalog?.online || p.id === catalog?.backup
                    }
                    onClick={() => open({ mode: "delete", profile: p })}
                  >
                    移除
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>
      {catalog && (
        <Card title="用途分配">
          <div className="gm-fields">
            {(["online", "backup"] as const).map((scope) => (
              <div key={scope} className="gm-storage-binding">
                <label htmlFor={"storage-binding-" + scope}>
                  {scopeNames[scope]}
                </label>
                <Select
                  id={"storage-binding-" + scope}
                  value={catalog[scope]}
                  disabled={busy}
                  options={catalog.profiles
                    .filter((p) => scope === "online" || p.kind !== "startup")
                    .map((p) => ({ value: p.id, label: p.name }))}
                  onChange={(id) => {
                    const profile = catalog.profiles.find((p) => p.id === id);
                    if (profile) open({ mode: "bind", scope, profile });
                  }}
                />
                <small>
                  {scope === "online"
                    ? "笔记正文、历史版本、附件、历史加密库密文及导出文件。"
                    : "手动备份、定时备份和恢复前自动备份。"}
                </small>
              </div>
            ))}
          </div>
        </Card>
      )}
      {dialog && (
        <Modal
          open
          title={
            dialog.mode === "edit"
              ? editID
                ? "编辑存储位置"
                : "添加存储位置"
              : dialog.mode === "delete"
                ? "移除存储位置"
                : `切换${scopeNames[dialog.scope]}位置`
          }
          cancelText="取消"
          confirmLoading={busy}
          closable={!busy}
          keyboard={!busy}
          mask={{ closable: !busy }}
          cancelButtonProps={{ disabled: busy }}
          onCancel={() => {
            setDialog(undefined);
            setError("");
          }}
          okText={
            dialog.mode === "edit"
              ? "保存位置"
              : dialog.mode === "delete"
                ? "确认移除"
                : dialog.scope === "online"
                  ? "确认迁移"
                  : "确认切换"
          }
          okButtonProps={
            dialog.mode === "edit"
              ? { htmlType: "submit", form: "storage-profile-fields" }
              : { danger: dialog.mode === "delete" }
          }
          onOk={
            dialog.mode === "edit"
              ? undefined
              : () =>
                  dialog.mode === "delete"
                    ? void change(
                        "/profiles/" + dialog.profile.id,
                        "DELETE",
                        {},
                        "存储位置已移除",
                      )
                    : void change(
                        "/bindings/" + dialog.scope,
                        "PUT",
                        { profile_id: dialog.profile.id },
                        scopeNames[dialog.scope] + "位置已切换",
                      )
          }
        >
          {alert}
          {dialog.mode === "edit" ? (
            <>
              <ProfileFields
                profile={dialog.profile}
                disabled={busy}
                onSave={(value) =>
                  void change(
                    editID ? "/profiles/" + editID : "/profiles",
                    editID ? "PUT" : "POST",
                    value,
                    "存储位置已保存",
                  )
                }
              />
              {(usesOnline || usesBackup) && (
                <Alert
                  type="info"
                  showIcon
                  title={[
                    usesOnline
                      ? "变更在线存储地址时，将暂停访问并迁移已有内容。"
                      : "",
                    usesBackup ? "后续备份将使用更新后的配置。" : "",
                  ].join("")}
                />
              )}
            </>
          ) : dialog.mode === "delete" ? (
            <p>
              从位置列表移除「{dialog.profile.name}」？该位置中的文件将保留。
            </p>
          ) : (
            <>
              <p>
                将{scopeNames[dialog.scope]}从「
                {
                  catalog?.profiles.find((p) => p.id === catalog[dialog.scope])
                    ?.name
                }
                」切换到「{dialog.profile.name}」。
              </p>
              <p>
                {dialog.scope === "online"
                  ? "迁移期间暂停访问。已有内容复制并校验完成后，服务才会使用新位置。"
                  : "此后创建的备份将使用新位置。历史备份仍从创建时的位置读取。"}
              </p>
            </>
          )}
        </Modal>
      )}
    </div>
  );
}
