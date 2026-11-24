import { AppShell, MantineProvider } from "@mantine/core";
import "@mantine/core/styles/AppShell.layer.css";
import { useLayoutEffect, type HTMLAttributes } from "react";
import { applyColorScheme, loadColorScheme } from "./appearance";

export function WorkspaceShell(props: HTMLAttributes<HTMLDivElement>) {
  useLayoutEffect(() => {
    const previous = loadColorScheme();
    applyColorScheme("light");
    return () => applyColorScheme(previous);
  }, []);
  return (
    <MantineProvider forceColorScheme="light">
      <AppShell padding={0} transitionDuration={0} {...props} />
    </MantineProvider>
  );
}
