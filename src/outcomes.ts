import { z } from "zod";
import type { Venue } from "./config.ts";
import { appendLog, readLogBackwards } from "./log.ts";
import { fetchPool, type Pool } from "./sources/meteora.ts";

/**
 * When to check back on a Jev entry call. The entry question asks about 4 hours; 1h and 24h show
 * whether the call held up sooner and later. Each is also a window Meteora reports fees for.
 */
export const HORIZONS = ["1h", "4h", "24h"] as const;
export type Horizon = (typeof HORIZONS)[number];
const HOURS: Record<Horizon, number> = { "1h": 1, "4h": 4, "24h": 24 };
const HOUR_MS = 3_600_000;

// A check runs at the first scan after it's due. Meteora's fee windows roll, so a check made much
// later measures the wrong stretch of time; past this share of the horizon it's dropped instead.
const MAX_LATE = 0.1;

/** The part of a decisions.jsonl record an outcome needs. Records from before prompt v2 have no price and are skipped. */
const Decision = z.object({
  at: z.number(),
  pool: z.string(),
  venue: z.enum(["dlmm", "dammv2"]),
  prompt: z.number(),
  price: z.number().nullable(),
  tvl: z.number(),
  jev: z.object({ entry: z.string(), confidence: z.number(), rug: z.number() }),
  rules: z.object({ entry: z.string() }),
});
export type Decision = z.infer<typeof Decision>;

/** One line of outcomes.jsonl, as far as restoring and `npm run evaluate` read it. */
export const Outcome = z.object({
  at: z.number(),
  pool: z.string(),
  decidedAt: z.number(),
  horizon: z.enum(HORIZONS),
  prompt: z.number(),
  jev: z.object({ entry: z.string(), confidence: z.number(), rug: z.number() }),
  rules: z.string(),
  lpReturnPct: z.number(),
});
export type Outcome = z.infer<typeof Outcome>;

const OutcomeKey = Outcome.pick({ at: true, pool: true, decidedAt: true, horizon: true });
const Timestamped = z.object({ at: z.number() });

interface Check {
  pool: string;
  venue: Venue;
  decidedAt: number;
  horizon: Horizon;
  dueAt: number;
  prompt: number;
  jev: Decision["jev"];
  rules: string;
  price0: number;
  tvl0: number;
}

export const outcomeKey = (pool: string, decidedAt: number, horizon: string) => `${pool}:${decidedAt}:${horizon}`;
const round = (v: number) => Math.round(v * 1e4) / 1e4;

/**
 * Checks back on every Jev entry call and logs what an LP who entered then would have made,
 * so `npm run evaluate` can tell whether Jev's answers, and the rules', were any good.
 */
export class Outcomes {
  /** Outcomes written since the scout started. */
  logged = 0;
  #pending: Check[] = [];

  constructor(now: number) {
    this.#restore(now);
  }

  get pending(): number {
    return this.#pending.length;
  }

  track(d: Decision, done?: Set<string>): void {
    if (d.price == null || d.price <= 0) return;
    const jev = { entry: d.jev.entry, confidence: d.jev.confidence, rug: d.jev.rug };
    for (const horizon of HORIZONS) {
      if (done?.has(outcomeKey(d.pool, d.at, horizon))) continue;
      this.#pending.push({
        pool: d.pool,
        venue: d.venue,
        decidedAt: d.at,
        horizon,
        dueAt: d.at + HOURS[horizon] * HOUR_MS,
        prompt: d.prompt,
        jev,
        rules: d.rules.entry,
        price0: d.price,
        tvl0: d.tvl,
      });
    }
  }

  /**
   * Log every check that's due. `listed` holds the pools this scan already fetched; the rest are
   * looked up one by one. Returns the lookup errors, if any; failed checks are retried next scan.
   */
  async resolve(listed: Map<string, Pool>, now: number): Promise<unknown[]> {
    const finished = new Set<Check>();
    const due = this.#pending.filter((c) => {
      if (c.dueAt > now) return false;
      if (now - c.dueAt <= HOURS[c.horizon] * HOUR_MS * MAX_LATE) return true;
      finished.add(c);
      return false;
    });

    const pools = new Map(listed);
    const lookups = [...new Map(due.filter((c) => !listed.has(c.pool)).map((c) => [c.pool, c.venue]))];
    const results = await Promise.allSettled(lookups.map(([address, venue]) => fetchPool(venue, address)));
    const errors: unknown[] = [];
    results.forEach((r, i) => {
      if (r.status === "rejected") errors.push(r.reason);
      else if (r.value) pools.set(lookups[i]![0], r.value);
    });

    for (const c of due) {
      const pool = pools.get(c.pool);
      if (!pool?.price) continue;
      this.#write(c, pool, pool.price, now);
      finished.add(c);
    }
    // Filtered rather than replaced: `track` may have added checks while the lookups ran.
    if (finished.size > 0) this.#pending = this.#pending.filter((c) => !finished.has(c));
    return errors;
  }

  #write(c: Check, pool: Pool, price: number, now: number): void {
    const ratio = price / c.price0;
    const feesPct = pool.feeTvlPct[c.horizon];
    appendLog("outcomes.jsonl", {
      at: now,
      pool: c.pool,
      venue: c.venue,
      decidedAt: c.decidedAt,
      horizon: c.horizon,
      lateMin: Math.round((now - c.dueAt) / 6_000) / 10,
      prompt: c.prompt,
      jev: c.jev,
      rules: c.rules,
      price0: c.price0,
      price,
      priceChangePct: round((ratio - 1) * 100),
      tvl0: c.tvl0,
      tvl: pool.tvl,
      feesPct: round(feesPct),
      // A 50/50 full-range position's value, in the quote token, moves with the square root of the price ratio.
      lpReturnPct: round((Math.sqrt(ratio) - 1) * 100 + feesPct),
    });
    this.logged++;
  }

  /** After a restart, pick the checks still to come back up from the logs: recent decisions minus outcomes already written. */
  #restore(now: number): void {
    const oldest = now - HOURS["24h"] * HOUR_MS * (1 + MAX_LATE);

    const done = new Set<string>();
    for (const raw of readLogBackwards("outcomes.jsonl")) {
      const o = OutcomeKey.safeParse(raw);
      if (!o.success) continue;
      if (o.data.at < oldest) break;
      done.add(outcomeKey(o.data.pool, o.data.decidedAt, o.data.horizon));
    }

    for (const raw of readLogBackwards("decisions.jsonl")) {
      const at = Timestamped.safeParse(raw).data?.at;
      if (at !== undefined && at < oldest) break;
      const d = Decision.safeParse(raw);
      if (d.success) this.track(d.data, done);
    }
  }
}
