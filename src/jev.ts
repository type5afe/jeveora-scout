import { choice, noul, TypeSafeClient, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import type { Config, Venue } from "./config.ts";

const market = {
  regime: choice("What is the current market regime for this token's price?", {
    ranging: "Moving sideways within a band",
    trending_up: "In a sustained climb",
    trending_down: "In a sustained decline",
    spiking: "Making sudden, violent moves",
  }),
  rug: noul("This token shows signs of a rug pull, a coordinated dump, or liquidity being pulled"),
};

/** How long the entry question assumes the LP stays in. */
export const ENTRY_HOURS = 4;

/**
 * Bump whenever the entry question changes, so outcomes are only compared within one wording.
 * v1 asked whether the token "looks stable enough"; on the high-fee pools the scout watches, Jev never said enter_now.
 */
export const ENTRY_PROMPT = 2;

const entryQuestions = {
  ...market,
  entry: choice(
    `A liquidity provider funds a position in this pool with the quote token now and withdraws after ${ENTRY_HOURS} hours. ` +
      "Will the fees they earn outweigh any loss from the token's price falling, so they end up with more of the quote token than they put in?",
    {
      enter_now: "Yes, most likely: the fees should outweigh the likely price damage. Volatility is fine when the fees pay for it",
      wait: "It could get there soon, but not right now",
      avoid: "No, most likely: a price drop or a dump would cost more than the fees earn",
      unclear: "There is no clear signal either way",
    },
  ),
};

const dlmmEntryQuestions = {
  ...entryQuestions,
  shape: choice("Which DLMM liquidity shape best fits current conditions?", {
    spot: "Even liquidity across the range; suits sideways, moderately volatile markets",
    curve: "Liquidity concentrated around the current price; suits calm, tight markets",
    bid_ask: "Liquidity weighted to the edges of the range; suits volatile markets with big swings",
  }),
};

const positionQuestions = {
  ...market,
  action: choice("A liquidity provider already has an open position in this pool. What should they do now?", {
    hold: "Keep the position; conditions still favor providing liquidity",
    rebalance: "The price has settled at a new level; move the range to follow it",
    exit: "Conditions have turned bad; withdraw now",
    unclear: "There is no clear signal either way",
  }),
};

type Regime = keyof typeof market.regime.criteria;

export interface JevVerdict {
  at: number;
  model: string;
  entry: keyof typeof entryQuestions.entry.criteria;
  confidence: number;
  rug: number;
  regime: Regime;
  shape: keyof typeof dlmmEntryQuestions.shape.criteria | null;
}

export interface PositionVerdict {
  at: number;
  model: string;
  action: keyof typeof positionQuestions.action.criteria;
  confidence: number;
  rug: number;
  regime: Regime;
}

type State = Record<string, string>;

export class Jev {
  readonly client: TypeSafeClient | null;
  lastError: string | null = null;
  /** The concrete version behind `jev-latest`, from the last response. */
  lastModel: string | null = null;
  calls = 0;
  inputTokens = 0;

  constructor(cfg: Config) {
    this.client = cfg.TYPESAFE_API_KEY
      ? new TypeSafeClient({ apiKey: cfg.TYPESAFE_API_KEY, timeout: 8_000, retry: { maxRetries: 1 } })
      : null;
  }

  get model(): string | null {
    return this.client?.defaultModel ?? null;
  }

  /** Should an LP enter this pool? DLMM pools also get a liquidity shape. */
  async ask(venue: Venue, state: State): Promise<JevVerdict | null> {
    if (venue === "dlmm") {
      const res = await this.#run(state, dlmmEntryQuestions);
      return res && { ...this.#entry(res), shape: res.answers.shape.choice };
    }
    const res = await this.#run(state, entryQuestions);
    return res && { ...this.#entry(res), shape: null };
  }

  /** Hold, rebalance or exit an open position. */
  async askPosition(state: State): Promise<PositionVerdict | null> {
    const res = await this.#run(state, positionQuestions);
    if (!res) return null;
    const a = res.answers;
    return {
      at: Date.now(),
      model: res.model,
      action: a.action.choice,
      confidence: a.action.confidence,
      rug: a.rug.noul,
      regime: a.regime.choice,
    };
  }

  #entry(res: SystemOneResult<typeof entryQuestions>): Omit<JevVerdict, "shape"> {
    const a = res.answers;
    return {
      at: Date.now(),
      model: res.model,
      entry: a.entry.choice,
      confidence: a.entry.confidence,
      rug: a.rug.noul,
      regime: a.regime.choice,
    };
  }

  async #run<const Q extends Questions>(state: State, questions: Q): Promise<SystemOneResult<Q> | null> {
    if (!this.client) return null;
    try {
      const res = await this.client.systemOne({ state, questions });
      this.calls++;
      this.inputTokens += res.usage.input_tokens;
      this.lastError = null;
      this.lastModel = res.model;
      return res;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return null;
    }
  }
}
