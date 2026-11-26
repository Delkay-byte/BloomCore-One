/**
 * Loopback-only provider stand-ins for tooling.
 *
 * The application is NOT pointed at this server: every outbound provider
 * credential is blanked, and the app's SMS adapter is a fixed mock. This server
 * exists so a harness can exercise timeout/retry handling without ever calling
 * Resend, Paystack, Turnstile, DeepSeek, WhatsApp or an SMS provider.
 */
import http from "node:http";
import { assertLocalTarget } from "./env.mjs";

assertLocalTarget("http://127.0.0.1:3101");
const HOST = "127.0.0.1";
const PORT = 5599;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
  res.setHeader("content-type", "application/json");
  if (url.pathname === "/health") {
    res.end(JSON.stringify({ status: "ok", provider: "local_mock_only" }));
    return;
  }
  if (url.pathname === "/turnstile/timeout") {
    await sleep(10_000);
    res.end(JSON.stringify({ success: false, error: "simulated_timeout" }));
    return;
  }
  if (url.pathname === "/paystack/webhook") {
    res.end(JSON.stringify({ received: true, decision: "synthetic_mock" }));
    return;
  }
  if (url.pathname === "/deepseek/chat") {
    res.end(JSON.stringify({ choices: [{ message: { content: "synthetic local response" } }] }));
    return;
  }
  // Deterministic failure modes for a future test-only transport seam.
  // Every body is synthetic; no provider credential is used.
  if (url.pathname === "/failure/read-timeout") {
    await sleep(10_000);
    res.end(JSON.stringify({ error: "simulated_read_timeout" }));
    return;
  }
  if (url.pathname === "/failure/reset") {
    req.socket.destroy();
    return;
  }
  if (url.pathname === "/failure/429") {
    res.statusCode = 429;
    res.setHeader("retry-after", "2");
    res.end(JSON.stringify({ error: "simulated_rate_limit" }));
    return;
  }
  if (url.pathname === "/failure/5xx") {
    res.statusCode = 503;
    res.end(JSON.stringify({ error: "simulated_server_error" }));
    return;
  }
  if (url.pathname === "/failure/malformed") {
    res.setHeader("content-type", "text/plain");
    res.end("{not valid json");
    return;
  }
  if (url.pathname === "/failure/delayed-success") {
    await sleep(1500);
    res.end(JSON.stringify({ ok: true, ambiguous: true, synthetic: true }));
    return;
  }
  if (url.pathname === "/failure/oversize") {
    res.end("x".repeat(300 * 1024));
    return;
  }
  res.end(JSON.stringify({ ok: true, provider: "local_mock", path: url.pathname, delivered: false }));
});
server.listen(PORT, HOST, () => {
  console.log(`Local provider mocks listening on http://${HOST}:${PORT} (loopback only).`);
});
