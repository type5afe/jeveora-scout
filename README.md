# Meteora Scout

A personal terminal dashboard. Every minute it scans Meteora DLMM and DAMM v2 pools and tells you when one is worth entering, using Jev (TypeSafe AI) for the call. It's read-only: no wallet, no trades.

```
npm install
copy .env.example .env     # then put your TYPESAFE_API_KEY in .env
npm start                  # live dashboard, Ctrl+C to quit
npm run once               # print one snapshot and exit
npm run evaluate           # how Jev's entry calls have turned out so far
```

Needs Node 24+ (it runs the TypeScript directly, no build step).

## How it decides

1. **Pools.** The top 50 pools per venue by fees earned vs TVL over the last 4 hours (`RANK_WINDOW`), from Meteora's data API. Ranking by the last hour mostly finds tokens that are pumping right now.
2. **Hard filters, in code.** SOL or USDC quote (checked by mint), minimum TVL, volume, fees and pool age, mint and freeze authority disabled, enough holders, top holders under the limit. Missing data counts as a fail. Jev can't override these.
3. **Jev.** Gets pre-computed, labeled numbers (never the token's name or symbol, which the creator controls) and answers: if an LP put in SOL or USDC now and pulled out after 4 hours, would the fees outweigh a falling price; how likely is a rug; what's the price regime; and for DLMM, which liquidity shape fits.
4. **Signals.**
   - `● Entry opportunity found`: Jev says enter, but its confidence is below `MIN_CONFIDENCE`.
   - `▶ ENTRY NOW`: Jev says enter, confidence ≥ `MIN_CONFIDENCE`, and rug score ≤ `MAX_RUG`. Rings the terminal bell.

Each alert fires once per pool per `ALERT_COOLDOWN_MIN`. Without an API key, the simple rules in [src/rules.ts](src/rules.ts) decide instead.

## My positions

Set `WALLET` in `.env` to your wallet's **public** address (never a private key) to see your open DLMM positions at the top: range with a marker where the price is, in/out of range, value, unclaimed fees and PnL (in SOL), and Jev's call (hold, rebalance or exit). DAMM v2 positions aren't shown yet; Meteora's API only covers DLMM.

- `⚠ OUT OF RANGE`: the price left your range. Fires from the numbers alone, no Jev involved.
- `↻ REBALANCE`: the price is outside your range and Jev says move the range, with confidence ≥ `MIN_CONFIDENCE`. While you're in range, a Jev "rebalance" only shows as a yellow `rebalance?`.
- `✖ EXIT`: Jev says withdraw with confidence ≥ `MIN_CONFIDENCE`, or the rug score is over `MAX_RUG` at any confidence. Rings the bell.

## Discord alerts

1. In Discord, open the channel's settings: **Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL**.
2. Paste it into `.env` as `DISCORD_WEBHOOK_URL=...`. Treat it like a password: anyone with the URL can post to your channel.
3. Run `npm run test-discord`. A test message should appear in the channel.
4. Restart the dashboard. Every alert now also goes to Discord, and the header shows `Discord N sent`.

To send only some alert types, set for example `DISCORD_ALERTS=entry,exit` (options: `opportunity`, `entry`, `out_of_range`, `rebalance`, `exit`). If Discord rejects a message, a yellow `⚠ Discord:` line appears under the header.

## Run it 24/7 on a VPS

Any small Linux VPS works (Ubuntu 22.04 or 24.04; the scout uses about 100 MB of RAM). Only your *public* wallet address goes on the server, never a private key.

1. **Install Node and tmux** on the VPS:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_26.x | sudo -E bash -
   sudo apt-get install -y nodejs tmux
   ```
2. **Copy the project** from your PC (PowerShell, in this folder):
   ```powershell
   ssh you@your-vps "mkdir -p ~/meteora"
   scp -r src scripts package.json package-lock.json tsconfig.json .env you@your-vps:~/meteora/
   ```
3. **Install and start** on the VPS:
   ```bash
   cd ~/meteora
   npm ci --omit=dev
   chmod 600 .env && chmod +x scripts/vps-start.sh
   npm run once              # quick check that everything connects
   ./scripts/vps-start.sh    # starts it in the background, restarts it if it ever stops
   ```
4. **Start on boot**: run `crontab -e` and add `@reboot $HOME/meteora/scripts/vps-start.sh`.

Day to day:

- See the dashboard: `ssh you@your-vps`, then `tmux attach -t scout`. Leave it running with **Ctrl+B, then D**.
- Stop it: `tmux kill-session -t scout`.
- Update the code: stop it, copy `src` and `package.json` again with `scp`, run `./scripts/vps-start.sh`.

Only one copy runs per machine; a second one refuses to start. Stop the copy on your PC while the VPS runs it, or every Discord alert arrives twice. After a restart the alert list comes back from `logs/alerts.jsonl`, and alerts still in their cooldown aren't sent again.

The VPS clock is usually UTC. Set `TZ` in `.env` (for example `TZ=Asia/Jakarta`) to see your own time.

## Logs

- `logs/decisions.jsonl`: every Jev entry answer, with the exact state it saw, the pool's price, and what the rules would have said.
- `logs/outcomes.jsonl`: what happened 1h, 4h and 24h after each of those answers: the price move, the fees the pool earned, and the resulting LP return.
- `logs/positions.jsonl`: every Jev answer about your open positions.
- `logs/alerts.jsonl`: every alert.

## Is Jev any good?

`npm run evaluate` groups the outcomes by Jev's answer, and by what the rules said, and shows how an LP would have done after 1h, 4h and 24h: the average and median return, and how often it came out ahead.

The return is a yardstick, not your real PnL: what a 50/50 full-range position would have made in SOL or USDC terms, fees included. A DLMM position earns more fees while in range and loses more when the price runs away, but every answer is measured the same way, so the comparison is fair.

- Checks only happen while the scout runs. One that comes due while it's down is still made after a restart if it's less than 10% of its window late (6 minutes for the 1h check), and dropped otherwise, because Meteora's fee numbers cover a rolling window.
- Jev is asked about each watched pool every few minutes and tends to give the same answer, so many calls come from a few pools. The `pools` column is the better guide to how much evidence there is.
- The report only uses the current wording of the entry question. Decisions logged before this version have no price, so they get no outcomes.

## Tuning

All thresholds live in `.env`; see [.env.example](.env.example) for the list and defaults.
