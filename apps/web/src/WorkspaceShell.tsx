import { AppShell, MantineProvider } from "@mantine/core";
import "@mantine/core/styles/AppShell.layer.css";
import type { HTMLAttributes } from "react";
import { useColorScheme } from "./appearance";

export function WorkspaceShell(props: HTMLAttributes<HTMLDivElement>) {
  const scheme = useColorScheme();
  return (
    <MantineProvider forceColorScheme={scheme}>
      <AppShell padding={0} transitionDuration={0} {...props} />
    </MantineProvider>
  );
}
