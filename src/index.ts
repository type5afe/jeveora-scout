import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { config } from "./config.ts";
import { Discord } from "./discord.ts";
import { Scout } from "./scout.ts";
import { render } from "./ui.ts";

const scout = new Scout(config);
const intervalMs = config.SCAN_INTERVAL_SEC * 1000;

// `npm run test-discord`: send one sample alert to check the webhook.
if (process.argv.includes("--test-discord")) {
  if (!config.DISCORD_WEBHOOK_URL) {
    console.error("Set DISCORD_WEBHOOK_URL in .env first.");
    process.exit(1);
  }
  const discord = new Discord(config.DISCORD_WEBHOOK_URL);
  discord.send({
    at: Date.now(),
    kind: "opportunity",
    pair: "TEST/SOL",
    url: "https://app.meteora.ag/",
    detail: "Test message from Meteora Scout. If you can see this, Discord alerts work.",
  });
  await discord.flush();
  console.log(discord.lastError ? `Discord failed: ${discord.lastError}` : "Sent. Check your Discord channel.");
  process.exit(discord.lastError ? 1 : 0);
}

// `npm run once`: print a single snapshot and exit.
if (process.argv.includes("--once")) {
  await scout.scan();
  await scout.discord?.flush();
  process.stdout.write(render(scout, Date.now(), null) + "\n");
  process.exit(scout.crash ? 1 : 0);
}

// Only one long-running copy at a time: two would send every Discord alert twice.
const LOCK = "logs/scout.lock";
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};
try {
  const other = Number(readFileSync(LOCK, "utf8"));
  if (other && other !== process.pid && alive(other)) {
    console.error(`Meteora Scout is already running (pid ${other}). A second copy would send every alert twice.`);
    console.error("On the VPS, open the running one with: tmux attach -t scout");
    process.exit(1);
  }
} catch {
  // No lock file: nothing else is running.
}
mkdirSync("logs", { recursive: true });
writeFileSync(LOCK, String(process.pid));
process.on("exit", () => {
  try {
    if (readFileSync(LOCK, "utf8") === String(process.pid)) rmSync(LOCK);
  } catch {
    // Already gone.
  }
});

// Not an interactive terminal (piped, or a console that doesn't report as a TTY):
// can't redraw in place, so print a fresh snapshot after every scan instead.
if (!process.stdout.isTTY) {
  // Exit through process.exit so the lock file is cleaned up.
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  process.stdout.write(`Not an interactive terminal: printing a new snapshot every ${config.SCAN_INTERVAL_SEC}s.\n\n`);
  for (;;) {
    await scout.scan();
    process.stdout.write(render(scout, Date.now(), Date.now() + intervalMs) + "\n\n");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

let nextScanAt: number | null = null;

function draw(): void {
  const frame = render(scout, Date.now(), nextScanAt);
  // Redraw in place: home the cursor, clear each line's tail, then clear below.
  process.stdout.write("\x1b[H" + frame.split("\n").join("\x1b[K\n") + "\x1b[K\x1b[J");
}

function quit(): void {
  // Leave the full-screen view and print the last frame so it stays in your scrollback.
  process.stdout.write("\x1b[?1049l\x1b[?25h" + render(scout, Date.now(), null) + "\n");
  process.exit(0);
}

// Full-screen view (like top/htop): its own screen buffer, cursor hidden.
process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
process.stdout.on("resize", () => {
  process.stdout.write("\x1b[2J");
  draw();
});

async function loop(): Promise<void> {
  nextScanAt = null;
  draw();
  await scout.scan();
  nextScanAt = Date.now() + intervalMs;
  draw();
  setTimeout(loop, intervalMs);
}

setInterval(draw, 1000);
void loop();
