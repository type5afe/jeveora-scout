import { styleText } from "node:util";
import { age, clock, link, padEnd, pct, price, regime, truncate, usd, visibleLength } from "./format.ts";
import type { Alert, PositionView, Scout, Watch } from "./scout.ts";

type Style = Parameters<typeof styleText>[0];
const s = (style: Style, text: string) => styleText(style, text);

// Rough input price; output tokens are free.
const JEV_USD_PER_TOKEN = 0.042 / 1e6;

type Column = [title: string, width: number, align: "l" | "r"];

function table(columns: Column[]) {
  const row = (cells: string[]) =>
    "  " +
    cells
      .map((text, i) => {
        const [, width, align] = columns[i]!;
        const pad = " ".repeat(Math.max(0, width - visibleLength(text)));
        return align === "r" ? pad + text : text + pad;
      })
      .join(" ");
  return { row, header: s("dim", row(columns.map(([t]) => t))) };
}

const watchTable = table([
  ["PAIR", 15, "l"],
  ["VENUE", 9, "l"],
  ["TVL", 7, "r"],
  ["FEES/h", 7, "r"],
  ["VOL 1h", 7, "r"],
  ["PRICE 1h", 9, "r"],
  ["BUYS", 5, "r"],
  ["AGE", 6, "r"],
  ["SIGNAL", 24, "l"],
  ["CONF", 5, "r"],
  ["RUG", 5, "r"],
]);

// VALUE and FEES are in SOL when Meteora has a SOL price, otherwise in USD.
const positionTable = table([
  ["PAIR", 13, "l"],
  ["RANGE", 27, "l"],
  ["STATUS", 9, "l"],
  ["VALUE", 7, "r"],
  ["FEES", 7, "r"],
  ["PnL", 7, "r"],
  ["AGE", 5, "r"],
  ["JEV", 23, "l"],
  ["CONF", 5, "r"],
  ["RUG", 5, "r"],
]);

const regimeText = (r: string) => s("dim", ` · ${regime(r)}`);

function rugText(rug: number, scout: Scout): string {
  return rug > scout.cfg.MAX_RUG ? s("red", rug.toFixed(2)) : rug.toFixed(2);
}

function signalCell(w: Watch, scout: Scout): [signal: string, conf: string, rug: string] {
  const shape = w.jev?.shape ? ` · ${w.jev.shape.replace("_", "-")}` : "";

  if (!scout.jev.client) {
    return w.signal === "entry"
      ? [s(["green", "bold"], "▶ ENTRY") + s("dim", " · rules"), "–", "–"]
      : [s("yellow", "wait") + s("dim", ` · ${w.rules.reason}`), "–", "–"];
  }
  if (!w.jev) return [s("gray", "no answer yet"), "", ""];

  const conf = w.jev.confidence.toFixed(2);
  const rug = rugText(w.jev.rug, scout);
  const regime = regimeText(w.jev.regime);

  if (w.signal === "entry") return [s(["green", "bold"], "▶ ENTRY") + s("green", shape), s("green", conf), rug];
  if (w.signal === "opportunity") return [s("cyan", "● opportunity") + s("dim", shape), s("dim", conf), rug];
  switch (w.jev.entry) {
    // Jev said enter, but the rug score is over the limit.
    case "enter_now": return [s("red", "enter, but rug risk"), conf, rug];
    case "wait": return [s("yellow", "wait") + regime, conf, rug];
    case "avoid": return [s("red", "avoid") + regime, conf, rug];
    case "unclear": return [s("gray", "unclear") + regime, conf, rug];
  }
}

function watchRow(w: Watch, scout: Scout, now: number): string {
  const m = w.metrics;
  const change = m.price1h == null ? "–" : s(m.price1h >= 0 ? "green" : "red", pct(m.price1h, 1, true));
  const buys = m.buyShare1h == null ? "–" : `${Math.round(m.buyShare1h * 100)}%`;
  const venue = w.pool.venue === "dlmm" ? `DLMM ${w.pool.binStep}` : "DAMM v2";
  const [sig, conf, rug] = signalCell(w, scout);
  return watchTable.row([
    link(w.pair, w.pool.url),
    s("dim", venue),
    usd(w.pool.tvl),
    pct(m.feeTvl1hPct, 2),
    usd(m.volume1h),
    change,
    buys,
    age(now - w.pool.createdAt),
    sig,
    conf,
    rug,
  ]);
}

