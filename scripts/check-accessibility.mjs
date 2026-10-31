/**
 * Accessibility audit of the public marketing site.
 *
 * Runs axe-core against every public page in headless Chrome and reports
 * WCAG A/AA violations, plus the landmarks, heading order, alt text, label
 * coverage and focus-visibility signals the brief requires.
 *
 * Run from the repository root:
 *   node scripts/check-accessibility.mjs http://localhost:3111
 */

import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const BASE = process.argv[2] ?? "http://localhost:3111";
const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const PAGES = [
  "/",
  "/features",
  "/solutions",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
];

const AXE_SOURCE = "https://cdn.jsdelivr.net/npm/axe-core@4.10.2/axe.min.js";

const CHROME_FLAGS = [
  "--headless=new",
  "--disable-gpu",
  "--hide-scrollbars",
  "--no-first-run",
  "--no-default-browser-check",
  "--remote-debugging-port=0",
  "--user-data-dir=" + process.env.TEMP + "/opencode-chrome-a11y",
];

async function main() {
  const axeSource = await fetch(AXE_SOURCE).then((r) => r.text());

  const child = spawn(CHROME, [...CHROME_FLAGS, "about:blank"], {
    stdio: ["ignore", "pipe", "pipe"],
  });

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

  const { result: target } = await send("Target.createTarget", { url: "about:blank" });
  const { result: attached } = await send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const sessionId = attached.sessionId;

  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  await send(
    "Emulation.setDeviceMetricsOverride",
    { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false },
    sessionId
  );

  let totalViolations = 0;
  const report = [];

  /**
   * Wait until the page has actually painted its content. A fixed sleep can
   * catch a half-loaded document, which produces a false "no violations"
   * result on an empty page.
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

  for (const path of PAGES) {
    await send("Page.navigate", { url: `${BASE}${path}` }, sessionId);
    const textLength = await waitForContent();
    if (textLength === 0) {
      report.push(`${path}: page never rendered content`);
      totalViolations += 1;
      continue;
    }
    await delay(300);

    await send(
      "Runtime.evaluate",
      { expression: axeSource, returnByValue: true },
      sessionId
    );

    const { result } = await send(
      "Runtime.evaluate",
      {
        returnByValue: true,
        awaitPromise: true,
        expression: `(async () => {
          const axeResults = await axe.run(document, {
            runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
          });

          const headings = Array.from(document.querySelectorAll("h1,h2,h3,h4,h5,h6"))
            .map((h) => Number(h.tagName.slice(1)));
          let headingJumps = 0;
          for (let i = 1; i < headings.length; i += 1) {
            if (headings[i] - headings[i - 1] > 1) headingJumps += 1;
          }

          const images = Array.from(document.querySelectorAll("img"));
          const missingAlt = images.filter((img) => !img.hasAttribute("alt")).length;
          const decorativeAlt = images.filter((img) => img.getAttribute("alt") === "").length;

          const formControls = Array.from(
            document.querySelectorAll("input,select,textarea")
          );
          const unlabelled = formControls.filter((el) => {
            if (el.getAttribute("aria-label")) return false;
            if (el.getAttribute("aria-labelledby")) return false;
            if (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) return false;
            return !el.closest("label");
          }).length;

          const focusable = document.querySelectorAll(
            'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'
          ).length;

          const landmarks = {
            header: document.querySelectorAll("header").length,
            nav: document.querySelectorAll("nav").length,
            main: document.querySelectorAll("main").length,
            footer: document.querySelectorAll("footer").length,
          };

          const skipLink = document.querySelector('a[href^="#"]');

          return {
            violations: axeResults.violations.map((v) => ({
              id: v.id,
              impact: v.impact,
              help: v.help,
              nodes: v.nodes.length,
              target: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
            })),
            h1Count: headings.filter((l) => l === 1).length,
            headingJumps,
            imageCount: images.length,
            missingAlt,
            decorativeAlt,
            formControlCount: formControls.length,
            unlabelled,
            focusable,
            landmarks,
            skipLinkText: skipLink ? skipLink.textContent.trim() : null,
            lang: document.documentElement.lang,
            title: document.title,
          };
        })()`,
      },
      sessionId
    );

    const info = result?.result?.value;
    if (!info) {
      report.push(`${path}: no evaluation result`);
      totalViolations += 1;
      continue;
    }

    totalViolations += info.violations.length;
    console.log(`\n${path}`);
    console.log(`  title: ${info.title}`);
    console.log(`  lang: ${info.lang} | h1 count: ${info.h1Count} | heading jumps: ${info.headingJumps}`);
    console.log(`  landmarks: ${JSON.stringify(info.landmarks)}`);
    console.log(`  images: ${info.imageCount} (missing alt ${info.missingAlt}, decorative ${info.decorativeAlt})`);
    console.log(`  form controls: ${info.formControlCount} (unlabelled ${info.unlabelled})`);
    console.log(`  focusable elements: ${info.focusable} | skip link: ${JSON.stringify(info.skipLinkText)}`);
    if (info.violations.length === 0) {
      console.log("  axe violations: none");
    } else {
      for (const v of info.violations) {
        console.log(`  VIOLATION [${v.impact}] ${v.id}: ${v.help} (${v.nodes} node(s)) ${JSON.stringify(v.target)}`);
      }
    }
  }

  socket.close();
  child.kill();

  console.log(`\n--- summary ---`);
  if (report.length) {
    console.log("Page load problems:");
    report.forEach((r) => console.log("  " + r));
  }
  console.log(`axe violations across ${PAGES.length} public pages: ${totalViolations}`);
  if (totalViolations > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
