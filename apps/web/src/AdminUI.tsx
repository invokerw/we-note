import { BookOutlined } from "@ant-design/icons";
import { ConfigProvider, Empty, Table, Tag } from "antd";
import type { TableProps } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ReactNode } from "react";
import "./admin.css";

export function AdminTheme({ children }: { children: ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      button={{ autoInsertSpace: false }}
      theme={{
        token: {
          colorPrimary: "#5546b2",
          colorLink: "#5546b2",
          colorText: "#222536",
          colorTextSecondary: "#626578",
          colorBorderSecondary: "#e6e6ee",
          borderRadius: 9,
          fontFamily:
            'Inter, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        },
        components: {
          Table: { headerBg: "#f7f7fb", headerColor: "#55586d" },
          Button: { defaultShadow: "none", primaryShadow: "none" },
        },
      }}
    >
      {children}
    </ConfigProvider>
  );
}
export function Brand() {
  return (
    <div className="gm-brand">
      <span>
        <BookOutlined />
      </span>
      WeNote
    </div>
  );
}
export function formatBytes(value: number) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = value,
    i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Number(n.toFixed(1)).toLocaleString()} ${units[i]}`;
}
export function formatDate(value?: string) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
        hour12: false,
      })
    : "—";
}
export function DataTable<T extends object>(props: TableProps<T>) {
  return (
    <Table<T>
      size="middle"
      scroll={{ x: "max-content" }}
      pagination={{
        pageSize: 10,
        hideOnSinglePage: true,
        showSizeChanger: false,
      }}
      locale={{
        emptyText: (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无记录" />
        ),
      }}
      {...props}
    />
  );
}
export function Status({
  children,
  color,
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <Tag color={color} bordered={false}>
      {children}
    </Tag>
  );
}