/** min ├────●──┤ max, with the marker where the price sits (low prices on the left). */
function rangeBar(v: PositionView): string {
  const { pos } = v;
  const W = 9;
  let bar: string;
  if (pos.side === "below") bar = s("red", "◀") + s("dim", "─".repeat(W - 1));
  else if (pos.side === "above") bar = s("dim", "─".repeat(W - 1)) + s("yellow", "▶");
  else {
    const i = Math.round(((pos.activeBin - pos.lowerBin) / Math.max(1, pos.upperBin - pos.lowerBin)) * (W - 1));
    bar = s("dim", "─".repeat(i)) + s("cyan", "●") + s("dim", "─".repeat(W - 1 - i));
  }
  return `${price(pos.minPrice)} ${s("dim", "├")}${bar}${s("dim", "┤")} ${price(pos.maxPrice)}`;
}

function statusCell(v: PositionView): string {
  const { pos } = v;
  if (pos.side === "below") return s("red", `▼ ${pct((1 - pos.price / pos.minPrice) * 100)}`);
  if (pos.side === "above") return s("yellow", `▲ ${pct((pos.price / pos.maxPrice - 1) * 100)}`);
  return s("green", "in range");
}

function positionJevCell(v: PositionView, scout: Scout): [jev: string, conf: string, rug: string] {
  if (!scout.jev.client) return [s("dim", "–"), "", ""];
  const { jev } = v;
  if (!jev) return [s("gray", "no answer yet"), "", ""];

  const conf = jev.confidence.toFixed(2);
  const rug = rugText(jev.rug, scout);
  const regime = regimeText(jev.regime);
  if (v.signal === "exit") return [s(["red", "bold"], "✖ EXIT") + regime, conf, rug];
  if (v.signal === "rebalance") return [s("magenta", "↻ rebalance") + regime, conf, rug];
  switch (jev.action) {
    case "hold": return [s("green", "hold") + regime, conf, rug];
    // Jev leaned toward acting, but wasn't confident enough (or wants a rebalance while still in range).
    case "exit":
    case "rebalance": return [s("yellow", `${jev.action}?`) + regime, s("dim", conf), rug];
    case "unclear": return [s("gray", "unclear") + regime, conf, rug];
  }
}

function positionRow(v: PositionView, scout: Scout, now: number): string {
  const { pos } = v;
  const value = pos.valueSol != null ? pos.valueSol.toFixed(3) : usd(pos.valueUsd);
  const fees = pos.feesSol != null ? pos.feesSol.toFixed(4) : usd(pos.feesUsd);
  const pnl = pos.pnlSolPct ?? pos.pnlPct;
  const [jev, conf, rug] = positionJevCell(v, scout);
  return positionTable.row([
    link(pos.pair, pos.url),
    rangeBar(v),
    statusCell(v),
    value,
    fees,
    s(pnl >= 0 ? "green" : "red", pct(pnl, 1, true)),
    age(now - pos.createdAt),
    jev,
    conf,
    rug,
  ]);
}

const ALERT_HEADS: Record<Alert["kind"], (pair: string) => string> = {
  entry: (pair) => s(["green", "bold"], "▶ ENTRY NOW on " + pair),
  opportunity: (pair) => s("cyan", "● Entry opportunity found  ") + pair,
  out_of_range: (pair) => s("yellow", "⚠ OUT OF RANGE  ") + pair,
  rebalance: (pair) => s("magenta", "↻ REBALANCE  ") + pair,
  exit: (pair) => s(["red", "bold"], "✖ EXIT  " + pair),
};

function alertLine(a: Alert): string {
  const head = ALERT_HEADS[a.kind](link("$" + a.pair, a.url));
  return `  ${s("dim", clock(a.at))}  ${padEnd(head, 44)} ${s("dim", a.detail)}`;
}

/**
 * One full screen. In a terminal the frame is cut to fit: lines never wrap, and the watch list and
 * alerts shrink so the header (with the countdown) and your positions always stay visible.
 */
