import { log } from "./config.js";

export type HoldOutcome = "approved" | "denied" | "timeout";

interface Waiter {
  resolve: (o: HoldOutcome) => void;
  timer: NodeJS.Timeout;
  heartbeat?: NodeJS.Timeout;
}

const waiters = new Map<string, Waiter>();

/**
 * Suspend an in-flight MCP tool call until a human decides.
 *
 * The call does not return, does not error, and does not time out at the
 * transport layer. `onHeartbeat` emits an MCP progress notification every few
 * seconds so nothing between the agent and Interlock closes the connection.
 */
export function waitForHuman(
  txId: string,
  timeoutMs: number,
  onHeartbeat?: (elapsedMs: number) => void
): Promise<HoldOutcome> {
  return new Promise<HoldOutcome>((resolve) => {
    const started = Date.now();

    const timer = setTimeout(() => {
      waiters.delete(txId);
      log(`hold ${txId} timed out after ${timeoutMs}ms`);
      resolve("timeout");
    }, timeoutMs);

    const heartbeat = onHeartbeat
      ? setInterval(() => onHeartbeat(Date.now() - started), 5_000)
      : undefined;

    waiters.set(txId, { resolve, timer, heartbeat });
    log(`hold ${txId} waiting on a human`);
  });
}

/** Called by the console API when someone presses approve or deny. */
export function resolveHold(txId: string, outcome: Exclude<HoldOutcome, "timeout">): boolean {
  const w = waiters.get(txId);
  if (!w) return false;
  clearTimeout(w.timer);
  if (w.heartbeat) clearInterval(w.heartbeat);
  waiters.delete(txId);
  w.resolve(outcome);
  log(`hold ${txId} ${outcome}`);
  return true;
}

export const openHolds = () => [...waiters.keys()];
