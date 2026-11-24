import { AdminUsers, type AdminUser } from "./AdminUsers";
import { useEffect, useState } from "react";
import {
  Alert,
  Avatar,
  Button,
  Card,
  Drawer,
  Dropdown,
  Form,
  Input,
  Modal,
  Result,
  Space,
  Spin,
} from "antd";
import {
  AppstoreOutlined,
  TeamOutlined,
  MailOutlined,
  DatabaseOutlined,
  HistoryOutlined,
  SettingOutlined,
  CloudServerOutlined,
  MenuOutlined,
  ReloadOutlined,
  ArrowRightOutlined,
  FolderOpenOutlined,
  FileTextOutlined,
  PlusOutlined,
  DownOutlined,
  CloudUploadOutlined,
} from "@ant-design/icons";
import { AdminAuth } from "./AdminAuth";
import {
  AdminTheme,
  Brand,
  DataTable,
  formatBytes,
  formatDate,
  Status,
} from "./AdminUI";
import { SettingsPanel, type Settings } from "./AdminSettings";
import { StorageConfigPanel, storageNames } from "./AdminStorageConfig";
import { Inventory } from "./AdminInventory";
import { Logs } from "./AdminDetails";
import { request } from "./api";
type Overview = {
  users: number;
  active_users: number;
  pending_invites: number;
  vaults: number;
  files: number;
  assets: number;
  storage_bytes: number;
};
type Invite = {
  id: string;
  email: string;
  expires_at: string;
  used_at?: string;
  revoked_at?: string;
  created_at: string;
};
type Backup = {
  purpose?: string;
  destination?: keyof typeof storageNames;
  id: string;
  status: string;
  path?: string;
  size: number;
  checksum?: string;
  error?: string;
  created_at: string;
  completed_at?: string;
};

