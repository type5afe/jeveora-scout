import { z } from "zod";
import type { Quote } from "../config.ts";
import { safeSymbol } from "../format.ts";
import { API, APP_URL, QUOTE_MINTS } from "./meteora.ts";

// Meteora's portfolio API covers DLMM only. It returns most numbers as strings.
const num = z.coerce.number().catch(0);
const numOrNull = z.coerce.number().nullish().catch(null);
const Amount = z.object({ usd: num, amountSol: numOrNull });

const PortfolioPool = z.object({
  poolAddress: z.string(),
  binStep: z.number(),
  tokenX: z.string().catch("?"),
  tokenY: z.string().catch("?"),
  tokenXMint: z.string(),
  tokenYMint: z.string(),
});

const Portfolio = z.object({
  pools: z.array(PortfolioPool),
  total: z
    .object({ balances: num, balancesSol: numOrNull, unclaimedFees: num, unclaimedFeesSol: numOrNull, pnl: num, pnlPctChange: num, pnlSol: numOrNull, pnlSolPctChange: numOrNull })
    .nullish(),
});

const ApiPosition = z.object({
  positionAddress: z.string(),
  minPrice: num,
  maxPrice: num,
  lowerBinId: z.number(),
  upperBinId: z.number(),
  poolActiveBinId: z.number(),
  poolActivePrice: num,
  isOutOfRange: z.boolean().nullish(),
  createdAt: z.number(),
  pnlUsd: num,
  pnlPctChange: num,
  pnlSol: numOrNull,
  pnlSolPctChange: numOrNull,
  unrealizedPnl: z.object({
    balances: num,
    balancesSol: numOrNull,
    unclaimedFeeTokenX: Amount,
    unclaimedFeeTokenY: Amount,
  }),
});

const PositionPage = z.object({ positions: z.array(z.unknown()) });

export interface Position {
  address: string;
  pool: string;
  url: string;
  pair: string;
  tokenX: string;
  tokenY: string;
  /** SOL or USDC side of the pair, if there is one. */
  quote: Quote | null;
  binStep: number;
  minPrice: number;
  maxPrice: number;
  price: number;
  lowerBin: number;
  upperBin: number;
  activeBin: number;
  /** Where the price sits in the range: "below", "inside" or "above". */
  side: "below" | "inside" | "above";
  valueUsd: number;
  valueSol: number | null;
  feesUsd: number;
  feesSol: number | null;
  pnlUsd: number;
  pnlPct: number;
  pnlSol: number | null;
  pnlSolPct: number | null;
  createdAt: number;
}

export interface Portfolio {
  positions: Position[];
  valueUsd: number;
  valueSol: number | null;
  feesUsd: number;
  pnlUsd: number;
  pnlPct: number;
  pnlSolPct: number | null;
}

const sumOrNull = (a: number | null | undefined, b: number | null | undefined) => (a == null || b == null ? null : a + b);

async function get(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Every open DLMM position the wallet holds, with range, value, fees and PnL. */
export async function fetchPortfolio(wallet: string): Promise<Portfolio> {
  const base = API.dlmm;
  const portfolio = Portfolio.parse(await get(`${base}/portfolio/open?user=${wallet}&page_size=50`));

  const perPool = await Promise.all(
    portfolio.pools.map(async (pool): Promise<Position[]> => {
      const page = PositionPage.parse(await get(`${base}/positions/${pool.poolAddress}/pnl?user=${wallet}&status=open&page_size=100`));
      const tokenX = safeSymbol(pool.tokenX);
      const tokenY = safeSymbol(pool.tokenY);
      const xQuote = QUOTE_MINTS[pool.tokenXMint];
      const yQuote = QUOTE_MINTS[pool.tokenYMint];

      return page.positions.flatMap((raw) => {
        const parsed = ApiPosition.safeParse(raw);
        if (!parsed.success) return [];
        const p = parsed.data;
        const u = p.unrealizedPnl;
        const side = p.poolActiveBinId < p.lowerBinId ? "below" : p.poolActiveBinId > p.upperBinId ? "above" : "inside";
        return [
          {
            address: p.positionAddress,
            pool: pool.poolAddress,
            url: APP_URL.dlmm + pool.poolAddress,
            pair: !yQuote && xQuote ? `${tokenY}/${tokenX}` : `${tokenX}/${tokenY}`,
            tokenX,
            tokenY,
            quote: yQuote ?? xQuote ?? null,
            binStep: pool.binStep,
            minPrice: p.minPrice,
            maxPrice: p.maxPrice,
            price: p.poolActivePrice,
            lowerBin: p.lowerBinId,
            upperBin: p.upperBinId,
            activeBin: p.poolActiveBinId,
            side,
            valueUsd: u.balances,
            valueSol: u.balancesSol ?? null,
            feesUsd: u.unclaimedFeeTokenX.usd + u.unclaimedFeeTokenY.usd,
            feesSol: sumOrNull(u.unclaimedFeeTokenX.amountSol, u.unclaimedFeeTokenY.amountSol),
            pnlUsd: p.pnlUsd,
            pnlPct: p.pnlPctChange,
            pnlSol: p.pnlSol ?? null,
            pnlSolPct: p.pnlSolPctChange ?? null,
            createdAt: p.createdAt * 1000,
          },
        ];
      });
    }),
  );

  const t = portfolio.total;
  const positions = perPool.flat();
  return {
    positions,
    valueUsd: t?.balances ?? positions.reduce((s, p) => s + p.valueUsd, 0),
    valueSol: t?.balancesSol ?? null,
    feesUsd: t?.unclaimedFees ?? positions.reduce((s, p) => s + p.feesUsd, 0),
    pnlUsd: t?.pnl ?? 0,
    pnlPct: t?.pnlPctChange ?? 0,
    pnlSolPct: t?.pnlSolPctChange ?? null,
  };
}
