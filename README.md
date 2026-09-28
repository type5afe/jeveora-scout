# Meteora Scout

A personal terminal dashboard. Every minute it scans Meteora DLMM and DAMM v2 pools and tells you when one is worth entering, using Jev (TypeSafe AI) for the call. It's read-only: no wallet, no trades.

```
npm install
copy .env.example .env     # then put your TYPESAFE_API_KEY in .env
npm start                  # live dashboard, Ctrl+C to quit
npm run once               # print one snapshot and exit
```

Needs Node 24+ (it runs the TypeScript directly, no build step).

## How it decides

1. **Pools.** The top 50 pools per venue by fees earned vs TVL in the last hour, from Meteora's data API.
2. **Hard filters, in code.** SOL or USDC quote (checked by mint), minimum TVL, volume, fees and pool age, mint and freeze authority disabled, enough holders, top holders under the limit. Missing data counts as a fail. Jev can't override these.
3. **Jev.** Gets pre-computed, labeled numbers (never the token's name or symbol, which the creator controls) and answers: should an LP enter now, how likely is a rug, what's the price regime, and for DLMM, which liquidity shape fits.
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
- Update the code: stop it, copy `src` again with `scp`, run `./scripts/vps-start.sh`.

Only one copy runs per machine; a second one refuses to start. Stop the copy on your PC while the VPS runs it, or every Discord alert arrives twice. After a restart the alert list comes back from `logs/alerts.jsonl`, and alerts still in their cooldown aren't sent again.

The VPS clock is usually UTC. Set `TZ` in `.env` (for example `TZ=Asia/Jakarta`) to see your own time.

## Logs

- `logs/decisions.jsonl`: every Jev entry answer, with the exact state it saw and what the rules would have said. This is the data for judging whether Jev beats the rules.
- `logs/positions.jsonl`: every Jev answer about your open positions.
- `logs/alerts.jsonl`: every alert.

## Tuning

All thresholds live in `.env`; see [.env.example](.env.example) for the list and defaults.
