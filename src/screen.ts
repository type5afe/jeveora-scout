import type { Config } from "./config.ts";
import { age, pct, usd } from "./format.ts";
import type { TokenStats } from "./sources/jupiter.ts";
import type { Pool } from "./sources/meteora.ts";
import type { Position } from "./sources/positions.ts";

// Hard filters. These run in plain code before Jev sees a pool, and Jev cannot override them.
// Each returns the reason a pool failed, or null if it passed.

export function screenPool(pool: Pool, cfg: Config, now: number): string | null {
  if (pool.blacklisted) return "blacklisted";
  if (!cfg.QUOTES.includes(pool.quote)) return "quote token";
  if (pool.tvl < cfg.MIN_TVL_USD) return "low TVL";
  if (pool.volume["1h"] < cfg.MIN_VOLUME_1H_USD) return "low volume";
  if (pool.feeTvlPct["1h"] < cfg.MIN_FEE_TVL_1H_PCT) return "low fees";
  if (now - pool.createdAt < cfg.MIN_POOL_AGE_MIN * 60_000) return "too new";
  if (pool.base.freezeAuthorityDisabled === false) return "freeze authority";
  return null;
}

/** Missing safety data counts as a fail. */
export function screenToken(pool: Pool, stats: TokenStats | undefined, cfg: Config): string | null {
  if (!stats?.audit) return "no token data";
  if (stats.audit.mintAuthorityDisabled !== true) return "mint authority";
  if (stats.audit.freezeAuthorityDisabled !== true) return "freeze authority";
  if ((stats.holderCount ?? pool.base.holders ?? 0) < cfg.MIN_HOLDERS) return "few holders";
  const top = stats.audit.topHoldersPercentage;
  if (top == null || top > cfg.MAX_TOP_HOLDERS_PCT) return "top holders";
  return null;
}

/** Numbers the dashboard and the rules use. */
export interface Metrics {
  feeTvl1hPct: number;
  volume1h: number;
  /** Last hour's volume divided by the average hourly volume over 24h. */
  volumeTrend: number;
  price5m: number | null;
  price1h: number | null;
  price6h: number | null;
  price24h: number | null;
  /** Share of 1h volume that was buys, 0..1. */
  buyShare1h: number | null;
  liquidityChange1h: number | null;
  organicScore: number | null;
  topHoldersPct: number | null;
}

export function metrics(pool: Pool, stats: TokenStats | undefined): Metrics {
  const hourlyAvg = pool.volume["24h"] / 24;
  const buy = stats?.stats1h?.buyVolume ?? null;
  const sell = stats?.stats1h?.sellVolume ?? null;
  return {
    feeTvl1hPct: pool.feeTvlPct["1h"],
    volume1h: pool.volume["1h"],
    volumeTrend: hourlyAvg > 0 ? pool.volume["1h"] / hourlyAvg : 1,
    price5m: stats?.stats5m?.priceChange ?? null,
    price1h: stats?.stats1h?.priceChange ?? null,
    price6h: stats?.stats6h?.priceChange ?? null,
    price24h: stats?.stats24h?.priceChange ?? null,
    buyShare1h: buy != null && sell != null && buy + sell > 0 ? buy / (buy + sell) : null,
    liquidityChange1h: stats?.stats1h?.liquidityChange ?? null,
    organicScore: stats?.organicScore ?? null,
    topHoldersPct: stats?.audit?.topHoldersPercentage ?? null,
  };
}

// Jev is weak at arithmetic, so every number goes in pre-computed and labeled.
// Token names and symbols are left out on purpose: they're written by the token's creator.

function changeLabel(v: number | null): string {
  if (v == null) return "unknown";
  const a = Math.abs(v);
  const dir = v >= 0 ? "up" : "down";
  const size = a < 2 ? "flat" : a < 10 ? dir : a < 30 ? `sharply ${dir}` : `extremely ${dir}`;
  return `${pct(v, 1, true)} (${size})`;
}

function band(v: number, cuts: [number, string][], last: string): string {
  for (const [limit, label] of cuts) if (v < limit) return label;
  return last;
}

