/**
 * Responsive overflow check.
 *
 * Loads each public page in headless Chrome at every required viewport width
 * and reports:
 *   - document.scrollWidth vs the viewport width (horizontal overflow)
 *   - any element whose right edge extends past the viewport
 *
 * Run from the repository root:
 *   node scripts/check-responsive.mjs http://localhost:3111
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://localhost:3111";
const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const WIDTHS = [320, 360, 390, 768, 1024, 1440, 1920];
const PAGES = [
  "/",
  "/features",
  "/solutions",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
];

const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  "--user-data-dir=" + process.env.TEMP + "/opencode-chrome-responsive",
];

function chrome() {
  const child = spawn(CHROME, [...CHROME_FLAGS, "about:blank"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return child;
}

async function main() {
  const child = chrome();
  const wsUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("Chrome did not start")), 30000);
    child.stderr.on("data", (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/ws:\/\/[^\s]+/);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Chrome exited early (${code})`));
    });
  });

  const { WebSocket } = await import("node:worker_threads").then(() => ({
    WebSocket: globalThis.WebSocket,
  }));

  const socket = new WebSocket(wsUrl);
  await new Promise((resolve) => socket.addEventListener("open", resolve));

  let messageId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const resolver = pending.get(message.id);
    if (resolver) {
      pending.delete(message.id);
      resolver(message);
    }
  });

  function send(method, params = {}, sessionId) {
    const id = ++messageId;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  // Attach to a fresh tab.
  const { result: target } = await send("Target.createTarget", { url: "about:blank" });
  const { result: attached } = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);

  const failures = [];

  /**
   * Wait until the page has actually painted its content. Measuring a
   * half-loaded document can miss elements that overflow the viewport.
   */
  async function waitForContent() {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const { result } = await send(
        "Runtime.evaluate",
        {
          returnByValue: true,
          expression:
            "document.readyState === 'complete' ? document.body.innerText.length : -1",
        },
        sessionId
      );
      const length = result?.result?.value;
      if (typeof length === "number" && length > 200) return length;
      await delay(250);
    }
    return 0;
  }

  for (const width of WIDTHS) {
    await send(
      "Emulation.setDeviceMetricsOverride",
      { width, height: 900, deviceScaleFactor: 1, mobile: width < 768 },
      sessionId
    );

    for (const path of PAGES) {
      await send("Page.navigate", { url: `${BASE}${path}` }, sessionId);
      const textLength = await waitForContent();
      if (textLength === 0) {
        failures.push(`${width}px ${path}: page never rendered content`);
        continue;
      }
      await delay(200);

      const { result } = await send(
        "Runtime.evaluate",
        {
          returnByValue: true,
          expression: `(() => {
            const docWidth = document.documentElement.scrollWidth;
            const viewport = window.innerWidth;
            const offenders = [];
            for (const el of document.querySelectorAll("body *")) {
              const rect = el.getBoundingClientRect();
              if (rect.width === 0 && rect.height === 0) continue;
              if (rect.right > viewport + 1) {
                offenders.push({
                  tag: el.tagName.toLowerCase(),
                  cls: (el.className && el.className.baseVal !== undefined
                        ? el.className.baseVal
                        : String(el.className || "")).slice(0, 90),
                  right: Math.round(rect.right),
                });
              }
            }
            return {
              docWidth,
              viewport,
              scrollHeight: document.documentElement.scrollHeight,
              offenders: offenders.slice(0, 6),
            };
          })()`,
        },
        sessionId
      );

      const info = result?.result?.value;
      if (!info) {
        failures.push(`${width}px ${path}: no evaluation result`);
        continue;
      }
      const overflow = info.docWidth > info.viewport + 1;
      const status = overflow || info.offenders.length ? "FAIL" : "ok";
      if (status === "FAIL") {
        failures.push(
          `${width}px ${path}: scrollWidth=${info.docWidth} viewport=${info.viewport} offenders=${JSON.stringify(info.offenders)}`
        );
      }
      console.log(`${status.padEnd(4)} ${String(width).padStart(4)}px ${path} (scrollWidth ${info.docWidth}, height ${info.scrollHeight})`);
    }
  }

  socket.close();
  child.kill();

  console.log("\n--- summary ---");
  if (failures.length === 0) {
    console.log(`PASS: no horizontal overflow at ${WIDTHS.join(", ")}px across ${PAGES.length} pages`);
  } else {
    console.log(`FAIL: ${failures.length} issue(s)`);
    failures.forEach((f) => console.log("  " + f));
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
