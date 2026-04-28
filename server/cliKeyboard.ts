/**
 * Interactive keyboard shortcuts for the running CLI server.
 *
 * While the server is running, the user can press:
 *   o — open browser
 *   q — quit
 *   c — clear console
 *   h — show shortcut help
 */

import { openBrowser } from "./cliBrowser.js";

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;

export function startKeyboardShortcuts(
  port: number,
  onQuit: () => void,
): void {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  process.stdin.on("data", (key: string) => {
    switch (key) {
      case "o":
        openBrowser(port);
        break;
      case "c":
        console.clear();
        break;
      case "q":
        onQuit();
        break;
      case "h":
        printShortcutHelp();
        break;
      case "\u0003": // Ctrl+C
        onQuit();
        break;
    }
  });
}

function printShortcutHelp(): void {
  console.log(
    `\n  Shortcuts:\n` +
      `    ${dim("o")}  open in browser\n` +
      `    ${dim("c")}  clear console\n` +
      `    ${dim("q")}  quit\n` +
      `    ${dim("h")}  show this help\n`,
  );
}

export function printShortcutHint(): void {
  console.log(dim("  press h for shortcuts\n"));
}
