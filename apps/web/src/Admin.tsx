import { useEffect, useState, type FormEvent } from "react";
import { Inventory, Logs } from "./AdminDetails";
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
type AdminUser = {
  id: string;
  email: string;
  role: string;
  status: string;
  email_verified_at?: string;
  created_at: string;
  vaults: number;
  files: number;
  assets: number;
  storage_bytes: number;
};
type Invite = {
  id: string;
  email: string;
  token?: string;
  expires_at: string;
  used_at?: string;
  revoked_at?: string;
  created_at: string;
};
type Settings = {
  registration_mode: string;
  require_email_verification: boolean;
  backup_root: string;
  backup_schedule: string;
  smtp: {
    host: string;
    port: number;
    security: string;
    username: string;
    from_name: string;
    from: string;
    reply_to: string;
    has_password: boolean;
  };
};
type Backup = {
  id: string;
  status: string;
  path?: string;
  size: number;
  checksum?: string;
  error?: string;
  created_at: string;
  completed_at?: string;
};

function formatBytes(value: number) {
  if (!value) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let index = 0;
  let current = value;
  while (current >= 1024 && index < units.length - 1) {
    current /= 1024;
    index += 1;
  }
  return `${current.toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(value?: string) {
  return value ? new Date(value).toLocaleString() : "—";
}

export default function Admin({
  token,
  logout,
}: {
  token: string;
  logout: () => void;
}) {
  const [tab, setTab] = useState("overview");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [backups, setBackups] = useState<Backup[]>([]);
  const [authorized, setAuthorized] = useState<boolean | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await action();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadOverview() {
    setOverview(await (await request(token, "/api/v1/admin/overview")).json());
  }
  async function loadUsers() {
    setUsers(
      (await (await request(token, "/api/v1/admin/users")).json()).users,
    );
  }
  async function loadInvites() {
    setInvites(
      (await (await request(token, "/api/v1/admin/invitations")).json())
        .invitations,
    );
  }
  async function loadSettings() {
    setSettings(await (await request(token, "/api/v1/admin/settings")).json());
  }
  async function loadBackups() {
    setBackups(
      (await (await request(token, "/api/v1/admin/backups")).json()).backups,
    );
  }
  async function refresh() {
    const me = await (await request(token, "/api/v1/me")).json();
    setAuthorized(me.role === "system_admin");
    if (me.role !== "system_admin") return;
    setRevision((n) => n + 1);
    await Promise.all([
      loadOverview(),
      loadUsers(),
      loadInvites(),
      loadSettings(),
      loadBackups(),
    ]);
  }

  useEffect(() => {
    void run(refresh);
  }, [token]);

  function action(path: string, success: string) {
    void run(async () => {
      const response = await request(token, "/api/v1/admin/" + path, "POST");
      const result = response.status === 204 ? {} : await response.json();
      setMessage(
        result.delivery_status
          ? "邮件投递状态 " + result.delivery_status
          : success,
      );
      await refresh();
    });
  }
  async function invite() {
    const email = prompt("受邀邮箱");
    if (!email) return;
    await run(async () => {
      const result = await (
        await request(token, "/api/v1/admin/invitations", "POST", { email })
      ).json();
      setMessage(`邀请已创建。投递状态 ${result.delivery_status}`);
      await Promise.all([loadInvites(), loadOverview()]);
    });
  }

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!settings) return;
    const form = new FormData(event.currentTarget);
    await run(async () => {
      await request(token, "/api/v1/admin/settings", "PUT", {
        registration_mode: form.get("registration_mode"),
        require_email_verification:
          form.get("require_email_verification") === "on",
        backup_root: form.get("backup_root"),
        backup_schedule: form.get("backup_schedule"),
        smtp: {
          host: form.get("smtp_host"),
          port: Number(form.get("smtp_port")),
          security: form.get("smtp_security"),
          username: form.get("smtp_username"),
          password: form.get("smtp_password"),
          from_name: form.get("smtp_from_name"),
          from: form.get("smtp_from"),
          reply_to: form.get("smtp_reply_to"),
        },
      });
      setMessage("系统设置已保存");
      await loadSettings();
    });
  }

  if (authorized !== true)
    return (
      <main className="admin-panel">
        <h1>
          {authorized === false ? "此页面需要管理员权限" : "正在检查管理员权限"}
        </h1>
        <p role="status">{message}</p>
        <a href="/">返回笔记</a> <button onClick={logout}>退出登录</button>
      </main>
    );
  return (
    <div className="admin-shell">
      <header className="admin-header">
        <div>
          <p className="admin-eyebrow">WeNote GM</p>
          <h1>服务端管理</h1>
        </div>
        <div className="toolbar">
          <button onClick={() => void run(refresh)} disabled={busy}>
            刷新
          </button>
          <a href="/">返回笔记</a> <a href="/#change">修改密码</a>{" "}
          <button onClick={logout}>退出登录</button>
        </div>
      </header>
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="管理导航">
          {[
            ["overview", "总览"],
            ["users", "用户"],
            ["invites", "邀请"],
            ["storage", "附件与存储"],
            ["logs", "操作记录"],
            ["settings", "系统设置"],
            ["backups", "备份"],
          ].map(([id, label]) => (
            <button
              key={id}
              className={tab === id ? "selected" : ""}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <main className="admin-main">
          {message && (
            <p className="message" role="status">
              {message}
            </p>
          )}
          {tab === "overview" && overview && (
            <>
              <div className="admin-cards">
                {[
                  ["用户", overview.users],
                  ["活跃用户", overview.active_users],
                  ["待处理邀请", overview.pending_invites],
                  ["Vault", overview.vaults],
                  ["笔记", overview.files],
                  ["附件", overview.assets],
                  ["Blob 占用", formatBytes(overview.storage_bytes)],
                ].map(([label, value]) => (
                  <section className="admin-card" key={String(label)}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </section>
                ))}
              </div>
            </>
          )}
          {tab === "users" && (
            <section className="admin-panel">
              <div className="admin-panel-heading">
                <h2>用户管理</h2>
              </div>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>邮箱</th>
                      <th>状态</th>
                      <th>验证</th>
                      <th>Vault</th>
                      <th>占用</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id}>
                        <td>
                          {user.email}
                          <small>{formatDate(user.created_at)}</small>
                        </td>
                        <td>
                          {user.status === "disabled"
                            ? "已禁用"
                            : user.role === "system_admin"
                              ? "管理员"
                              : "正常"}
                        </td>
                        <td>{user.email_verified_at ? "已验证" : "未验证"}</td>
                        <td>{user.vaults}</td>
                        <td>{formatBytes(user.storage_bytes)}</td>
                        <td>
                          {user.role !== "system_admin" &&
                            (user.status === "disabled" ? (
                              <button
                                onClick={() =>
                                  void run(async () => {
                                    await request(
                                      token,
                                      `/api/v1/admin/users/${user.id}/enable`,
                                      "POST",
                                    );
                                    await loadUsers();
                                  })
                                }
                              >
                                恢复
                              </button>
                            ) : (
                              <button
                                onClick={() =>
                                  void run(async () => {
                                    await request(
                                      token,
                                      `/api/v1/admin/users/${user.id}/disable`,
                                      "POST",
                                      { reason: "管理员操作" },
                                    );
                                    await loadUsers();
                                  })
                                }
                              >
                                禁用
                              </button>
                            ))}
                          <button
                            onClick={() =>
                              action(
                                `users/${user.id}/reset-password`,
                                "已请求重置密码",
                              )
                            }
                          >
                            重置密码
                          </button>
                          {user.role !== "system_admin" && (
                            <button
                              onClick={() =>
                                action(`users/${user.id}/logout`, "会话已撤销")
                              }
                            >
                              撤销会话
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "invites" && (
            <section className="admin-panel">
              <div className="admin-panel-heading">
                <h2>邀请注册</h2>
                <button className="primary" onClick={() => void invite()}>
                  创建邀请
                </button>
              </div>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>邮箱</th>
                      <th>状态</th>
                      <th>有效期</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invites.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.email}
                          {item.token && <small>令牌 {item.token}</small>}
                        </td>
                        <td>
                          {item.used_at
                            ? "已使用"
                            : item.revoked_at
                              ? "已撤销"
                              : new Date(item.expires_at) < new Date()
                                ? "已过期"
                                : "待使用"}
                        </td>
                        <td>{formatDate(item.expires_at)}</td>
                        <td>{formatDate(item.created_at)}</td>
                        <td>
                          {!item.revoked_at && !item.used_at && (
                            <>
                              <button
                                onClick={() =>
                                  action(
                                    `invitations/${item.id}/resend`,
                                    "已重发",
                                  )
                                }
                              >
                                重发
                              </button>
                              <button
                                onClick={() =>
                                  action(
                                    `invitations/${item.id}/revoke`,
                                    "已撤销邀请",
                                  )
                                }
                              >
                                撤销
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
          {tab === "storage" && (
            <Inventory token={token} key={revision} action={action} />
          )}
          {tab === "logs" && <Logs token={token} key={revision} />}
          {tab === "settings" && settings && (
            <section className="admin-panel">
              <h2>系统设置</h2>
              <form className="admin-form" onSubmit={saveSettings}>
                <label>
                  注册模式
                  <select
                    name="registration_mode"
                    defaultValue={settings.registration_mode}
                  >
                    <option value="invite_only">仅邀请注册</option>
                    <option value="open">开放注册</option>
                    <option value="closed">关闭注册</option>
                  </select>
                </label>
                <label className="checkbox">
                  <input
                    type="checkbox"
                    name="require_email_verification"
                    defaultChecked={settings.require_email_verification}
                  />
                  必须验证邮箱
                </label>
                <label>
                  备份目录
                  <input
                    name="backup_root"
                    defaultValue={settings.backup_root}
                  />
                </label>
                <label>
                  自动备份
                  <select
                    name="backup_schedule"
                    defaultValue={settings.backup_schedule}
                  >
                    <option value="off">关闭</option>
                    <option value="daily">每 24 小时</option>
                    <option value="weekly">每 7 天</option>
                  </select>
                </label>
                <h3>SMTP</h3>
                <label>
                  主机
                  <input name="smtp_host" defaultValue={settings.smtp.host} />
                </label>
                <label>
                  端口
                  <input
                    name="smtp_port"
                    type="number"
                    defaultValue={settings.smtp.port || 587}
                  />
                </label>
                <label>
                  安全方式
                  <select
                    name="smtp_security"
                    defaultValue={settings.smtp.security || "starttls"}
                  >
                    <option value="starttls">STARTTLS</option>
                    <option value="tls">TLS</option>
                    <option value="plain">无加密</option>
                  </select>
                </label>
                <label>
                  用户名
                  <input
                    name="smtp_username"
                    defaultValue={settings.smtp.username}
                  />
                </label>
                <label>
                  密码
                  <input
                    name="smtp_password"
                    type="password"
                    placeholder={
                      settings.smtp.has_password
                        ? "已配置，留空保持不变"
                        : "请输入密码"
                    }
                  />
                </label>
                <label>
                  发件人名称
                  <input
                    name="smtp_from_name"
                    defaultValue={settings.smtp.from_name}
                  />
                </label>
                <label>
                  发件人地址
                  <input
                    name="smtp_from"
                    type="email"
                    defaultValue={settings.smtp.from}
                  />
                </label>
                <label>
                  Reply-To
                  <input
                    name="smtp_reply_to"
                    type="email"
                    defaultValue={settings.smtp.reply_to}
                  />
                </label>
                <button className="primary" disabled={busy}>
                  保存设置
                </button>
              </form>
              <button
                disabled={busy}
                onClick={() => {
                  const recipient = prompt("测试邮件收件人");
                  if (recipient)
                    void run(async () => {
                      await request(token, "/api/v1/admin/smtp/test", "POST", {
                        recipient,
                      });
                      setMessage("测试邮件已发送");
                    });
                }}
              >
                发送测试邮件
              </button>
            </section>
          )}
          {tab === "backups" && (
            <section className="admin-panel">
              <div className="admin-panel-heading">
                <h2>备份与恢复</h2>
                <button
                  className="primary"
                  onClick={() =>
                    void run(async () => {
                      await request(token, "/api/v1/admin/backups", "POST");
                      await loadBackups();
                    })
                  }
                >
                  立即备份
                </button>
              </div>
              <div className="admin-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>状态</th>
                      <th>大小</th>
                      <th>校验哈希</th>
                      <th>创建时间</th>
                      <th>操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {backups.map((item) => (
                      <tr key={item.id}>
                        <td>
                          {item.status === "completed"
                            ? "已完成"
                            : item.status === "failed"
                              ? "失败"
                              : "执行中"}
                        </td>
                        <td>{formatBytes(item.size)}</td>
                        <td>
                          <code>{item.checksum || "—"}</code>
                        </td>
                        <td>{formatDate(item.created_at)}</td>
                        <td>
                          {item.status === "completed" && (
                            <>
                              <button
                                onClick={() =>
                                  void run(async () => {
                                    await request(
                                      token,
                                      `/api/v1/admin/backups/${item.id}/verify`,
                                      "POST",
                                    );
                                    setMessage("备份校验通过");
                                  })
                                }
                              >
                                校验
                              </button>
                              <button
                                onClick={() =>
                                  void run(async () => {
                                    const restored = await (
                                      await request(
                                        token,
                                        `/api/v1/admin/backups/${item.id}/restore`,
                                        "POST",
                                      )
                                    ).json();
                                    setMessage("恢复目录：" + restored.path);
                                  })
                                }
                              >
                                准备恢复
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
