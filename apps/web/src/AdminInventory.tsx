import { useEffect, useState } from "react";
import { Alert, Button, Card, Input, Modal, Select } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { DataTable, formatBytes, formatDate } from "./AdminUI";
import { request } from "./api";
type Asset = {
  asset_id: string;
  name: string;
  vault_id: string;
  owner_email: string;
  vault_name: string;
  media_type: string;
  status: string;
  content_size: number;
  deleted: boolean;
  created_at: string;
};
const initialFilters = {
  name: "",
  owner: "",
  vault: "",
  type: "",
  upload: "",
  minMiB: 0,
};
const uploadLabels: Record<string, string> = {
  pending: "上传中",
  completed: "已完成",
  failed: "失败",
};
export function Inventory({
  token,
  action,
  revision,
  busy,
  errorMessage,
}: {
  token: string;
  action: (path: string, success: string, body?: unknown) => Promise<boolean>;
  revision: number;
  busy: boolean;
  errorMessage: string;
}) {
  const [assets, setAssets] = useState<Asset[]>([]),
    [storage, setStorage] = useState<Record<string, number>>({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(initialFilters),
    [selected, setSelected] = useState<string[]>([]),
    [page, setPage] = useState(1),
    [pending, setPending] = useState<Asset[]>([]),
    [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    let current = true;
    setLoading(true);
    setError("");
    setSelected([]);
    Promise.all(
      ["assets", "storage"].map(async (key) =>
        (await request(token, "/api/v1/admin/" + key)).json(),
      ),
    )
      .then(([list, stats]) => {
        if (current) {
          setAssets(list.assets);
          setStorage(stats);
        }
      })
      .catch((e) => {
        if (current) setError(String(e));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [token, revision]);
  const matches = assets.filter(
    (a) =>
      !a.deleted &&
      a.name.toLowerCase().includes(filter.name.trim().toLowerCase()) &&
      (!filter.owner || a.owner_email === filter.owner) &&
      (!filter.vault || a.vault_id === filter.vault) &&
      (!filter.type || a.media_type === filter.type) &&
      (!filter.upload || a.status === filter.upload) &&
      a.content_size >= filter.minMiB * 1024 * 1024,
  );
  const chosen = new Set(selected);
  const selection = matches.filter((a) => chosen.has(a.asset_id));
  const bytes = (items: Asset[]) =>
    formatBytes(items.reduce((sum, a) => sum + a.content_size, 0));
  const owners = [...new Set(assets.map((a) => a.owner_email))].sort();
  const types = [...new Set(assets.map((a) => a.media_type))].sort();
  const vaults = new Map(
    assets
      .filter((a) => !filter.owner || a.owner_email === filter.owner)
      .map((a) => [a.vault_id, `${a.vault_name} · ${a.owner_email}`]),
  );
  function filters(next: Partial<typeof initialFilters>) {
    setFilter({ ...filter, ...next });
    setSelected([]);
    setPage(1);
  }
  function open(items: Asset[]) {
    setPending(items);
    setSubmitted(false);
  }
  async function confirm() {
    setSubmitted(true);
    const op = "delete";
    const ok = await action(
      "assets/batch",
      `已移入用户回收站 ${pending.length} 个附件`,
      { operation: op, asset_ids: pending.map((a) => a.asset_id) },
    );
    if (ok) {
      setPending([]);
      setSelected([]);
    }
  }
  return (
    <>
      {error && <Alert type="error" title={error} />}
      <div className="gm-stat-grid">
        {Object.entries({
          blob_bytes: "去重后对象占用",
          current_file_bytes: "当前笔记",
          asset_bytes: "在用附件",
          pending_upload_bytes: "待完成上传",
          historical_bytes: "历史版本",
          pending_cleanup_bytes: "待清理",
          backup_bytes: "整机备份（归档大小）",
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
        <div className="gm-list-tools">
          <Input
            prefix={<SearchOutlined />}
            allowClear
            aria-label="搜索附件名称"
            placeholder="搜索附件名称"
            value={filter.name}
            onChange={(e) => filters({ name: e.target.value })}
          />
          <Select
            aria-label="所属用户筛选"
            placeholder="所属用户"
            allowClear
            showSearch
            value={filter.owner || undefined}
            options={owners.map((value) => ({ value, label: value }))}
            onChange={(owner) => filters({ owner: owner || "", vault: "" })}
          />
          <Select
            aria-label="笔记库筛选"
            placeholder="笔记库"
            allowClear
            showSearch
            optionFilterProp="label"
            value={filter.vault || undefined}
            options={Array.from(vaults, ([value, label]) => ({ value, label }))}
            onChange={(vault) => filters({ vault: vault || "" })}
          />
          <Select
            aria-label="附件类型筛选"
            placeholder="文件类型"
            allowClear
            showSearch
            value={filter.type || undefined}
            options={types.map((value) => ({ value, label: value }))}
            onChange={(type) => filters({ type: type || "" })}
          />
          <Select
            aria-label="上传状态筛选"
            placeholder="上传状态"
            allowClear
            value={filter.upload || undefined}
            options={Object.entries(uploadLabels).map(([value, label]) => ({
              value,
              label,
            }))}
            onChange={(upload) => filters({ upload: upload || "" })}
          />
          <Select
            aria-label="最小文件大小"
            value={filter.minMiB}
            options={[
              { value: 0, label: "全部大小" },
              { value: 1, label: "至少 1 MiB" },
              { value: 10, label: "至少 10 MiB" },
              { value: 100, label: "至少 100 MiB" },
            ]}
            onChange={(minMiB) => filters({ minMiB })}
          />
          <Button onClick={() => filters(initialFilters)}>重置筛选</Button>
        </div>
        <div className="gm-selection">
          <span>
            共 {matches.length} 个附件
            {selection.length > 0 &&
              ` · 已选 ${selection.length} 个，共 ${bytes(selection)}`}
          </span>
          <Button
            danger
            disabled={
              !selection.length || selection.length > 200 || busy || loading
            }
            onClick={() => open(selection)}
          >
            批量移入回收站
          </Button>
          {selection.length > 200 && <span>每次最多操作 200 个附件</span>}
        </div>
        <DataTable<Asset>
          rowKey="asset_id"
          loading={loading}
          dataSource={matches}
          pagination={{
            current: Math.min(
              page,
              Math.max(1, Math.ceil(matches.length / 10)),
            ),
            pageSize: 10,
            showSizeChanger: false,
            hideOnSinglePage: true,
            onChange: setPage,
          }}
          rowSelection={{
            selectedRowKeys: selected,
            preserveSelectedRowKeys: true,
            onChange: (keys) => setSelected(keys.map(String)),
          }}
          columns={[
            {
              title: "附件名",
              dataIndex: "name",
              sorter: (a, b) => a.name.localeCompare(b.name),
            },
            { title: "所属用户", dataIndex: "owner_email" },
            { title: "笔记库", dataIndex: "vault_name" },
            { title: "文件类型", dataIndex: "media_type" },
            {
              title: "大小",
              dataIndex: "content_size",
              render: formatBytes,
              sorter: (a, b) => a.content_size - b.content_size,
            },
            {
              title: "上传状态",
              dataIndex: "status",
              render: (s) => uploadLabels[s] || s,
            },
            {
              title: "创建时间",
              dataIndex: "created_at",
              render: formatDate,
              sorter: (a, b) =>
                Date.parse(a.created_at) - Date.parse(b.created_at),
            },
            {
              title: "操作",
              render: (_, a) => (
                <Button
                  size="small"
                  type="link"
                  danger={!a.deleted}
                  disabled={busy}
                  onClick={() => open([a])}
                >
                  移入回收站
                </Button>
              ),
            },
          ]}
        />
      </Card>
      <Modal
        title="将附件移入用户回收站？"
        open={pending.length > 0}
        okText="确认移入"
        okButtonProps={{ danger: true }}
        confirmLoading={busy}
        onCancel={() => {
          if (!busy) setPending([]);
        }}
        onOk={confirm}
      >
        <p>
          {pending.length} 个附件，共 {bytes(pending)}。
          用户可在笔记库的回收站恢复或彻底删除。
        </p>
        <ul className="gm-confirm-list">
          {pending.map((a) => (
            <li key={a.asset_id}>
              {a.name} · {a.vault_name}
            </li>
          ))}
        </ul>
        {submitted && errorMessage && (
          <Alert type="error" title={errorMessage} />
        )}
      </Modal>
    </>
  );
}
