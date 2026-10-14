/**
 * Local web dashboard for scripts/pons-sniper.ts: edit the settings, start/stop the bot, watch its log.
 *
 *   npx tsx scripts/sniper-ui.ts            # http://127.0.0.1:3010
 *   SNIPER_UI_PORT=3020 npx tsx scripts/sniper-ui.ts
 *
 * It only listens on 127.0.0.1 and must never be exposed to the internet: whoever can open this page can
 * trade with the wallet in sniper-config.json. The private key is write-only here (never sent to the browser).
 */
import fs from "fs";
import http from "http";
import path from "path";
import { spawn, type ChildProcess } from "child_process";
import { createPublicClient, createWalletClient, formatEther, http as viemHttp, maxUint256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { robinhoodChain } from "../src/config/chain";
import { PONS_CURVE_ABI, PONS_TOKEN_ABI } from "../src/config/abis";

const PORT = Number(process.env.SNIPER_UI_PORT || 3010);
const CONFIG_PATH = path.resolve("sniper-config.json");
const EXAMPLE_PATH = path.resolve("sniper-config.example.json");
const POSITIONS_PATH = path.resolve("sniper-positions.json");
const HISTORY_PATH = path.resolve("sniper-history.json");
const MAX_LOG_LINES = 400;
const KEY_RE = /^(0x)?[0-9a-fA-F]{64}$/;

type Config = Record<string, unknown> & { privateKey?: string; rpcUrl?: string };

let bot: ChildProcess | null = null;
let botMode: "dry" | "live" | null = null;
const logLines: string[] = [];

function pushLog(chunk: string) {
  for (const line of chunk.split("\n")) {
    if (line.trim()) logLines.push(line);
  }
  if (logLines.length > MAX_LOG_LINES) logLines.splice(0, logLines.length - MAX_LOG_LINES);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch {
    return fallback;
  }
}

function readConfig(): Config {
  const example = readJson<Config>(EXAMPLE_PATH, {});
  const saved = readJson<Config>(CONFIG_PATH, {});
  return { ...example, ...saved, privateKey: KEY_RE.test(saved.privateKey ?? "") ? saved.privateKey : "" };
}

function walletAddress(cfg: Config): string | null {
  if (!KEY_RE.test(cfg.privateKey ?? "")) return null;
  const key = cfg.privateKey as string;
  return privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex).address;
}

async function walletBalance(cfg: Config, address: string | null): Promise<string | null> {
  if (!address) return null;
  try {
    const client = createPublicClient({ chain: robinhoodChain, transport: viemHttp(cfg.rpcUrl || process.env.ROBINHOOD_RPC_URL || undefined) });
    return formatEther(await client.getBalance({ address: address as `0x${string}` }));
  } catch {
    return null;
  }
}

const NUMBER_FIELDS = ["slippagePercent", "maxCreatorTaxPercent", "maxSnipeTaxPercent", "maxLaunchAgeSeconds", "maxOpenPositions", "takeProfitPercent", "stopLossPercent", "maxHoldSeconds"];
const ETH_FIELDS = ["buyEth", "maxTotalSpendEth", "gasReserveEth"];
const LIST_FIELDS = ["keywords", "blockedKeywords", "allowedDeployers", "blockedDeployers"];

