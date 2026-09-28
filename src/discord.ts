import type { Alert } from "./scout.ts";

const STYLE: Record<Alert["kind"], { title: string; color: number }> = {
  opportunity: { title: "● Entry opportunity found", color: 0x22d3ee },
  entry: { title: "▶ ENTRY NOW", color: 0x22c55e },
  out_of_range: { title: "⚠ Out of range", color: 0xeab308 },
  rebalance: { title: "↻ Rebalance", color: 0xd946ef },
  exit: { title: "✖ EXIT", color: 0xef4444 },
};

// Token symbols come from token creators, so keep them from turning into Discord formatting or links.
const escapeMarkdown = (s: string) => s.replace(/[\\`*_~|>[\]()#-]/g, "\\$&");

function payload(alert: Alert): object {
  const style = STYLE[alert.kind];
  return {
    username: "Meteora Scout",
    // Never ping anyone, whatever a token name contains.
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: `${style.title} · $${alert.pair}`,
        url: alert.url,
        description: escapeMarkdown(alert.detail),
        color: style.color,
        timestamp: new Date(alert.at).toISOString(),
      },
    ],
  };
}

/** Posts alerts to a Discord webhook one at a time, waiting out Discord's rate limit when it asks. */
export class Discord {
  lastError: string | null = null;
  sent = 0;
  readonly #url: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(url: string) {
    this.#url = url;
  }

  send(alert: Alert): void {
    this.#queue = this.#queue.then(() => this.#post(payload(alert)));
  }

  /** Resolves once everything queued so far has been sent (or failed). */
  flush(): Promise<void> {
    return this.#queue;
  }

  async #post(body: object, attempt = 0): Promise<void> {
    try {
      const res = await fetch(this.#url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 429 && attempt < 3) {
        const info = (await res.json().catch(() => ({}))) as { retry_after?: number };
        await new Promise((r) => setTimeout(r, Math.ceil((info.retry_after ?? 1) * 1000)));
        return this.#post(body, attempt + 1);
      }
      if (!res.ok) {
        const hint = res.status === 401 || res.status === 404 ? " (check DISCORD_WEBHOOK_URL)" : "";
        this.lastError = `HTTP ${res.status}${hint}`;
        return;
      }
      this.lastError = null;
      this.sent++;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }
}
