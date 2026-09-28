import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { Config } from "./config.ts";
import { Discord } from "./discord.ts";
import { pct, regime, safeSymbol, usd } from "./format.ts";
import { Jev, type JevVerdict, type PositionVerdict } from "./jev.ts";
import { ruleVerdict, type RuleVerdict } from "./rules.ts";
import { jevState, metrics, positionState, screenPool, screenToken, type Metrics } from "./screen.ts";
import { fetchTokenStats, type TokenStats } from "./sources/jupiter.ts";
import { fetchPool, fetchPools, type Pool } from "./sources/meteora.ts";
import { fetchPortfolio, type Portfolio, type Position } from "./sources/positions.ts";

/** "opportunity": Jev leans toward entering but isn't sure yet. "entry": it's sure, and rug risk is low. */
export type Signal = "none" | "opportunity" | "entry";
const RANK: Record<Signal, number> = { none: 0, opportunity: 1, entry: 2 };

export interface Watch {
  pool: Pool;
  pair: string;
  metrics: Metrics;
  rules: RuleVerdict;
  jev: JevVerdict | null;
  signal: Signal;
}

/** "none" means no Jev answer yet (or Jev is off). */
export type PositionSignal = "none" | "hold" | "rebalance" | "exit";

export interface PositionView {
  pos: Position;
  jev: PositionVerdict | null;
  signal: PositionSignal;
}

export interface Alert {
  at: number;
  kind: "opportunity" | "entry" | "out_of_range" | "rebalance" | "exit";
  pair: string;
  url: string;
  detail: string;
}

export interface ScanSummary {
  at: number;
  scanned: number;
  passed: number;
  rejects: [reason: string, count: number][];
  errors: string[];
}

const LOG_DIR = "logs";

// What `#fire` writes to alerts.jsonl, as far as restoring after a restart needs it.
const AlertRecord = z.object({
  at: z.number(),
  kind: z.enum(["opportunity", "entry", "out_of_range", "rebalance", "exit"]),
  pair: z.string(),
  url: z.string(),
  detail: z.string(),
  pool: z.string().optional(),
  position: z.string().optional(),
});

export class Scout {
  readonly cfg: Config;
  readonly jev: Jev;
  readonly discord: Discord | null;
  watching: Watch[] = [];
  positions: PositionView[] = [];
  portfolio: Omit<Portfolio, "positions"> | null = null;
  alerts: Alert[] = [];
  lastScan: ScanSummary | null = null;
  scanning = false;
  /** Set when a scan fails outright (a bug, not a flaky API). */
  crash: string | null = null;
  #lastFired = new Map<string, number>();

  constructor(cfg: Config) {
    this.cfg = cfg;
    this.jev = new Jev(cfg);
    this.discord = cfg.DISCORD_WEBHOOK_URL ? new Discord(cfg.DISCORD_WEBHOOK_URL) : null;
    this.#restore();
  }

