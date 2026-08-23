import { existsSync } from "node:fs";
import path from "node:path";

export interface ShellOption {
  id: string;
  label: string;
  file: string;
  args: string[];
}

/** Available shells on this machine, preferred first. */
export function detectShells(): ShellOption[] {
  const shells: ShellOption[] = [];
  if (process.platform === "win32") {
    const system32 = path.join(process.env.SystemRoot ?? "C:/Windows", "System32");
    const pwsh = [
      "C:/Program Files/PowerShell/7/pwsh.exe",
      "C:/Program Files/PowerShell/7-preview/pwsh.exe",
    ].find(existsSync);
    if (pwsh) shells.push({ id: "pwsh", label: "PowerShell 7", file: pwsh, args: ["-NoLogo"] });
    shells.push({
      id: "powershell",
      label: "Windows PowerShell",
      file: path.join(system32, "WindowsPowerShell/v1.0/powershell.exe"),
      args: ["-NoLogo"],
    });
    const gitBash = [
      "C:/Program Files/Git/bin/bash.exe",
      "C:/Program Files (x86)/Git/bin/bash.exe",
    ].find(existsSync);
    if (gitBash) shells.push({ id: "bash", label: "Git Bash", file: gitBash, args: ["-i"] });
    shells.push({
      id: "cmd",
      label: "Command Prompt",
      file: path.join(system32, "cmd.exe"),
      args: [],
    });
    if (existsSync(path.join(system32, "wsl.exe"))) {
      shells.push({ id: "wsl", label: "WSL", file: path.join(system32, "wsl.exe"), args: [] });
    }
    return shells;
  }
  const login = process.env.SHELL;
  if (login) shells.push({ id: "login", label: path.basename(login), file: login, args: ["-l"] });
  for (const candidate of ["/bin/zsh", "/bin/bash"]) {
    if (existsSync(candidate) && candidate !== login) {
      shells.push({
        id: path.basename(candidate),
        label: path.basename(candidate),
        file: candidate,
        args: ["-l"],
      });
    }
  }
  return shells;
}

/** ConPTY misbehaves without SystemRoot (0x8009001d) — always pass a sane env. */
export function ptyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  if (process.platform === "win32" && !env.SystemRoot) env.SystemRoot = "C:\\Windows";
  env.TERM = "xterm-256color";
  return env;
}