const pages = [
  {
    id: "overview",
    label: "总览",
    title: "服务端总览",
    icon: AppstoreOutlined,
  },
  { id: "users", label: "用户", title: "用户管理", icon: TeamOutlined },
  { id: "invites", label: "邀请", title: "邀请管理", icon: MailOutlined },
  {
    id: "storage",
    label: "附件与存储",
    title: "附件与存储",
    icon: DatabaseOutlined,
  },
  {
    id: "backups",
    label: "备份",
    title: "备份与恢复",
    icon: CloudUploadOutlined,
  },
  {
    id: "storage-config",
    label: "存储配置",
    title: "存储配置",
    icon: CloudServerOutlined,
  },
  { id: "logs", label: "操作记录", title: "操作记录", icon: HistoryOutlined },
  {
    id: "settings",
    label: "系统设置",
    title: "系统设置",
    icon: SettingOutlined,
  },
];
const registrationLabels: Record<string, string> = {
  invite_only: "仅邀请注册",
  open: "开放注册",
  closed: "已关闭注册",
};
const backupLabels: Record<string, string> = {
  daily: "每 24 小时",
  weekly: "每 7 天",
  off: "手动备份",
};
function inviteStatus(i: Invite) {
  if (i.used_at) return <Status>已使用</Status>;
  if (i.revoked_at) return <Status>已撤销</Status>;
  if (new Date(i.expires_at) < new Date())
    return <Status color="orange">已过期</Status>;
  return <Status color="purple">待使用</Status>;
}
function backupStatus(b: Backup) {
  if (b.status === "completed") return <Status color="green">已完成</Status>;
  if (b.status === "failed") return <Status color="red">失败</Status>;
  return <Status color="blue">执行中</Status>;
}
type Props = { token: string; login: (s: string) => void; logout: () => void };
export default function Admin(props: Props) {
  useEffect(() => {
    const title = document.title;
    document.title = "WeNote · 服务端管理";
    return () => {
      document.title = title;
    };
  }, []);
  return (
    <AdminTheme>
      {props.token ? (
        <Dashboard token={props.token} logout={props.logout} />
      ) : (
        <AdminAuth login={props.login} />
      )}
    </AdminTheme>
  );
}
function Dashboard({ token, logout }: Pick<Props, "token" | "logout">) {
  const [tab, setTab] = useState("overview"),
    [drawer, setDrawer] = useState(false),
    [authorized, setAuthorized] = useState<boolean | null>(null),
    [email, setEmail] = useState("");
  const [overview, setOverview] = useState<Overview | null>(null),
    [users, setUsers] = useState<AdminUser[]>([]),
    [invites, setInvites] = useState<Invite[]>([]),
    [settings, setSettings] = useState<Settings | null>(null),
    [backups, setBackups] = useState<Backup[]>([]),
    [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [dialog, setDialog] = useState<"invite" | "mail" | null>(null),
    [emailForm] = Form.useForm<{ address: string }>();
  const [restoreTarget, setRestoreTarget] = useState<Backup>();
  const [safetyID, setSafetyID] = useState("");
  const active = pages.find((p) => p.id === tab)!;
  async function data(path: string) {
    return (await request(token, "/api/v1/admin/" + path)).json();
  }
  async function refresh() {
    const me = await (await request(token, "/api/v1/me")).json();
    setAuthorized(me.role === "system_admin");
    if (me.role !== "system_admin") return;
    setEmail(me.email);
    const [summary, people, invitations, config, jobs] = await Promise.all(
      ["overview", "users", "invitations", "settings", "backups"].map(data),
    );
    setOverview(summary);
    setUsers(people.users);
    setInvites(invitations.invitations);
    setSettings(config);
    setBackups(jobs.backups);
    setRevision((n) => n + 1);
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void run(refresh);
  }, [token]);
  const cleaning = users.some((u) => u.status === "purging");
  useEffect(() => {
    if (!cleaning || tab !== "users") return;
    let current = true;
    const timer = setInterval(() => {
      data("users")
        .then((result) => {
          if (current) setUsers(result.users);
        })
        .catch(() => {});
    }, 2000);
    return () => {
      current = false;
      clearInterval(timer);
    };
  }, [token, cleaning, tab]);
  function navigate(id: string) {
    setTab(id);
    setDrawer(false);
    setNotice("");
    setError("");
    window.scrollTo(0, 0);
  }
  function action(path: string, success: string, body?: unknown) {
    return run(async () => {
      const r = await request(token, "/api/v1/admin/" + path, "POST", body),
        result = r.status === 204 ? {} : await r.json();
      await refresh();
      setNotice(
        result.delivery_status
          ? "邮件投递状态 " + result.delivery_status
          : success,
      );
    });
  }
  function openEmail(kind: "invite" | "mail") {
    setError("");
    setDialog(kind);
  }
  async function sendEmail({ address }: { address: string }) {
    const invite = dialog === "invite";
    await run(async () => {
      const result = await (
        await request(
          token,
          "/api/v1/admin/" + (invite ? "invitations" : "smtp/test"),
          "POST",
          invite ? { email: address } : { recipient: address },
        )
      ).json();
      setDialog(null);
      await refresh();
      setNotice(
        invite
          ? "邀请已创建。投递状态 " + result.delivery_status
          : "测试邮件已发送",
      );
    });
  }
  const navigation = (
    <nav className="gm-nav" aria-label="管理导航">
      {pages.map(({ id, label, icon: Icon }) => (
        <Button
          key={id}
          aria-label={label}
          aria-current={id === tab ? "page" : undefined}
          type="text"
          icon={<Icon />}
          onClick={() => navigate(id)}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
  if (!authorized)
    return (
      <main className="gm-gate">
        {authorized === null && !error ? (
          <Spin />
        ) : (
          <Result
            status={authorized === false ? "403" : "warning"}
            title={
              authorized === false ? "此页面需要管理员权限" : "无法加载后台"
            }
            subTitle={error}
            extra={
              <Space>
                <Button href="/">返回笔记</Button>
                <Button onClick={logout}>退出登录</Button>
              </Space>
            }
          />
        )}
      </main>
    );
  return (
    <div className="gm-shell">
      <aside className="gm-side">
        <Brand />
        <div className="gm-side-title">管理控制台</div>
        {navigation}
        <a className="gm-return" href="/">
          返回笔记 <ArrowRightOutlined />
        </a>
      </aside>
      <Drawer
        title={<Brand />}
        placement="left"
        size={252}
        open={drawer}
        onClose={() => setDrawer(false)}
        destroyOnHidden
      >
        {navigation}
        <a className="gm-return" href="/">
          返回笔记 <ArrowRightOutlined />
        </a>
      </Drawer>
      <div className="gm-work">
        <header className="gm-bar">
          <div>
            <Button
              className="gm-mobile-nav"
              type="text"
              aria-label="打开管理导航"
              icon={<MenuOutlined />}
              onClick={() => setDrawer(true)}
            />
            <CloudServerOutlined /> 服务端管理
          </div>
          <Dropdown
            trigger={["click"]}
            menu={{
              items: [
                { key: "password", label: <a href="/#change">修改密码</a> },
                { key: "logout", label: "退出登录", onClick: logout },
              ],
            }}
          >
            <Button type="text" aria-label="管理员账户">
              <Avatar size={26}>{email.slice(0, 1).toUpperCase()}</Avatar>
              <span className="gm-admin-email">{email}</span>
              <DownOutlined />
            </Button>
          </Dropdown>
        </header>
        <main className="gm-main">
          <div className="gm-heading">
            <h1>{active.title}</h1>
            <Button
              aria-label="刷新"
              icon={<ReloadOutlined />}
              loading={busy}
              onClick={() => void run(refresh)}
            >
              刷新
            </Button>
          </div>
          {error && !dialog && <Alert title={error} type="error" showIcon />}
          {notice && (
            <div role="status">
              <Alert title={notice} type="success" showIcon />
            </div>
          )}
          {tab === "overview" && overview && (
            <>
              <div className="gm-stat-grid">
                {[
                  {
                    label: "用户总数",
                    value: overview.users,
                    icon: TeamOutlined,
                    color: "purple",
                  },
                  {
                    label: "笔记库",
                    value: overview.vaults,
                    icon: FolderOpenOutlined,
                    color: "blue",
                  },
                  {
                    label: "笔记总数",
                    value: overview.files,
                    icon: FileTextOutlined,
                    color: "teal",
                  },
                ].map(({ label, value, icon: Icon, color }) => (
                  <div className="gm-stat" key={label}>
                    <div className={"gm-stat-icon " + color}>
                      <Icon />
                    </div>
                    <span>{label}</span>
                    <strong>{value.toLocaleString()}</strong>
                  </div>
                ))}
              </div>
              <div className="gm-overview">
                <section className="gm-storage">
                  <div>
                    <DatabaseOutlined /> 存储占用
                  </div>
                  <strong>{formatBytes(overview.storage_bytes)}</strong>
                  <p>{overview.assets} 个附件</p>
                  <Button onClick={() => navigate("storage")}>
                    查看存储详情 <ArrowRightOutlined />
                  </Button>
                  <div aria-hidden="true" className="gm-storage-discs">
                    <i />
                    <i />
                    <i />
                  </div>
                </section>
                <Card
                  title="实例配置"
                  extra={
                    <Button type="link" onClick={() => navigate("settings")}>
                      管理设置
                    </Button>
                  }
                >
                  <dl className="gm-facts">
                    <div>
                      <dt>注册方式</dt>
                      <dd>
                        {registrationLabels[
                          settings?.registration_mode || ""
                        ] || "—"}
                      </dd>
                    </div>
                    <div>
                      <dt>邮箱验证</dt>
                      <dd>
                        {settings?.require_email_verification
                          ? "必须验证"
                          : "可选"}
                      </dd>
                    </div>
                    <div>
                      <dt>备份计划</dt>
                      <dd>
                        {backupLabels[settings?.backup_schedule || ""] || "—"}
                      </dd>
                    </div>
                  </dl>
                </Card>
              </div>
              <Card
                title="账户与邀请"
                extra={
                  <Button type="link" onClick={() => navigate("invites")}>
                    管理邀请
                  </Button>
                }
              >
                <div className="gm-fact-strip">
                  <div>
                    <TeamOutlined />
                    <span>活跃用户</span>
                    <strong>{overview.active_users}</strong>
                  </div>
                  <div>
                    <MailOutlined />
                    <span>待处理邀请</span>
                    <strong>{overview.pending_invites}</strong>
                  </div>
                </div>
              </Card>
            </>
          )}
          {tab === "users" && (
            <AdminUsers
              users={users}
              action={action}
              busy={busy}
              error={error}
            />
          )}
          {tab === "invites" && (
            <Card
              title="邀请记录"
              extra={
                <Button
                  type="primary"
                  icon={<PlusOutlined />}
                  aria-label="创建邀请"
                  onClick={() => openEmail("invite")}
                >
                  创建邀请
                </Button>
              }
            >
              <DataTable<Invite>
                rowKey="id"
                dataSource={invites}
                columns={[
                  { title: "邮箱", dataIndex: "email" },
                  { title: "状态", render: (_, i) => inviteStatus(i) },
                  {
                    title: "有效期",
                    dataIndex: "expires_at",
                    render: formatDate,
                  },
                  {
                    title: "创建时间",
                    dataIndex: "created_at",
                    render: formatDate,
                  },
                  {
                    title: "操作",
                    render: (_, i) =>
                      !i.used_at &&
                      !i.revoked_at && (
                        <Space size={0}>
                          <Button
                            type="link"
                            onClick={() =>
                              action(`invitations/${i.id}/resend`, "已重发")
                            }
                          >
                            重发
                          </Button>
                          <Button
                            type="link"
                            danger
                            onClick={() =>
                              action(`invitations/${i.id}/revoke`, "已撤销邀请")
                            }
                          >
                            撤销
                          </Button>
                        </Space>
                      ),
                  },
                ]}
              />
            </Card>
          )}
          {tab === "settings" && settings && (
            <SettingsPanel
              settings={settings}
              busy={busy}
              test={() => openEmail("mail")}
              save={(value) =>
                run(async () => {
                  await request(token, "/api/v1/admin/settings", "PUT", value);
                  setSettings(await data("settings"));
                  setNotice("系统设置已保存");
                })
              }
            />
          )}
          {tab === "storage-config" && <StorageConfigPanel token={token} />}
          {tab === "storage" && (
            <Inventory
              revision={revision}
              token={token}
              action={action}
              busy={busy}
              errorMessage={error}
            />
          )}
          {tab === "logs" && <Logs key={revision} token={token} />}
          {tab === "backups" && (
            <Card
              title="备份任务"
              extra={
                <Button
                  type="primary"
                  aria-label="立即备份"
                  icon={<CloudUploadOutlined />}
                  loading={busy}
                  onClick={() => action("backups", "备份已完成")}
                >
                  立即备份
                </Button>
              }
            >
              <DataTable<Backup>
                rowKey="id"
                dataSource={backups}
                columns={[
                  {
                    title: "创建时间",
                    dataIndex: "created_at",
                    render: formatDate,
                  },
                  {
                    title: "类型",
                    render: (_, b) =>
                      b.purpose === "before_restore"
                        ? "恢复前自动备份"
                        : "常规备份",
                  },
                  {
                    title: "存储",
                    render: (_, b) => storageNames[b.destination || "local"],
                  },
                  { title: "状态", render: (_, b) => backupStatus(b) },
                  { title: "大小", dataIndex: "size", render: formatBytes },
                  {
                    title: "校验哈希",
                    render: (_, b) =>
                      b.checksum ? (
                        <code className="gm-digest" title={b.checksum}>
                          {b.checksum}
                        </code>
                      ) : (
                        b.error || "—"
                      ),
                  },
                  {
                    title: "操作",
                    render: (_, b) =>
                      b.status === "completed" && (
                        <Space size={0}>
                          <Button
                            type="link"
                            onClick={() =>
                              action(`backups/${b.id}/verify`, "备份校验通过")
                            }
                          >
                            校验
                          </Button>
                          <Button
                            type="link"
                            danger
                            disabled={busy}
                            onClick={() => {
                              setError("");
                              setRestoreTarget(b);
                            }}
                          >
                            恢复备份
                          </Button>
                        </Space>
                      ),
                  },
                ]}
              />
            </Card>
          )}
        </main>
      </div>
      <Modal
        title="恢复备份"
        open={!!restoreTarget}
        okText="备份当前数据并恢复"
        cancelText="取消"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        closable={!busy}
        keyboard={!busy}
        mask={{ closable: !busy }}
        cancelButtonProps={{ disabled: busy }}
        onCancel={() => setRestoreTarget(undefined)}
        onOk={() =>
          restoreTarget &&
          void run(async () => {
            const response = await request(
              token,
              `/api/v1/admin/backups/${restoreTarget.id}/apply`,
              "POST",
              { confirm: restoreTarget.id },
            );
            const result = await response.json();
            setRestoreTarget(undefined);
            setSafetyID(result.safety_backup_id);
          })
        }
      >
        {restoreTarget && (
          <p>
            将所有用户、笔记和附件恢复至{" "}
            <strong>{formatDate(restoreTarget.created_at)}</strong>。备份大小为{" "}
            {formatBytes(restoreTarget.size)}。
          </p>
        )}
        <p>
          恢复期间会暂停访问。服务器会先备份并校验当前数据。完成后，所有用户都需要用备份时的账户密码重新登录。
        </p>
        {error && <Alert type="error" title={error} showIcon />}
      </Modal>
      <Modal
        title="备份已恢复"
        open={!!safetyID}
        closable={false}
        keyboard={false}
        mask={{ closable: false }}
        footer={
          <Button type="primary" onClick={logout}>
            重新登录
          </Button>
        }
      >
        <p>
          恢复前的数据已保存。如需撤回，可在备份列表中选择这份「恢复前自动备份」。
        </p>
        <code>{safetyID}</code>
      </Modal>
      <Modal
        title={dialog === "invite" ? "创建邀请" : "发送测试邮件"}
        open={dialog !== null}
        onCancel={() => {
          setDialog(null);
          setError("");
        }}
        onOk={() => emailForm.submit()}
        okText={dialog === "invite" ? "发送邀请" : "发送"}
        confirmLoading={busy}
        destroyOnHidden
      >
        <Form
          layout="vertical"
          requiredMark={false}
          form={emailForm}
          onFinish={sendEmail}
          preserve={false}
        >
          <Form.Item
            name="address"
            label={dialog === "invite" ? "受邀邮箱" : "收件人邮箱"}
            rules={[
              { required: true, type: "email", message: "请输入有效邮箱" },
            ]}
          >
            <Input
              type="email"
              autoComplete="off"
              placeholder="name@example.com"
            />
          </Form.Item>
        </Form>
        {dialog && error && <Alert type="error" title={error} />}
      </Modal>
    </div>
  );
}