  /**
   * Reload recent alerts from the log, so after a restart the alert list is still there and
   * alerts that are still in their cooldown aren't sent to Discord again.
   */
  #restore(): void {
    let text: string;
    try {
      text = readFileSync(`${LOG_DIR}/alerts.jsonl`, "utf8");
    } catch {
      return;
    }
    for (const line of text.trim().split("\n").slice(-100)) {
      let parsed;
      try {
        parsed = AlertRecord.safeParse(JSON.parse(line));
      } catch {
        continue;
      }
      if (!parsed.success) continue;
      const { pool, position, ...alert } = parsed.data;
      const subject = position ?? pool;
      if (subject) this.#lastFired.set(`${alert.kind}:${subject}`, alert.at);
      this.alerts.unshift(alert);
    }
  }

  async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.#scan();
      this.crash = null;
    } catch (err) {
      this.crash = errorText(err);
    } finally {
      this.scanning = false;
    }
  }

  async #scan(): Promise<void> {
    const { cfg } = this;
    const now = Date.now();
    const errors: string[] = [];
    const rejects = new Map<string, number>();
    const reject = (reason: string) => rejects.set(reason, (rejects.get(reason) ?? 0) + 1);

    // 1. Pools from each venue, and your open positions, in parallel.
    const [results, portfolio] = await Promise.all([
      Promise.allSettled(cfg.VENUES.map((v) => fetchPools(v, cfg))),
      cfg.WALLET
        ? fetchPortfolio(cfg.WALLET).catch((err) => {
            errors.push(`Meteora positions: ${errorText(err)}`);
            return null;
          })
        : null,
    ]);
    const pools: Pool[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") pools.push(...r.value);
      else errors.push(`Meteora ${cfg.VENUES[i]}: ${errorText(r.reason)}`);
    });
    const positionPools = portfolio ? await this.#positionPools(portfolio, errors) : new Map<string, Pool>();

    // 2. Pool-level filters, then token data for whatever is left plus the pools you're in.
    const poolPassed = pools.filter((p) => {
      const reason = screenPool(p, cfg, now);
      if (reason) reject(reason);
      return !reason;
    });

    let tokenStats = new Map<string, TokenStats>();
    const mints = [...poolPassed, ...positionPools.values()].map((p) => p.base.mint);
    if (mints.length > 0) {
      try {
        tokenStats = await fetchTokenStats(mints);
      } catch (err) {
        errors.push(`Jupiter: ${errorText(err)}`);
      }
    }

    const candidates = poolPassed
      .filter((p) => {
        const reason = screenToken(p, tokenStats.get(p.base.mint), cfg);
        if (reason) reject(reason);
        return !reason;
      })
      .sort((a, b) => b.feeTvlPct["1h"] - a.feeTvlPct["1h"])
      .slice(0, cfg.MAX_WATCHING);

    // 3. Jev on candidates and positions, then alerts.
    await Promise.all([
      this.#watch(candidates, tokenStats, now),
      portfolio ? this.#track(portfolio, positionPools, tokenStats, now) : null,
    ]);

    this.lastScan = {
      at: now,
      scanned: pools.length,
      passed: candidates.length,
      rejects: [...rejects].sort((a, b) => b[1] - a[1]),
      errors: this.jev.lastError ? [...errors, `Jev: ${this.jev.lastError}`] : errors,
    };
  }

  async #watch(candidates: Pool[], tokenStats: Map<string, TokenStats>, now: number): Promise<void> {
    const previous = new Map(this.watching.map((w) => [w.pool.address, w]));
    const next = await Promise.all(
      candidates.map(async (pool): Promise<Watch> => {
        const stats = tokenStats.get(pool.base.mint);
        const m = metrics(pool, stats);
        const rules = ruleVerdict(m);

        // Re-ask Jev only when its last answer about this pool has gone stale.
        let jev = previous.get(pool.address)?.jev ?? null;
        if (this.jev.client && this.#stale(jev, now)) {
          const state = jevState(pool, stats, m, now);
          const fresh = await this.jev.ask(pool.venue, state);
          if (fresh) {
            jev = fresh;
            this.#log("decisions.jsonl", { at: fresh.at, pool: pool.address, venue: pool.venue, state, jev: fresh, rules });
          }
        }

        return { pool, pair: `${safeSymbol(pool.base.symbol)}/${pool.quote}`, metrics: m, rules, jev, signal: this.#signal(jev, rules) };
      }),
    );

    // Alert only when a pool's signal goes up: none → opportunity → entry.
    for (const w of next) {
      const before = previous.get(w.pool.address)?.signal ?? "none";
      if (w.signal !== "none" && RANK[w.signal] > RANK[before]) this.#entryAlert(w.signal, w, now);
    }
    this.watching = next;
  }

  /** Market data for each pool you hold a position in, so Jev can judge it even if it fails the entry filters. */
  async #positionPools(portfolio: Portfolio, errors: string[]): Promise<Map<string, Pool>> {
    const addresses = [...new Set(portfolio.positions.map((p) => p.pool))];
    const results = await Promise.allSettled(addresses.map((a) => fetchPool("dlmm", a)));
    const out = new Map<string, Pool>();
    results.forEach((r, i) => {
      if (r.status === "fulfilled" && r.value) out.set(addresses[i]!, r.value);
      else if (r.status === "rejected") errors.push(`Meteora pool ${addresses[i]!.slice(0, 4)}…: ${errorText(r.reason)}`);
    });
    return out;
  }

  async #track(portfolio: Portfolio, pools: Map<string, Pool>, tokenStats: Map<string, TokenStats>, now: number): Promise<void> {
    const previous = new Map(this.positions.map((v) => [v.pos.address, v]));
    const next = await Promise.all(
      portfolio.positions.map(async (pos): Promise<PositionView> => {
        const pool = pools.get(pos.pool);
        let jev = previous.get(pos.address)?.jev ?? null;
        if (this.jev.client && pool && this.#stale(jev, now)) {
          const state = positionState(pos, pool, tokenStats.get(pool.base.mint), now);
          const fresh = await this.jev.askPosition(state);
          if (fresh) {
            jev = fresh;
            this.#log("positions.jsonl", { at: fresh.at, position: pos.address, pool: pos.pool, state, jev: fresh });
          }
        }
        return { pos, jev, signal: this.#positionSignal(jev, pos) };
      }),
    );

    for (const v of next) {
      const prev = previous.get(v.pos.address);
      if (v.pos.side !== "inside" && prev?.pos.side !== v.pos.side) this.#positionAlert("out_of_range", v, now);
      if ((v.signal === "exit" || v.signal === "rebalance") && prev?.signal !== v.signal) this.#positionAlert(v.signal, v, now);
    }

    const { positions: _, ...totals } = portfolio;
    this.positions = next;
    this.portfolio = totals;
  }

  #stale(verdict: { at: number } | null, now: number): boolean {
    return !verdict || now - verdict.at >= this.cfg.JEV_INTERVAL_SEC * 1000;
  }

  /** Jev decides when it's on; the rules only decide when there's no API key. */
  #signal(jev: JevVerdict | null, rules: RuleVerdict): Signal {
    if (!this.jev.client) return rules.entry === "enter" ? "entry" : "none";
    if (!jev || jev.entry !== "enter_now" || jev.rug > this.cfg.MAX_RUG) return "none";
    return jev.confidence >= this.cfg.MIN_CONFIDENCE ? "entry" : "opportunity";
  }

  /**
   * A high rug score alone means exit. Otherwise Jev has to be confident before it moves you off "hold",
   * and a rebalance only counts once the price has actually left the range.
   */
  #positionSignal(jev: PositionVerdict | null, pos: Position): PositionSignal {
    if (!jev) return "none";
    if (jev.rug > this.cfg.MAX_RUG) return "exit";
    if (jev.confidence < this.cfg.MIN_CONFIDENCE) return "hold";
    if (jev.action === "exit") return "exit";
    if (jev.action === "rebalance" && pos.side !== "inside") return "rebalance";
    return "hold";
  }

  #entryAlert(kind: Exclude<Signal, "none">, w: Watch, now: number): void {
    const venue = w.pool.venue === "dlmm" ? `DLMM bin ${w.pool.binStep}` : "DAMM v2";
    const fees = `fees ${pct(w.metrics.feeTvl1hPct, 2)}/h · TVL ${usd(w.pool.tvl)}`;
    let detail: string;
    if (w.jev) {
      const shape = w.jev.shape ? ` · ${w.jev.shape.replace("_", "-")}` : "";
      detail = `${venue}${shape} · ${regime(w.jev.regime)} · conf ${w.jev.confidence.toFixed(2)} · rug ${w.jev.rug.toFixed(2)} · ${fees}`;
    } else {
      detail = `${venue} · ${fees} · rules: ${w.rules.reason}`;
    }
    this.#fire({ at: now, kind, pair: w.pair, url: w.pool.url, detail }, w.pool.address, {
      pool: w.pool.address,
      venue: w.pool.venue,
      metrics: w.metrics,
      jev: w.jev,
      rules: w.rules,
    });
  }

  #positionAlert(kind: "out_of_range" | "rebalance" | "exit", v: PositionView, now: number): void {
    const { pos, jev } = v;
    let detail: string;
    if (kind === "out_of_range") {
      detail =
        pos.side === "below"
          ? `price ${pct((1 - pos.price / pos.minPrice) * 100)} below your range · position is now all ${pos.tokenX}`
          : `price ${pct((pos.price / pos.maxPrice - 1) * 100)} above your range · all ${pos.tokenY}, earning no fees`;
    } else {
      const why = jev && jev.rug > this.cfg.MAX_RUG ? `rug ${jev.rug.toFixed(2)} over limit` : `Jev: ${jev?.action}`;
      detail = `${why} · ${jev ? regime(jev.regime) : "?"} · conf ${jev?.confidence.toFixed(2)} · PnL ${pct(pos.pnlSolPct ?? pos.pnlPct, 1, true)}`;
    }
    this.#fire({ at: now, kind, pair: pos.pair, url: pos.url, detail }, pos.address, { position: pos.address, pool: pos.pool, side: pos.side, jev });
  }

  #fire(alert: Alert, subject: string, extra: object): void {
    const key = `${alert.kind}:${subject}`;
    const last = this.#lastFired.get(key);
    if (last && alert.at - last < this.cfg.ALERT_COOLDOWN_MIN * 60_000) return;
    this.#lastFired.set(key, alert.at);

    this.alerts.unshift(alert);
    this.alerts.length = Math.min(this.alerts.length, 100);
    this.#log("alerts.jsonl", { ...alert, ...extra });
    if (this.discord && this.cfg.DISCORD_ALERTS.includes(alert.kind)) this.discord.send(alert);
    if (alert.kind === "entry" || alert.kind === "exit") process.stdout.write("\x07");
  }

  // Synchronous so nothing is lost when `--once` exits right after a scan.
  #log(file: string, record: object): void {
    try {
      mkdirSync(LOG_DIR, { recursive: true });
      appendFileSync(`${LOG_DIR}/${file}`, JSON.stringify(record) + "\n");
    } catch {
      // Logging must never take the dashboard down.
    }
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "request timed out" : err.message;
  return String(err);
}
