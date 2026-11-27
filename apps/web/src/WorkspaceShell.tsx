import { AppShell, MantineProvider } from "@mantine/core";
import "@mantine/core/styles/AppShell.layer.css";
import { ConfigProvider, theme } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { HTMLAttributes } from "react";
import { useColorScheme } from "./appearance";

export function WorkspaceShell(props: HTMLAttributes<HTMLDivElement>) {
  const scheme = useColorScheme();
  return (
    <MantineProvider forceColorScheme={scheme}>
      <ConfigProvider locale={zhCN} button={{ autoInsertSpace: false }} theme={{
        algorithm: scheme === "dark" ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: { colorPrimary: "#3566ce", borderRadius: 6,
          fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif' },
      }}>
        <AppShell padding={0} transitionDuration={0} {...props} />
      </ConfigProvider>
    </MantineProvider>
  );
}