export function render(scout: Scout, now: number, nextScanAt: number | null): string {
  const width = process.stdout.columns;
  const height = process.stdout.rows;

  // Header: the scan countdown goes first so it's never the part that gets cut off.
  const status = scout.scanning
    ? s("cyan", "scanning…")
    : scout.lastScan
      ? s("dim", `scan ${clock(scout.lastScan.at)}`) +
        (nextScanAt ? " · " + s("cyan", `next in ${Math.max(0, Math.ceil((nextScanAt - now) / 1000))}s`) : "")
      : s("cyan", "starting…");
  const jev = scout.jev.client
    ? s("green", "● Jev on") +
      s(
        "dim",
        `  ${scout.jev.lastModel ?? scout.jev.model} · ${scout.jev.calls} calls · ~$${(scout.jev.inputTokens * JEV_USD_PER_TOKEN).toFixed(4)}` +
          ` · outcomes ${scout.outcomes.logged} logged, ${scout.outcomes.pending} pending`,
      )
    : s("yellow", "○ Jev off") + s("dim", "  rules only · add TYPESAFE_API_KEY to .env");

  const discord = scout.discord ? s("dim", ` · Discord ${scout.discord.sent} sent`) : "";
  const top: string[] = [s(["bold", "inverse"], " METEORA SCOUT ") + "  " + status + "   " + jev + discord, s("dim", "─".repeat(width ?? 100))];
  const scan = scout.lastScan;
  if (scan) {
    const rejects = scan.rejects.slice(0, 5).map(([r, n]) => `${r} ${n}`).join(" · ");
    top.push(
      s("dim", `  ${scan.scanned} pools scanned · `) +
        s("bold", `${scan.passed} watching`) +
        (rejects ? s("dim", ` · filtered out: ${rejects}`) : ""),
    );
    for (const e of scan.errors) top.push(s("yellow", `  ⚠ ${e}`));
  }
  if (scout.discord?.lastError) top.push(s("yellow", `  ⚠ Discord: ${scout.discord.lastError}`));
  if (scout.crash) top.push(s("red", `  ✖ ${scout.crash}`));

  // Your positions
  const p = scout.portfolio;
  if (!scout.cfg.WALLET) {
    top.push("", s("bold", "  MY POSITIONS") + s("dim", "  add WALLET=<your public address> to .env to track them"));
  } else if (p) {
    const value = p.valueSol != null ? `${p.valueSol.toFixed(3)} SOL (${usd(p.valueUsd)})` : usd(p.valueUsd);
    const pnl = p.pnlSolPct ?? p.pnlPct;
    top.push(
      "",
      s("bold", "  MY POSITIONS") +
        s("dim", `  ${scout.positions.length} open · ${value} · unclaimed fees ${usd(p.feesUsd)} · PnL `) +
        s(pnl >= 0 ? "green" : "red", pct(pnl, 1, true)),
    );
    if (scout.positions.length === 0) top.push(s("dim", "  No open DLMM positions."));
    else {
      top.push(positionTable.header);
      for (const v of scout.positions) top.push(positionRow(v, scout, now));
    }
  }

  const watchRows = scout.watching.map((w) => watchRow(w, scout, now));
  const alertRows = scout.alerts.map(alertLine);

  // Rows left for watch rows and alerts, after the header, positions and the 5 section lines
  // (blank, WATCHING, table header, blank, ALERTS). The last terminal row stays empty so nothing scrolls.
  const free = height ? Math.max(0, height - 1 - top.length - 5) : Infinity;
  const alertMin = Math.min(3, Math.max(1, alertRows.length));
  const watchRoom = Math.min(watchRows.length, Math.max(0, free - alertMin));
  const alertRoom = Math.max(0, free - watchRoom);

  const lines = [...top, "", s("bold", "  WATCHING")];
  if (watchRows.length === 0) lines.push(s("dim", scan ? "  Nothing passes the filters right now." : "  …"));
  else {
    lines.push(watchTable.header);
    if (watchRoom < watchRows.length) {
      const shown = Math.max(0, watchRoom - 1);
      lines.push(...watchRows.slice(0, shown), s("dim", `  … ${watchRows.length - shown} more (make the terminal taller to see them)`));
    } else lines.push(...watchRows);
  }
  lines.push("", s("bold", "  ALERTS"));
  if (alertRows.length === 0) lines.push(s("dim", "  No alerts yet."));
  else lines.push(...alertRows.slice(0, alertRoom));

  const fitted = height ? lines.slice(0, height - 1) : lines;
  return (width ? fitted.map((l) => truncate(l, width)) : fitted).join("\n");
}
