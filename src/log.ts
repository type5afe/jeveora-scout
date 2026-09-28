import { appendFileSync, closeSync, fstatSync, mkdirSync, openSync, readSync } from "node:fs";

export const LOG_DIR = "logs";

/** Append one JSON record. Synchronous so nothing is lost when `--once` exits right after a scan. */
export function appendLog(file: string, record: object): void {
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    appendFileSync(`${LOG_DIR}/${file}`, JSON.stringify(record) + "\n");
  } catch {
    // Logging must never take the dashboard down.
  }
}

const CHUNK = 1 << 20;

/**
 * Records from a log, newest first. It reads from the end of the file, so a caller that stops
 * once it reaches old records never loads the rest of a big log. Unreadable lines are skipped.
 */
export function* readLogBackwards(file: string): Generator<unknown> {
  let fd: number;
  try {
    fd = openSync(`${LOG_DIR}/${file}`, "r");
  } catch {
    return; // No log yet.
  }
  try {
    let pos = fstatSync(fd).size;
    // The start of a line whose beginning is in the chunk before this one.
    let rest = Buffer.alloc(0);
    while (pos > 0) {
      const len = Math.min(CHUNK, pos);
      pos -= len;
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, pos);
      const data = Buffer.concat([buf, rest]);
      let end = data.length;
      for (let i = end - 1; i >= 0; i--) {
        if (data[i] !== 0x0a) continue;
        const record = parse(data, i + 1, end);
        if (record !== undefined) yield record;
        end = i;
      }
      rest = data.subarray(0, end);
    }
    const first = parse(rest, 0, rest.length);
    if (first !== undefined) yield first;
  } finally {
    closeSync(fd);
  }
}

function parse(data: Buffer, start: number, end: number): unknown {
  if (end <= start) return undefined;
  try {
    return JSON.parse(data.toString("utf8", start, end));
  } catch {
    return undefined;
  }
}
