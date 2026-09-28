import { z } from "zod";

const n = z.number().nullish();

const Stats = z
  .object({
    priceChange: n,
    holderChange: n,
    liquidityChange: n,
    volumeChange: n,
    buyVolume: n,
    sellVolume: n,
    numBuys: n,
    numSells: n,
    numTraders: n,
    numOrganicBuyers: n,
  })
  .nullish();

const TokenStats = z.object({
  id: z.string(),
  holderCount: n,
  organicScore: n,
  organicScoreLabel: z.string().nullish(),
  audit: z
    .object({
      mintAuthorityDisabled: z.boolean().nullish(),
      freezeAuthorityDisabled: z.boolean().nullish(),
      topHoldersPercentage: n,
    })
    .nullish(),
  stats5m: Stats,
  stats1h: Stats,
  stats6h: Stats,
  stats24h: Stats,
});

export type TokenStats = z.infer<typeof TokenStats>;

const CHUNK = 20;

/** Audit and trading stats per mint. Mints Jupiter doesn't know are simply absent from the map. */
export async function fetchTokenStats(mints: string[]): Promise<Map<string, TokenStats>> {
  const out = new Map<string, TokenStats>();
  const unique = [...new Set(mints)];

  for (let i = 0; i < unique.length; i += CHUNK) {
    const chunk = unique.slice(i, i + CHUNK);
    const url = `https://lite-api.jup.ag/tokens/v2/search?query=${chunk.join(",")}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error("unexpected response shape");
    for (const raw of body) {
      const parsed = TokenStats.safeParse(raw);
      // Search can match loosely; only keep exact mint hits.
      if (parsed.success && chunk.includes(parsed.data.id)) out.set(parsed.data.id, parsed.data);
    }
  }
  return out;
}
