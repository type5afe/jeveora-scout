import { z } from "zod";

try {
  process.loadEnvFile();
} catch {
  // No .env file: fall back to the real environment and defaults.
}

const list = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .transform((s) => s.split(",").map((v) => v.trim()).filter(Boolean))
    .pipe(z.array(z.enum(values)).min(1));

const Env = z.object({
  TYPESAFE_API_KEY: z.string().trim().optional(),
  TYPESAFE_DEFAULT_MODEL: z.string().trim().optional(),

  /** Public wallet address whose open positions to track. Never a private key. */
  WALLET: z
    .string()
    .trim()
    .regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "WALLET must be a Solana public address")
    .optional(),

  /** Discord channel webhook. Treat it like a password: anyone with it can post to your channel. */
  DISCORD_WEBHOOK_URL: z
    .url()
    .regex(/^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\//, "DISCORD_WEBHOOK_URL must be a Discord webhook URL")
    .optional(),
  DISCORD_ALERTS: list(["opportunity", "entry", "out_of_range", "rebalance", "exit"]).default([
    "opportunity",
    "entry",
    "out_of_range",
    "rebalance",
    "exit",
  ]),

  SCAN_INTERVAL_SEC: z.coerce.number().int().min(15).default(60),
  JEV_INTERVAL_SEC: z.coerce.number().int().min(30).default(180),

  VENUES: list(["dlmm", "dammv2"]).default(["dlmm", "dammv2"]),
  QUOTES: list(["SOL", "USDC"]).default(["SOL", "USDC"]),
  /** Which window's fees vs TVL ranks the pools. The last hour mostly finds tokens that are pumping right now. */
  RANK_WINDOW: z.enum(["1h", "4h", "24h"]).default("4h"),
  MIN_TVL_USD: z.coerce.number().min(0).default(10_000),
  MIN_VOLUME_1H_USD: z.coerce.number().min(0).default(20_000),
  MIN_FEE_TVL_1H_PCT: z.coerce.number().min(0).default(0.2),
  MIN_POOL_AGE_MIN: z.coerce.number().min(0).default(30),
  MIN_HOLDERS: z.coerce.number().int().min(0).default(300),
  MAX_TOP_HOLDERS_PCT: z.coerce.number().min(0).max(100).default(30),
  MAX_WATCHING: z.coerce.number().int().min(1).max(50).default(10),

  MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.7),
  MAX_RUG: z.coerce.number().min(0).max(1).default(0.3),

  ALERT_COOLDOWN_MIN: z.coerce.number().min(0).default(30),
});

const parsed = Env.safeParse(
  // Treat empty values in .env as unset so defaults apply.
  Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
);
if (!parsed.success) {
  console.error("Invalid configuration in .env:\n" + z.prettifyError(parsed.error));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
export type Venue = Config["VENUES"][number];
export type Quote = Config["QUOTES"][number];
