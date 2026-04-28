/**
 * Opens the user's default browser to the given URL.
 * Uses platform-native commands — no dependencies needed.
 */

import { exec } from "node:child_process";

export function openBrowser(port: number): void {
  const url = `http://localhost:${port}`;
  const cmd =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";

  exec(`${cmd} ${url}`, () => {
    // Silently ignore errors (e.g. no display on a headless server)
  });
}
