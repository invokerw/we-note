import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Dropdown,
  Input,
  Modal,
  Select,
  Space,
} from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { DataTable, formatBytes, formatDate, Status } from "./AdminUI";
export type AdminUser = {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  email_verified_at?: string;
  last_login_at?: string;
  disabled_at?: string;
  disabled_reason?: string;
  deleted_at?: string;
  vaults: number;
  files: number;
  assets: number;
  storage_bytes: number;
  trash_bytes: number;
  pending_bytes: number;
  cleanup_error?: string;
};
type Change = (
  path: string,
  message: string,
  body?: unknown,
) => Promise<boolean>;
const labels: Record<string, string> = {
  active: "正常",
  disabled: "已禁用",
  deleted: "旧版已删除",
  purging: "等待清理",
};
export function AdminUsers({
  users,
  action,
  busy,
  error,
}: {
  users: AdminUser[];
  action: Change;
  busy: boolean;
  error: string;
}) {
  const [query, setQuery] = useState(""),
    [state, setState] = useState("all"),
    [detail, setDetail] = useState(""),
    [operation, setOperation] = useState<{
      user: AdminUser;
      kind: "disable" | "delete" | "purge";
    } | null>(null),
    [value, setValue] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const items = users.filter(
    (u) =>
      (state === "all" || state === u.status) &&
      u.email.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selected = users.find((u) => u.id === detail);
  function open(user: AdminUser, kind: "disable" | "delete" | "purge") {
    setValue("");
    setSubmitted(false);
    setOperation({ user, kind });
  }
  async function confirm() {
    if (!operation) return;
    setSubmitted(true);
    const { user, kind } = operation;
    const ok = await action(
      `users/${user.id}/${kind}`,
      kind === "purge"
        ? "已提交永久删除"
        : kind === "delete"
          ? "账户已移入删除状态"
          : "账户已禁用",
      kind === "delete" || kind === "purge"
        ? { confirm_email: value }
        : { reason: value.trim() },
    );
    if (ok) setOperation(null);
  }
  const deleting = operation?.kind === "delete" || operation?.kind === "purge";
  const purging = operation?.kind === "purge";
  return (
    <Card title="账户清单">
      <div className="gm-list-tools">
        <Input
          allowClear
          aria-label="搜索用户邮箱"
          placeholder="搜索用户邮箱"
          prefix={<SearchOutlined />}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {
          <Select
            aria-label="筛选账户状态"
            value={state}
            onChange={setState}
            options={[
              { value: "all", label: "全部状态" },
              { value: "active", label: "正常" },
              { value: "disabled", label: "已禁用" },
              { value: "purging", label: "等待清理" },
              ...(users.some((u) => u.status === "deleted")
                ? [{ value: "deleted", label: "旧版已删除" }]
                : []),
            ]}
          />
        }
        <span>共 {items.length} 个账户</span>
      </div>
      <DataTable<AdminUser>
        rowKey="id"
        dataSource={items}
        columns={[
          {
            title: "邮箱",
            render: (_, u) => (
              <div className="gm-identity">
                <Button
                  type="link"
                  className="gm-email-link"
                  onClick={() => setDetail(u.id)}
                >
                  {u.email}
                </Button>
                <small>
                  {u.role === "system_admin" ? "管理员" : "普通用户"}
                </small>
              </div>
            ),
          },
          {
            title: "状态",
            render: (_, u) => (
              <Status
                color={
                  u.status === "active"
                    ? "green"
                    : u.status === "disabled"
                      ? "orange"
                      : undefined
                }
              >
                {u.cleanup_error ? "清理失败" : labels[u.status]}
              </Status>
            ),
          },
          {
            title: "验证",
            render: (_, u) => (u.email_verified_at ? "已验证" : "未验证"),
          },
          {
            title: "存储占用",
            dataIndex: "storage_bytes",
            render: formatBytes,
            sorter: (a, b) => a.storage_bytes - b.storage_bytes,
          },
          {
            title: "最近登录",
            render: (_, u) => formatDate(u.last_login_at),
          },
          {
            title: "操作",
            render: (_, u) =>
              u.status === "purging" ? (
                <Space>
                  <Button type="link" onClick={() => setDetail(u.id)}>
                    清理详情
                  </Button>
                  {u.cleanup_error && (
                    <Button onClick={() => open(u, "purge")}>重试</Button>
                  )}
                </Space>
              ) : u.status === "deleted" ? (
                <Space>
                  <Button
                    type="link"
                    disabled={busy}
                    onClick={() =>
                      void action(
                        `users/${u.id}/restore`,
                        u.disabled_at
                          ? "账户已还原，仍为禁用状态"
                          : "账户已还原",
                      )
                    }
                  >
                    还原账户
                  </Button>
                  <Button type="link" danger onClick={() => open(u, "purge")}>
                    永久删除
                  </Button>
                </Space>
              ) : (
                <Space size={2}>
                  {u.role !== "system_admin" &&
                    (u.status === "disabled" ? (
                      <Button
                        type="link"
                        disabled={busy}
                        onClick={() =>
                          void action(`users/${u.id}/enable`, "账户已启用")
                        }
                      >
                        启用
                      </Button>
                    ) : (
                      <Button
                        type="link"
                        disabled={busy}
                        onClick={() => open(u, "disable")}
                      >
                        禁用
                      </Button>
                    ))}
                  <Dropdown
                    trigger={["click"]}
                    menu={{
                      items: [
                        {
                          key: "details",
                          label: "账户详情",
                          onClick: () => setDetail(u.id),
                        },
                        ...(u.status === "active"
                          ? [
                              {
                                key: "reset",
                                label: "重置密码",
                                onClick: () =>
                                  void action(
                                    `users/${u.id}/reset-password`,
                                    "已请求重置密码",
                                  ),
                              },
                            ]
                          : []),
                        ...(u.role === "system_admin"
                          ? []
                          : [
                              ...(u.status === "active"
                                ? [
                                    {
                                      key: "logout",
                                      label: "撤销会话",
                                      onClick: () =>
                                        void action(
                                          `users/${u.id}/logout`,
                                          "会话已撤销",
                                        ),
                                    },
                                  ]
                                : []),
                              {
                                key: "delete",
                                label: "移入删除状态",
                                onClick: () => open(u, "delete"),
                              },
                              {
                                key: "purge",
                                label: "永久删除账户",
                                danger: true,
                                onClick: () => open(u, "purge"),
                              },
                            ]),
                      ],
                    }}
                  >
                    <Button size="small" disabled={busy}>
                      更多操作
                    </Button>
                  </Dropdown>
                </Space>
              ),
          },
        ]}
      />
      <Drawer open={!!selected} title="账户详情" onClose={() => setDetail("")}>
        {selected && (
          <Descriptions
            column={1}
            items={Object.entries({
              邮箱: selected.email,
              状态: labels[selected.status],
              注册时间: formatDate(selected.created_at),
              最近登录: formatDate(selected.last_login_at),
              邮箱验证: selected.email_verified_at
                ? formatDate(selected.email_verified_at)
                : "未验证",
              笔记库: selected.vaults,
              笔记: selected.files,
              附件: selected.assets,
              在线对象: formatBytes(selected.storage_bytes),
              "回收站（逻辑大小）": formatBytes(selected.trash_bytes),
              待清理: formatBytes(selected.pending_bytes),
              ...(selected.cleanup_error
                ? { 清理错误: selected.cleanup_error }
                : {}),
              ...(selected.disabled_at
                ? {
                    禁用时间: formatDate(selected.disabled_at),
                    禁用原因: selected.disabled_reason || "未填写",
                  }
                : {}),
              ...(selected.deleted_at
                ? { 删除时间: formatDate(selected.deleted_at) }
                : {}),
            }).map(([label, children]) => ({ key: label, label, children }))}
          />
        )}
      </Drawer>
      <Modal
        open={!!operation}
        title={purging ? "永久删除账户" : deleting ? "删除账户" : "禁用账户"}
        okText={
          purging ? "确认永久删除" : deleting ? "确认移入删除状态" : "确认禁用"
        }
        okButtonProps={{
          danger: true,
          disabled: deleting
            ? value.trim().toLowerCase() !== operation?.user.email.toLowerCase()
            : !value.trim(),
        }}
        confirmLoading={busy}
        onCancel={() => {
          if (!busy) setOperation(null);
        }}
        onOk={confirm}
      >
        <p>{operation?.user.email}</p>
        <p>
          {purging
            ? `将撤销会话并永久清理该用户的 ${operation?.user.vaults} 个笔记库、${operation?.user.files} 篇在用笔记、${operation?.user.assets} 个在用附件及其回收站。在线数据 ${formatBytes(operation?.user.storage_bytes ?? 0)}。历史整机备份单独保留。`
            : deleting
              ? "账户会进入旧版删除状态，数据仍可由管理员还原。"
              : "禁用后，所有登录会话将被撤销。该用户需要在重新启用后登录。"}
        </p>
        <label>
          {deleting ? "输入完整邮箱确认" : "禁用原因"}
          {deleting ? (
            <Input value={value} onChange={(e) => setValue(e.target.value)} />
          ) : (
            <Input.TextArea
              value={value}
              maxLength={500}
              showCount
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </label>
        {submitted && error && <Alert type="error" title={error} />}
      </Modal>
    </Card>
  );
}