/** Validates the form and merges it into the saved config. Returns an error message or null. */
function saveConfig(body: Record<string, unknown>): string | null {
  const next: Config = readConfig();
  for (const f of NUMBER_FIELDS) {
    const n = Number(body[f]);
    if (!Number.isFinite(n) || n < 0) return `${f} must be a number >= 0`;
    next[f] = n;
  }
  for (const f of ETH_FIELDS) {
    const v = String(body[f] ?? "").trim();
    if (!/^\d+(\.\d{1,18})?$/.test(v)) return `${f} must be an ETH amount like 0.005`;
    next[f] = v;
  }
  for (const f of LIST_FIELDS) {
    next[f] = String(body[f] ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  }
  // Wallet addresses only mean something in the deployer lists; as a keyword they silently skip every launch
  for (const f of ["keywords", "blockedKeywords"]) {
    if ((next[f] as string[]).some((k) => /^0x[0-9a-fA-F]{40}$/.test(k))) {
      return "Kata kunci tidak boleh berisi alamat wallet. Alamat dev diisi di kolom 6 (atau Blokir dev).";
    }
  }
  const rpcUrl = String(body.rpcUrl ?? "").trim();
  if (rpcUrl && !/^https?:\/\//.test(rpcUrl)) return "rpcUrl must start with http:// or https://";
  next.rpcUrl = rpcUrl || undefined;

  // Key is only replaced when a new one is typed; an empty field keeps the saved key
  const key = String(body.privateKey ?? "").trim();
  if (key) {
    if (!KEY_RE.test(key)) return "privateKey must be a 64-hex-character EVM private key";
    next.privateKey = key;
  }
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
  return null;
}

function startBot(execute: boolean): string | null {
  if (bot) return "Bot is already running. Stop it first.";
  if (!walletAddress(readConfig())) return "Save a private key first.";
  if (!fs.existsSync(CONFIG_PATH)) return "Save the settings first.";
  const args = ["scripts/pons-sniper.ts", ...(execute ? ["--execute"] : [])];
  const child = spawn(path.resolve("node_modules/.bin/tsx"), args, { env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  bot = child;
  botMode = execute ? "live" : "dry";
  pushLog(`--- started ${execute ? "LIVE" : "DRY RUN"} at ${new Date().toLocaleTimeString()} ---`);
  child.stdout?.on("data", (d: Buffer) => pushLog(d.toString()));
  child.stderr?.on("data", (d: Buffer) => pushLog(d.toString()));
  child.on("exit", (code) => {
    pushLog(`--- bot stopped${code ? ` (exit code ${code})` : ""} ---`);
    if (bot === child) {
      bot = null;
      botMode = null;
    }
  });
  return null;
}

interface StoredPosition {
  token: `0x${string}`;
  curve: `0x${string}`;
  symbol: string;
  costWei: string;
  boughtAt: number;
}

// Same shape pons-sniper.ts appends to sniper-history.json
interface Trade {
  token: `0x${string}`;
  symbol: string;
  costWei: string;
  receivedWei: string | null;
  boughtAt: number;
  closedAt: number;
  reason: string;
  tx: string | null;
}

let selling = false;

/** Manual exit: sells the whole balance of one open position on its curve, right now. */
async function sellPosition(token: string): Promise<string> {
  if (selling) throw new Error("Another sell is still in progress.");
  const cfg = readConfig();
  const pos = readJson<StoredPosition[]>(POSITIONS_PATH, []).find((p) => p.token.toLowerCase() === token.toLowerCase());
  if (!pos) throw new Error("That token is not an open position.");
  if (!KEY_RE.test(cfg.privateKey ?? "")) throw new Error("No private key saved.");

  selling = true;
  try {
    const key = cfg.privateKey as string;
    const account = privateKeyToAccount((key.startsWith("0x") ? key : `0x${key}`) as Hex);
    const transport = viemHttp(cfg.rpcUrl || process.env.ROBINHOOD_RPC_URL || undefined);
    const publicClient = createPublicClient({ chain: robinhoodChain, transport });
    const walletClient = createWalletClient({ account, chain: robinhoodChain, transport });

    const [balance, allowance] = await Promise.all([
      publicClient.readContract({ address: pos.token, abi: PONS_TOKEN_ABI, functionName: "balanceOf", args: [account.address] }),
      publicClient.readContract({ address: pos.token, abi: PONS_TOKEN_ABI, functionName: "allowance", args: [account.address, pos.curve] }),
    ]);
    if (balance === 0n) throw new Error("The wallet holds none of this token anymore.");
    if (allowance < balance) {
      const approveTx = await walletClient.writeContract({ address: pos.token, abi: PONS_TOKEN_ABI, functionName: "approve", args: [pos.curve, maxUint256] });
      await publicClient.waitForTransactionReceipt({ hash: approveTx });
    }

    const { request, result: quoteOut } = await publicClient.simulateContract({
      account,
      address: pos.curve,
      abi: PONS_CURVE_ABI,
      functionName: "sell",
      args: [balance, 0n, account.address],
    });
    const slippage = Number(cfg.slippagePercent ?? 15);
    const minQuoteOut = (quoteOut * BigInt(Math.round((100 - slippage) * 100))) / 10000n;
    const sellTx = await walletClient.writeContract({ ...request, args: [balance, minQuoteOut, account.address] });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: sellTx });
    if (receipt.status !== "success") throw new Error(`Sell transaction reverted (${sellTx})`);

    pushLog(`[${new Date().toLocaleTimeString()}] SELL  $${pos.symbol} (manual) for ~${formatEther(quoteOut)} ETH (${sellTx})`);
    const history = readJson<Trade[]>(HISTORY_PATH, []);
    history.push({ token: pos.token, symbol: pos.symbol, costWei: pos.costWei, receivedWei: quoteOut.toString(), boughtAt: pos.boughtAt, closedAt: Date.now(), reason: "manual", tx: sellTx });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2), "utf-8");
    // Drop the position here so the running bot does not also log it as "sold outside the bot"
    const rest = readJson<StoredPosition[]>(POSITIONS_PATH, []).filter((p) => p.token.toLowerCase() !== token.toLowerCase());
    fs.writeFileSync(POSITIONS_PATH, JSON.stringify(rest, null, 2), "utf-8");
    return formatEther(quoteOut);
  } finally {
    selling = false;
  }
}

