export function usd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}k`;
  return `$${v.toFixed(abs >= 100 ? 0 : 2)}`;
}

export function pct(v: number, digits = 1, signed = false): string {
  const s = `${v.toFixed(digits)}%`;
  return signed && v > 0 ? `+${s}` : s;
}

const SUBSCRIPT = "₀₁₂₃₄₅₆₇₈₉";

/** Prices the way Meteora shows them: 0.0000520 → 0.0₄520. */
export function price(v: number): string {
  if (!Number.isFinite(v) || v <= 0) return "–";
  if (v >= 0.001) return v >= 1000 ? v.toFixed(0) : v.toPrecision(4);
  const [mantissa, exp] = v.toExponential(2).split("e");
  const zeros = -Number(exp) - 1;
  const sub = String(zeros).split("").map((d) => SUBSCRIPT[Number(d)]).join("");
  return `0.0${sub}${mantissa!.replace(".", "")}`;
}

const REGIMES: Record<string, string> = { trending_up: "uptrend", trending_down: "downtrend" };

/** Short name for a Jev market regime. */
export function regime(r: string): string {
  return REGIMES[r] ?? r;
}

export function age(ms: number): string {
  const min = ms / 60_000;
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)}h`;
  return `${(min / 1440).toFixed(1)}d`;
}

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.name === "TimeoutError" ? "request timed out" : err.message;
  return String(err);
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString("en-GB", { hour12: false });
}

/**
 * Token symbols are chosen by whoever launched the token, so they can carry terminal
 * escape sequences. Keep printable characters only and cap the length.
 */
export function safeSymbol(symbol: string, max = 12): string {
  const clean = symbol.replace(/[^\p{L}\p{N}\p{P}\p{S} ]/gu, "").trim();
  return clean.length > max ? clean.slice(0, max - 1) + "…" : clean || "?";
}

const ANSI = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/g;

export function visibleLength(s: string): number {
  return s.replace(ANSI, "").length;
}

const ANSI_AT = /\x1b\[[0-9;]*m|\x1b\]8;;[^\x1b]*\x1b\\/y;
const LINK_END = "\x1b]8;;\x1b\\";

/** Cut a styled line to `width` visible characters, so it never wraps onto a second row. */
export function truncate(s: string, width: number): string {
  if (visibleLength(s) <= width) return s;
  let out = "";
  let seen = 0;
  let inLink = false;
  for (let i = 0; i < s.length && seen < width - 1; ) {
    ANSI_AT.lastIndex = i;
    const code = ANSI_AT.exec(s)?.[0];
    if (code) {
      if (code.startsWith("\x1b]8")) inLink = code !== LINK_END;
      out += code;
      i += code.length;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i)!);
    out += ch;
    i += ch.length;
    seen += ch.length;
  }
  return out + "…" + (inLink ? LINK_END : "") + "\x1b[0m";
}

export function padEnd(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - visibleLength(s)));
}

/** Clickable link in terminals that support OSC 8 (Windows Terminal, VS Code); plain text elsewhere. */
export function link(text: string, url: string): string {
  if (!process.stdout.isTTY) return text;
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
