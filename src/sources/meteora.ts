import { z } from "zod";
import type { Config, Quote, Venue } from "../config.ts";

// Quote tokens are identified by mint, never by symbol: anyone can name a token "USDC".
export const QUOTE_MINTS: Record<string, Quote> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
};

export const API: Record<Venue, string> = {
  dlmm: "https://dlmm.datapi.meteora.ag",
  dammv2: "https://damm-v2.datapi.meteora.ag",
};

export const APP_URL: Record<Venue, string> = {
  dlmm: "https://app.meteora.ag/dlmm/",
  dammv2: "https://app.meteora.ag/dammv2/",
};

const num = z.number().catch(0);
const Windows = z.object({ "30m": num, "1h": num, "4h": num, "24h": num });

const Token = z.object({
  address: z.string(),
  symbol: z.string().catch("?"),
  holders: z.number().nullish(),
  freeze_authority_disabled: z.boolean().nullish(),
  market_cap: z.number().nullish(),
});

const ApiPool = z.object({
  address: z.string(),
  token_x: Token,
  token_y: Token,
  created_at: z.number(),
  tvl: num,
  current_price: num,
  volume: Windows,
  fees: Windows,
  fee_tvl_ratio: Windows,
  is_blacklisted: z.boolean().catch(false),
  pool_config: z.object({
    base_fee_pct: num,
    bin_step: z.number().optional(),
    is_fee_scheduler_active: z.boolean().optional(),
  }),
  dynamic_fee_pct: z.number().optional(),
  permanent_lock_liquidity: z.number().optional(),
});

const ApiPage = z.object({ data: z.array(z.unknown()) });

export type Windows = z.infer<typeof Windows>;

export interface Pool {
  venue: Venue;
  address: string;
  url: string;
  base: { mint: string; symbol: string; holders: number | null; freezeAuthorityDisabled: boolean | null; marketCap: number | null };
  quote: Quote;
  /** Price of the base token in the quote token; null if the API has none. */
  price: number | null;
  tvl: number;
  createdAt: number;
  volume: Windows;
  fees: Windows;
  /** Fees earned as a percentage of TVL, per window. */
  feeTvlPct: Windows;
  baseFeePct: number;
  /** DLMM only: the extra fee charged on top of the base fee while the price is volatile. */
  dynamicFeePct: number | null;
  binStep: number | null;
  feeSchedulerActive: boolean | null;
  permanentLockUsd: number | null;
  blacklisted: boolean;
}

function normalize(venue: Venue, p: z.infer<typeof ApiPool>): Pool | null {
  const xQuote = QUOTE_MINTS[p.token_x.address];
  const yQuote = QUOTE_MINTS[p.token_y.address];
  // SOL-USDC style pairs: treat the x token as the base.
  const [base, quote] = yQuote ? [p.token_x, yQuote] : xQuote ? [p.token_y, xQuote] : [null, null];
  if (!base || !quote) return null;

  return {
    venue,
    address: p.address,
    url: APP_URL[venue] + p.address,
    base: {
      mint: base.address,
      symbol: base.symbol,
      holders: base.holders ?? null,
      freezeAuthorityDisabled: base.freeze_authority_disabled ?? null,
      marketCap: base.market_cap ?? null,
    },
    quote,
    // The API prices token x in token y.
    price: p.current_price > 0 ? (base === p.token_x ? p.current_price : 1 / p.current_price) : null,
    tvl: p.tvl,
    createdAt: p.created_at,
    volume: p.volume,
    fees: p.fees,
    feeTvlPct: p.fee_tvl_ratio,
    baseFeePct: p.pool_config.base_fee_pct,
    dynamicFeePct: p.dynamic_fee_pct ?? null,
    binStep: p.pool_config.bin_step ?? null,
    feeSchedulerActive: p.pool_config.is_fee_scheduler_active ?? null,
    permanentLockUsd: p.permanent_lock_liquidity ?? null,
    blacklisted: p.is_blacklisted,
  };
}

/** One pool by address; null if it isn't paired with SOL or USDC. */
export async function fetchPool(venue: Venue, address: string): Promise<Pool | null> {
  const res = await fetch(`${API[venue]}/pools/${address}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return normalize(venue, ApiPool.parse(await res.json()));
}

/** Top pools on one venue by fee/TVL over `RANK_WINDOW`, pre-filtered by TVL and volume on the server. */
export async function fetchPools(venue: Venue, cfg: Config, pageSize = 50): Promise<Pool[]> {
  const params = new URLSearchParams({
    page_size: String(pageSize),
    sort_by: `fee_tvl_ratio_${cfg.RANK_WINDOW}:desc`,
    filter_by: `tvl>=${cfg.MIN_TVL_USD} && volume_1h>=${cfg.MIN_VOLUME_1H_USD}`,
  });
  const res = await fetch(`${API[venue]}/pools?${params}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const page = ApiPage.parse(await res.json());
  const pools: Pool[] = [];
  for (const raw of page.data) {
    const parsed = ApiPool.safeParse(raw);
    if (!parsed.success) continue;
    const pool = normalize(venue, parsed.data);
    if (pool) pools.push(pool);
  }
  return pools;
}