function stopBot() {
  bot?.kill("SIGTERM");
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 64_000) reject(new Error("Body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // Only this machine's browser may talk to the dashboard (blocks DNS rebinding and cross-site requests)
  const allowedHosts = [`127.0.0.1:${PORT}`, `localhost:${PORT}`];
  if (!allowedHosts.includes(req.headers.host ?? "")) return sendJson(res, 403, { error: "Forbidden" });
  if (req.method === "POST") {
    const origin = req.headers.origin;
    const sameOrigin = !!origin && allowedHosts.some((h) => origin === `http://${h}`);
    if (!sameOrigin || !(req.headers["content-type"] ?? "").includes("application/json")) return sendJson(res, 403, { error: "Forbidden" });
  }

  try {
    if (req.method === "GET" && req.url === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      return res.end(PAGE);
    }
    if (req.method === "GET" && req.url === "/api/state") {
      const cfg = readConfig();
      const address = walletAddress(cfg);
      const { privateKey: _key, ...publicConfig } = cfg;
      return sendJson(res, 200, {
        running: !!bot,
        mode: botMode,
        address,
        balance: await walletBalance(cfg, address),
        config: publicConfig,
        positions: readJson<unknown[]>(POSITIONS_PATH, []),
        history: readJson<Trade[]>(HISTORY_PATH, []).slice(-50).reverse(),
        log: logLines,
      });
    }
    if (req.method === "POST" && req.url === "/api/config") {
      if (bot) return sendJson(res, 400, { error: "Stop the bot before changing settings." });
      const error = saveConfig(await readBody(req));
      return sendJson(res, error ? 400 : 200, error ? { error } : { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/start") {
      const body = await readBody(req);
      const error = startBot(body.execute === true);
      return sendJson(res, error ? 400 : 200, error ? { error } : { ok: true });
    }
    if (req.method === "POST" && req.url === "/api/sell") {
      const body = await readBody(req);
      try {
        return sendJson(res, 200, { ok: true, received: await sellPosition(String(body.token ?? "")) });
      } catch (err) {
        const e = err as { shortMessage?: string; message?: string };
        return sendJson(res, 400, { error: (e.shortMessage || e.message || "Sell failed").split("\n")[0] });
      }
    }
    if (req.method === "POST" && req.url === "/api/stop") {
      stopBot();
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { error: "Not found" });
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : "Server error" });
  }
});

process.on("SIGINT", () => {
  stopBot();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopBot();
  process.exit(0);
});

server.listen(PORT, "127.0.0.1", () => console.log(`Sniper dashboard: http://127.0.0.1:${PORT}`));

// ─── Page ────────────────────────────────────────────────────────────────────