export function jevState(pool: Pool, stats: TokenStats | undefined, m: Metrics, now: number): Record<string, string> {
  const venue =
    pool.venue === "dlmm"
      ? `Meteora DLMM (concentrated liquidity in bins), bin step ${pool.binStep ?? "?"}, base fee ${pct(pool.baseFeePct, 2)}`
      : `Meteora DAMM v2 (constant product), base fee ${pct(pool.baseFeePct, 2)}, ` +
        (pool.feeSchedulerActive ? "fee scheduler active (fees decaying over time)" : "fixed fee");

  const s1h = stats?.stats1h;
  const state: Record<string, string> = {
    pool_type: venue,
    quote_token: pool.quote,
    pool_age: age(now - pool.createdAt),
    tvl: `${usd(pool.tvl)} (${band(pool.tvl, [[25_000, "small"], [250_000, "medium"]], "large")})`,
    fees_vs_tvl_last_hour: `${pct(m.feeTvl1hPct, 2)} of TVL (${band(m.feeTvl1hPct, [[0.2, "low"], [0.5, "moderate"], [1, "high"]], "very high")})`,
    volume_last_hour: `${usd(m.volume1h)}, ${m.volumeTrend.toFixed(1)}x the 24h hourly average (${band(m.volumeTrend, [[0.5, "falling fast"], [0.8, "falling"], [1.25, "steady"], [2, "rising"]], "surging")})`,
    price_change_5m: changeLabel(m.price5m),
    price_change_1h: changeLabel(m.price1h),
    price_change_6h: changeLabel(m.price6h),
    price_change_24h: changeLabel(m.price24h),
  };

  if (m.buyShare1h != null) {
    const label = band(m.buyShare1h, [[0.4, "sellers dominate"], [0.47, "sellers slightly heavier"], [0.53, "balanced"], [0.6, "buyers slightly heavier"]], "buyers dominate");
    state.buy_vs_sell_last_hour = `${Math.round(m.buyShare1h * 100)}% of volume was buys (${label})`;
  }
  if (s1h?.numTraders != null) state.traders_last_hour = `${s1h.numTraders} traders, ${s1h.numOrganicBuyers ?? 0} organic buyers`;
  if (m.liquidityChange1h != null) state.liquidity_change_1h = changeLabel(m.liquidityChange1h);
  if (s1h?.holderChange != null) state.holder_change_1h = pct(s1h.holderChange, 2, true);
  if (m.organicScore != null) state.organic_trading_score = `${Math.round(m.organicScore)}/100 (${stats?.organicScoreLabel ?? "?"})`;
  if (m.topHoldersPct != null) state.top_holders_share = `${pct(m.topHoldersPct)} of supply (${band(m.topHoldersPct, [[15, "low concentration"], [30, "moderate concentration"]], "high concentration")})`;
  if (pool.base.marketCap) state.market_cap = usd(pool.base.marketCap);
  if (pool.permanentLockUsd) state.permanently_locked_liquidity = usd(pool.permanentLockUsd);

  return state;
}

/** The pool's market state plus the facts about one open position in it. */
export function positionState(pos: Position, pool: Pool, stats: TokenStats | undefined, now: number): Record<string, string> {
  const quote = pool.quote;
  const whereInRange =
    pos.side === "below"
      ? `below the range by ${pct((1 - pos.price / pos.minPrice) * 100)}; the position is now entirely the traded token`
      : pos.side === "above"
        ? `above the range by ${pct((pos.price / pos.maxPrice - 1) * 100)}; the position is entirely ${quote} and earns no fees`
        : `inside the range, ${Math.round(((pos.activeBin - pos.lowerBin) / Math.max(1, pos.upperBin - pos.lowerBin)) * 100)}% of the way up from the bottom edge`;
  const pnl = pos.pnlSolPct ?? pos.pnlPct;
  const feeShare = pos.valueUsd > 0 ? (pos.feesUsd / pos.valueUsd) * 100 : 0;

  return {
    ...jevState(pool, stats, metrics(pool, stats), now),
    position_range: `${pct((pos.minPrice / pos.price - 1) * 100, 1, true)} to ${pct((pos.maxPrice / pos.price - 1) * 100, 1, true)} relative to the current price`,
    price_vs_position_range: whereInRange,
    position_age: age(now - pos.createdAt),
    position_pnl: `${pct(pnl, 1, true)}${pos.pnlSolPct != null ? " in SOL terms" : ""}`,
    unclaimed_fees: `${pct(feeShare, 2)} of the position's value`,
  };
}
