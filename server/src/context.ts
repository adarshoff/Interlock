/**
 * What the agent read before it decided to pay.
 *
 * Two routes, both supported:
 *   1. the agent passes context explicitly as a tool argument, or
 *   2. the agent browses through Interlock's own fetch_page tool, in which
 *      case Interlock has already seen every page — no cooperation needed.
 *
 * Route 2 is what the demo uses.
 */
interface Entry {
  url: string;
  text: string;
  at: number;
}

const bySession = new Map<string, Entry[]>();
const notes = new Map<string, string>();

export function remember(sessionId: string, url: string, text: string) {
  const list = bySession.get(sessionId) ?? [];
  list.push({ url, text, at: Date.now() });
  bySession.set(sessionId, list.slice(-10));
}

export function noteReasoning(sessionId: string, reasoning: string) {
  notes.set(sessionId, reasoning);
}

export function recentContext(sessionId: string) {
  const list = bySession.get(sessionId) ?? [];
  const content = list.map((e) => `--- ${e.url} ---\n${e.text}`).join("\n\n");
  return { content, reasoning: notes.get(sessionId) ?? "" };
}