const PAGE = String.raw`<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Pons Sniper</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b0c10; color: #e4e4e7; font: 14px/1.5 -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 20px 16px 60px; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: #a1a1aa; margin: 0 0 12px; }
  .card { background: #121318; border: 1px solid #27272a; border-radius: 14px; padding: 18px; margin-top: 16px; }
  .row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 12px; }
  label { display: block; font-size: 12px; color: #a1a1aa; }
  label small { display: block; color: #71717a; font-size: 11px; }
  input, textarea { width: 100%; margin-top: 4px; padding: 8px 10px; border-radius: 8px; border: 1px solid #3f3f46; background: #09090b; color: #e4e4e7; font: 13px ui-monospace, Menlo, monospace; }
  input:focus, textarea:focus { outline: none; border-color: #facc15; }
  button { padding: 9px 16px; border-radius: 8px; border: 1px solid #3f3f46; background: #18181b; color: #e4e4e7; font-weight: 600; cursor: pointer; }
  button:disabled { opacity: .4; cursor: not-allowed; }
  .primary { background: #facc15; color: #000; border-color: #facc15; }
  .danger { background: #dc2626; border-color: #dc2626; color: #fff; }
  .pill { padding: 3px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; border: 1px solid #3f3f46; color: #a1a1aa; }
  .pill.dry { color: #38bdf8; border-color: #0369a1; }
  .pill.live { color: #4ade80; border-color: #15803d; }
  .mono { font-family: ui-monospace, Menlo, monospace; word-break: break-all; }
  #log { height: 340px; overflow: auto; background: #09090b; border: 1px solid #27272a; border-radius: 10px; padding: 10px; font: 12px/1.6 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
  .buy { color: #4ade80; } .sell { color: #facc15; } .dryl { color: #38bdf8; } .skip { color: #71717a; } .fail { color: #f87171; }
  #msg { font-size: 13px; min-height: 20px; margin-top: 10px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid #27272a; }
  .muted { color: #71717a; }
  .up { color: #4ade80; } .down { color: #f87171; }
  .scroll { overflow-x: auto; }
</style>
</head>
<body>
<main>
  <div class="row">
    <h1>Pons Sniper <span class="muted" style="font-size:13px;font-weight:400">Robinhood Chain</span></h1>
    <span id="status" class="pill">Mati</span>
  </div>

  <div class="card">
    <div class="row">
      <div>
        <h2>Wallet sniper</h2>
        <div class="mono" id="wallet">Belum ada private key</div>
      </div>
      <div class="row">
        <button id="btnDry">Mulai Dry Run (tanpa uang)</button>
        <button id="btnLive" class="primary">Mulai LIVE</button>
        <button id="btnStop" class="danger">Stop</button>
      </div>
    </div>
    <div id="msg"></div>
  </div>

  <div class="card">
    <h2>Log bot</h2>
    <div id="log"></div>
  </div>

  <div class="card">
    <h2>Posisi terbuka</h2>
    <div id="positions" class="muted">Tidak ada posisi.</div>
  </div>

  <div class="card">
    <div class="row" style="margin-bottom:12px">
      <h2 style="margin:0">Riwayat trade</h2>
      <span id="totalPnl" class="muted"></span>
    </div>
    <div id="history" class="muted">Belum ada trade yang selesai.</div>
  </div>

  <div class="card">
    <h2>Pengaturan</h2>
    <form id="form">
      <p class="muted" style="margin:0 0 12px">Cukup isi 6 kolom ini. Sisanya sudah punya nilai bawaan yang aman.</p>
      <div class="grid">
        <label>1. Private key wallet sniper<small>Wallet khusus, bukan wallet dev. Kosongkan untuk memakai yang tersimpan</small><input name="privateKey" type="password" autocomplete="off" placeholder="0x..."></label>
        <label>2. Beli per token (ETH)<small>ETH yang dipakai tiap kali snipe</small><input name="buyEth"></label>
        <label>3. Budget total (ETH)<small>Bot berhenti membeli setelah habis segini</small><input name="maxTotalSpendEth"></label>
        <label>4. Take profit (%)<small>Jual otomatis saat untung segini</small><input name="takeProfitPercent"></label>
        <label>5. Stop loss (%)<small>Jual otomatis saat rugi segini</small><input name="stopLossPercent"></label>
      </div>
      <div style="margin-top:12px">
        <label>6. Hanya snipe token dari dev ini (alamat 0x, pisahkan koma)<small>Isi alamat wallet dev kamu untuk snipe token sendiri. Kosong = snipe semua token baru</small><textarea name="allowedDeployers" rows="2"></textarea></label>
      </div>

      <details style="margin-top:16px">
        <summary style="cursor:pointer;color:#a1a1aa;font-size:13px">Pengaturan lanjutan (boleh dibiarkan)</summary>
        <div class="grid" style="margin-top:12px">
          <label>Maks hold (detik)<small>Jual paksa setelah segini. 0 = tidak pernah</small><input name="maxHoldSeconds"></label>
          <label>Maks posisi sekaligus<small>Jumlah token yang dipegang bersamaan</small><input name="maxOpenPositions"></label>
          <label>Cadangan gas (ETH)<small>Saldo yang tidak boleh dipakai beli</small><input name="gasReserveEth"></label>
          <label>Slippage (%)<small>Toleransi selisih harga</small><input name="slippagePercent"></label>
          <label>Maks creator tax (%)<small>Lewati token dengan tax dev di atas ini</small><input name="maxCreatorTaxPercent"></label>
          <label>Maks snipe tax (%)<small>Bot menunggu sampai snipe tax turun ke sini</small><input name="maxSnipeTaxPercent"></label>
          <label>Maks umur launch (detik)<small>Lewati token yang sudah lebih tua dari ini</small><input name="maxLaunchAgeSeconds"></label>
          <label>RPC URL<small>Kosong = RPC bawaan</small><input name="rpcUrl" placeholder="https://..."></label>
        </div>
        <div class="grid" style="margin-top:12px;grid-template-columns:repeat(auto-fill,minmax(320px,1fr))">
          <label>Kata kunci nama/ticker<small>Hanya beli yang mengandung kata ini. Kosong = semua</small><textarea name="keywords" rows="2"></textarea></label>
          <label>Kata kunci diblokir<small>Lewati token yang mengandung kata ini</small><textarea name="blockedKeywords" rows="2"></textarea></label>
          <label>Blokir dev<small>Alamat dev yang tidak mau dibeli</small><textarea name="blockedDeployers" rows="2"></textarea></label>
        </div>
      </details>
      <div style="margin-top:14px"><button type="submit" id="btnSave" class="primary">Simpan pengaturan</button></div>
    </form>
  </div>
</main>
<script>
  var $ = function (id) { return document.getElementById(id); };
  var form = $("form");
  var formLoaded = false;
  var lastLogLength = -1;

  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }
  function lineClass(l) {
    if (l.indexOf("] BUY") > 0) return "buy";
    if (l.indexOf("] SELL") > 0) return "sell";
    if (l.indexOf("] DRY") > 0) return "dryl";
    if (l.indexOf("] skip") > 0) return "skip";
    if (l.indexOf("FAIL") > 0 || l.indexOf("error") > 0) return "fail";
    return "";
  }
  var REASONS = { "take profit": "Take profit", "stop loss": "Stop loss", "max hold time": "Waktu hold habis", "manual": "Jual manual", "graduated": "Graduate ke DEX (jual manual)", "sold outside the bot": "Dijual di luar bot" };
  function eth(wei) { return (Number(wei) / 1e18).toFixed(6); }
  function signed(n) { return '<span class="' + (n >= 0 ? "up" : "down") + '">' + (n >= 0 ? "+" : "") + n.toFixed(6) + "</span>"; }
  function pct(n) { return '<span class="' + (n >= 0 ? "up" : "down") + '">' + (n >= 0 ? "+" : "") + n.toFixed(2) + "%</span>"; }
  function setMsg(text, bad) { $("msg").textContent = text || ""; $("msg").style.color = bad ? "#f87171" : "#4ade80"; }

  function post(url, body) {
    return fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || "Gagal"); return j; }); });
  }

  function fillForm(cfg) {
    Array.prototype.forEach.call(form.elements, function (el) {
      if (!el.name || el.name === "privateKey") return;
      var v = cfg[el.name];
      el.value = Array.isArray(v) ? v.join(", ") : (v === undefined || v === null ? "" : v);
    });
  }

  function refresh() {
    fetch("/api/state").then(function (r) { return r.json(); }).then(function (s) {
      var st = $("status");
      st.className = "pill" + (s.mode ? " " + s.mode : "");
      st.textContent = s.mode === "live" ? "LIVE: beli & jual sungguhan" : s.mode === "dry" ? "Dry run: tidak ada transaksi" : "Mati";
      $("wallet").textContent = s.address ? s.address + (s.balance === null ? "  (saldo tidak terbaca)" : "  |  " + Number(s.balance).toFixed(5) + " ETH") : "Belum ada private key. Isi di Pengaturan lalu Simpan.";
      $("btnDry").disabled = $("btnLive").disabled = s.running || !s.address;
      $("btnStop").disabled = !s.running;
      $("btnSave").disabled = s.running;
      if (!formLoaded) { fillForm(s.config); formLoaded = true; }

      if (s.log.length !== lastLogLength) {
        var box = $("log");
        var stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
        box.innerHTML = s.log.map(function (l) { return '<div class="' + lineClass(l) + '">' + esc(l) + "</div>"; }).join("") || '<span class="muted">Belum ada log. Tekan Mulai Dry Run.</span>';
        if (stick) box.scrollTop = box.scrollHeight;
        lastLogLength = s.log.length;
      }

      $("positions").innerHTML = s.positions.length
        ? '<div class="scroll"><table><tr><th>Token</th><th>Alamat</th><th>Modal</th><th>Nilai sekarang</th><th>Untung/rugi</th><th>Dibeli</th><th></th></tr>' + s.positions.map(function (p) {
            var value = p.valueWei ? eth(p.valueWei) + " ETH" : '<span class="muted">menghitung...</span>';
            var pnl = typeof p.pnlPercent === "number" ? pct(p.pnlPercent) : "-";
            return "<tr><td>$" + esc(p.symbol) + '</td><td class="mono">' + esc(p.token) + "</td><td>" + eth(p.costWei) + " ETH</td><td>" + value + "</td><td>" + pnl + "</td><td>" + new Date(p.boughtAt).toLocaleTimeString() + '</td><td><button class="danger" data-sell="' + esc(p.token) + '" data-symbol="' + esc(p.symbol) + '">Jual sekarang</button></td></tr>';
          }).join("") + "</table></div>"
        : "Tidak ada posisi.";

      var known = s.history.filter(function (t) { return t.receivedWei !== null; });
      var profit = known.reduce(function (sum, t) { return sum + (Number(t.receivedWei) - Number(t.costWei)) / 1e18; }, 0);
      $("totalPnl").innerHTML = known.length ? "Total: " + signed(profit) + " ETH (" + known.length + " trade, belum termasuk gas)" : "";
      $("history").innerHTML = s.history.length
        ? '<div class="scroll"><table><tr><th>Token</th><th>Modal</th><th>Diterima</th><th>Untung/rugi</th><th>Alasan jual</th><th>Waktu</th></tr>' + s.history.map(function (t) {
            var got = t.receivedWei === null ? '<span class="muted">tidak diketahui</span>' : eth(t.receivedWei) + " ETH";
            var pnl = t.receivedWei === null ? "-" : pct(((Number(t.receivedWei) - Number(t.costWei)) / Number(t.costWei)) * 100);
            return "<tr><td>$" + esc(t.symbol) + "</td><td>" + eth(t.costWei) + " ETH</td><td>" + got + "</td><td>" + pnl + "</td><td>" + esc(REASONS[t.reason] || t.reason) + "</td><td>" + new Date(t.closedAt).toLocaleString() + "</td></tr>";
          }).join("") + "</table></div>"
        : "Belum ada trade yang selesai.";
    }).catch(function () { setMsg("Dashboard tidak bisa dihubungi. Apakah scripts/sniper-ui.ts masih jalan?", true); });
  }

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var body = {};
    Array.prototype.forEach.call(form.elements, function (el) { if (el.name) body[el.name] = el.value; });
    post("/api/config", body).then(function () { form.elements.privateKey.value = ""; setMsg("Pengaturan tersimpan."); refresh(); })
      .catch(function (err) { setMsg(err.message, true); });
  });
  $("btnDry").onclick = function () { post("/api/start", { execute: false }).then(function () { setMsg("Dry run dimulai."); refresh(); }).catch(function (e) { setMsg(e.message, true); }); };
  $("btnLive").onclick = function () {
    if (!confirm("Mode LIVE akan membeli dan menjual token dengan ETH sungguhan dari wallet sniper. Lanjut?")) return;
    post("/api/start", { execute: true }).then(function () { setMsg("Bot LIVE dimulai."); refresh(); }).catch(function (e) { setMsg(e.message, true); });
  };
  $("btnStop").onclick = function () { post("/api/stop").then(function () { setMsg("Bot dihentikan."); refresh(); }).catch(function (e) { setMsg(e.message, true); }); };

  $("positions").addEventListener("click", function (e) {
    var token = e.target && e.target.getAttribute && e.target.getAttribute("data-sell");
    if (!token) return;
    if (!confirm("Jual SEMUA $" + e.target.getAttribute("data-symbol") + " sekarang di harga pasar?")) return;
    setMsg("Menjual, tunggu konfirmasi transaksi...");
    post("/api/sell", { token: token }).then(function (r) { setMsg("Terjual, diterima sekitar " + Number(r.received).toFixed(6) + " ETH."); refresh(); })
      .catch(function (err) { setMsg(err.message, true); });
  });

  refresh();
  setInterval(refresh, 1500);
</script>
</body>
</html>`;
