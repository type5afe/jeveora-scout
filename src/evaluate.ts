import { readFileSync } from "node:fs";
import { config } from "./config.ts";
import { pct } from "./format.ts";
import { LOG_DIR } from "./log.ts";
import { HORIZONS, Outcome, outcomeKey } from "./outcomes.ts";

// `npm run evaluate`: how Jev's entry calls, and the rules', turned out. Reads logs/outcomes.jsonl.

let text = "";
try {
  text = readFileSync(`${LOG_DIR}/outcomes.jsonl`, "utf8");
} catch {
  // No outcomes yet.
}

// A `npm run once` next to the running scout can log the same check twice; count it once.
const seen = new Set<string>();
const all = text.split("\n").flatMap((line): Outcome[] => {
  let parsed;
  try {
    parsed = Outcome.safeParse(JSON.parse(line));
  } catch {
    return [];
  }
  if (!parsed.success) return [];
  const key = outcomeKey(parsed.data.pool, parsed.data.decidedAt, parsed.data.horizon);
  if (seen.has(key)) return [];
  seen.add(key);
  return [parsed.data];
});

if (all.length === 0) {
  console.log("No outcomes yet. The scout checks back 1h, 4h and 24h after each Jev entry call, so leave it running.");
  process.exit(0);
}

// Answers to different wordings of the question don't compare, so report the latest one only.
const prompt = Math.max(...all.map((o) => o.prompt));
const outcomes = all.filter((o) => o.prompt === prompt);
const pools = new Set(outcomes.map((o) => o.pool)).size;
const calls = new Set(outcomes.map((o) => `${o.pool}:${o.decidedAt}`)).size;

const { MIN_CONFIDENCE, MAX_RUG } = config;
const groups: [label: string, match: (o: Outcome) => boolean][] = [
  ["all calls", () => true],
  [`Jev ▶ ENTRY NOW (conf ≥ ${MIN_CONFIDENCE}, rug ≤ ${MAX_RUG})`, (o) => o.jev.entry === "enter_now" && o.jev.confidence >= MIN_CONFIDENCE && o.jev.rug <= MAX_RUG],
  ["Jev enter_now (any confidence)", (o) => o.jev.entry === "enter_now"],
  ["Jev wait", (o) => o.jev.entry === "wait"],
  ["Jev avoid", (o) => o.jev.entry === "avoid"],
  ["Jev unclear", (o) => o.jev.entry === "unclear"],
  ["rules enter", (o) => o.rules === "enter"],
  ["rules wait", (o) => o.rules === "wait"],
];

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const LABEL = 42;
const cols = (...cells: string[]) => cells.map((c) => c.padStart(8)).join("");

console.log(`Entry question v${prompt}: ${calls} Jev calls on ${pools} pools.`);
console.log("Return: what a 50/50 full-range LP would have made in SOL/USDC terms, fees included.");
if (pools < 20) console.log(`Only ${pools} pools so far. Calls on the same pool move together, so these numbers are early.`);

for (const horizon of HORIZONS) {
  const rows = outcomes.filter((o) => o.horizon === horizon);
  if (rows.length === 0) continue;
  console.log("\n" + `AFTER ${horizon}`.padEnd(LABEL) + cols("calls", "pools", "avg", "median", "ahead"));
  for (const [label, match] of groups) {
    const hits = rows.filter(match);
    if (hits.length === 0) {
      console.log(`  ${label}`.padEnd(LABEL) + cols("0", "–", "–", "–", "–"));
      continue;
    }
    const returns = hits.map((o) => o.lpReturnPct);
    console.log(
      `  ${label}`.padEnd(LABEL) +
        cols(
          String(hits.length),
          String(new Set(hits.map((o) => o.pool)).size),
          pct(returns.reduce((a, b) => a + b, 0) / returns.length, 1, true),
          pct(median(returns), 1, true),
          pct((returns.filter((r) => r > 0).length / returns.length) * 100, 0),
        ),
    );
  }
}
