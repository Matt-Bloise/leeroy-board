// Throwaway Durable Object for the gateway spike. One named instance holds an outbound Discord gateway WebSocket.
// SPIKE ONLY: not imported by the production worker. Secret: env.DISCORD_BOT_TOKEN (a DISPOSABLE test bot token, set on the throwaway worker only).
import { GatewayMachine, awakeSeconds, gbSeconds, foldPreviousInstance, redactedStatus, PREDICTED_GBS_PER_HOUR } from "./state.js";

const ALARM_EVERY_MS = 30000;
const API = "https://discord.com/api/v10";

export class GatewayDO {
  constructor(ctx, env) {
    this.ctx = ctx; this.env = env;
    this.bootAt = Date.now();
    this.bootHistory = [];
    this.alarmsEnabled = true;
    this.accumS = 0;
    this.ready = ctx.blockConcurrencyWhile(() => this.init());
  }

  async init() {
    const kv = this.ctx.storage;
    const prev = await kv.get("instance");
    this.accumS = (await kv.get("accumS")) || 0;
    this.bootHistory = (await kv.get("bootHistory")) || [];
    const flag = await kv.get("alarmsEnabled");
    this.alarmsEnabled = flag === undefined ? true : !!flag;
    const folded = foldPreviousInstance(this.accumS, prev, this.bootAt);
    this.accumS = folded.accumS;
    const savedCounters = await kv.get("counters");
    this.mem = { state: (await kv.get("gw")) || null };
    this.machine = new GatewayMachine({
      token: this.env.DISCORD_BOT_TOKEN,
      store: { get: () => this.mem.state, set: (s) => { this.mem.state = JSON.parse(JSON.stringify(s)); this.ctx.waitUntil(kv.put("gw", this.mem.state)); } },
      now: () => Date.now(), rand: () => Math.random(),
      setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (h) => clearTimeout(h),
      connect: (url, h) => this.connectSocket(url, h),
      fetchGatewayInfo: () => this.fetchGatewayInfo(),
      log: (m) => console.log("[spike] " + m),
    });
    if (savedCounters) Object.assign(this.machine.counters, savedCounters);
    this.machine.counters.coldStarts = (savedCounters ? savedCounters.coldStarts || 0 : 0) + 1;
    if (prev) this.bootHistory.push({ bootAt: new Date(this.bootAt).toISOString(), previousInstanceRanS: folded.evictedAfterS, gapBeforeBootS: folded.gapS });
    else this.bootHistory.push({ bootAt: new Date(this.bootAt).toISOString(), first: true });
    this.bootHistory = this.bootHistory.slice(-20);
    await kv.put({ accumS: this.accumS, bootHistory: this.bootHistory, instance: { bootAt: this.bootAt, lastSeen: this.bootAt } });
    this.machine.load();
  }

  async fetchGatewayInfo() {
    const r = await fetch(API + "/gateway/bot", { headers: { Authorization: "Bot " + this.env.DISCORD_BOT_TOKEN } });
    if (!r.ok) throw new Error("GET /gateway/bot HTTP " + r.status);
    return r.json();
  }

  // Outbound WebSocket: fetch() with an Upgrade header on an https URL, then accept() (Cloudflare Workers WebSockets page).
  connectSocket(wssUrl, h) {
    const httpsUrl = wssUrl.replace(/^wss:/, "https:");
    const handle = { ws: null, send: (t) => handle.ws && handle.ws.send(t), close: (c, r) => handle.ws ? handle.ws.close(c, r) : h.onClose(c) };
    this.ctx.waitUntil((async () => {
      try {
        const resp = await fetch(httpsUrl, { headers: { Upgrade: "websocket" } });
        const ws = resp.webSocket;
        if (!ws) { h.onError("no webSocket on upgrade response: HTTP " + resp.status + " " + (await resp.text()).slice(0, 200)); h.onClose(1006); return; }
        ws.accept();
        handle.ws = ws;
        ws.addEventListener("message", (e) => h.onMessage(typeof e.data === "string" ? e.data : ""));
        ws.addEventListener("close", (e) => h.onClose(e.code));
        ws.addEventListener("error", (e) => h.onError("socket error: " + (e && e.message ? e.message : "unknown")));
        h.onOpen();
      } catch (e) { h.onError("outbound WebSocket failed: " + (e && e.message ? e.message : e)); h.onClose(1006); }
    })());
    return handle;
  }

  async touch() {
    const kv = this.ctx.storage;
    await kv.put({ instance: { bootAt: this.bootAt, lastSeen: Date.now() }, counters: this.machine.counters });
  }

  awake() { return awakeSeconds(this.accumS, { bootAt: this.bootAt }, Date.now()); }

  async fetch(request) {
    await this.ready;
    const url = new URL(request.url);
    const json = (o, s = 200) => new Response(JSON.stringify(o, null, 2), { status: s, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    if (url.pathname === "/spike/start" && request.method === "POST") {
      await this.arm();
      await this.machine.start();
      return json({ started: true });
    }
    if (url.pathname === "/spike/force-close" && request.method === "POST") {
      const before = JSON.parse(JSON.stringify(this.machine.counters));
      const ok = this.machine.forceClose(4000);
      return json({ closed: ok, code: 4000, identifiesBefore: before.identifies, resumesBefore: before.resumes, hint: "GET /spike/status in ~10 s: resumes +1, resumed +1, identifies unchanged" });
    }
    if (url.pathname === "/spike/alarms" && request.method === "POST") {
      const on = url.searchParams.get("on") !== "0";
      this.alarmsEnabled = on;
      await this.ctx.storage.put("alarmsEnabled", on);
      if (on) await this.arm(); else await this.ctx.storage.deleteAlarm();
      return json({ alarmsEnabled: on });
    }
    if (url.pathname === "/spike/status") {
      await this.touch();
      return json(redactedStatus(this.machine.snapshot({ alarmsEnabled: this.alarmsEnabled, awakeSeconds: this.awake(), bootHistory: this.bootHistory })));
    }
    if (url.pathname === "/spike/duration") {
      const s = this.awake();
      return json({ awakeSeconds: s, gbSeconds: gbSeconds(s), predictedGbSecondsPerHour: PREDICTED_GBS_PER_HOUR, note: "awake seconds x 0.125 GB; compare with the dashboard DO duration metric over the same window" });
    }
    return json({ routes: ["POST /spike/start", "GET /spike/status", "POST /spike/force-close", "GET /spike/duration", "POST /spike/alarms?on=0|1"] }, 404);
  }

  async arm() { if (this.alarmsEnabled) await this.ctx.storage.setAlarm(Date.now() + ALARM_EVERY_MS); }

  async alarm() {
    await this.ready;
    try {
      await this.touch();
      this.machine.watchdog();
    } catch (e) { console.log("[spike] alarm error " + (e && e.message ? e.message : e)); }
    finally { await this.arm(); } // always re-arm (alarm docs: catch and reschedule so retries are not exhausted)
  }
}
