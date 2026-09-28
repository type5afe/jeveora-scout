import type { Metrics } from "./screen.ts";

export type RuleVerdict = { entry: "enter" | "wait"; reason: string };

/**
 * A deliberately simple baseline. It drives "Entry Now" when Jev is off, and is logged
 * next to every Jev answer so you can later compare the two.
 */
export function ruleVerdict(m: Metrics): RuleVerdict {
  const wait = (reason: string): RuleVerdict => ({ entry: "wait", reason });

  if (m.feeTvl1hPct < 0.5) return wait("fees below 0.5%/h");
  if (m.volumeTrend < 0.8) return wait("volume fading");
  if (m.price1h == null || m.buyShare1h == null) return wait("no price data");
  if (m.price1h < -15) return wait("dumping");
  if (m.price1h > 40) return wait("pumping too hard");
  if (m.buyShare1h < 0.45) return wait("sellers dominate");
  if (m.liquidityChange1h != null && m.liquidityChange1h < -15) return wait("liquidity leaving");
  return { entry: "enter", reason: "fees strong, flow healthy" };
}
