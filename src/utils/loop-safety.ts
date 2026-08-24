/**
 * Loop safety (#491)
 *
 * In a multi-bot channel, claude-threads' own output is a valid trigger for
 * the next bot. Two guards live here:
 *
 * 1. `isBotStatusPost` — the bot's status posts ("not authorized", "Too busy",
 *    "Session timed out", …) are machine output, never a request. Dropping
 *    them at the top of the message-handling entry point keeps bot A's notices
 *    from waking bot B. Matching is against the *whole* status template, not
 *    just the leading emoji: a human message that merely starts with ⚠️, or
 *    one that quotes a status post to ask about it, must still get through.
 *
 * 2. `shouldPostResumeRefusal` — the "not authorized to resume this session"
 *    refusal carries the same information every time, so it is posted at most
 *    once per (thread, user) per 10 minutes, and only once it has actually
 *    been posted. A loop firing seconds apart goes
 *    quiet; a human who wanders back later is still told why nothing happened.
 *    State is in-memory only by design — a restart forgetting refusal
 *    timestamps is harmless.
 */

/**
 * Whole-message templates that claude-threads itself emits.
 *
 * The user-facing pieces vary (`**bold**` on Mattermost, `*bold*` on Slack;
 * a username rendered as `@alice`, `` `alice` `` or `<@U123>`), so those spots
 * are wildcards — everything else is matched literally and anchored at both
 * ends. Keep these in sync with the emit sites when a status post changes.
 */
const STATUS_POST_TEMPLATES: readonly RegExp[] = [
  // message-handler.ts / reaction-router.ts — paused-session resume refusal
  /^⚠️ \S+ is not authorized to resume this session$/u,
  // message-handler.ts — new-session authorization refusal
  /^⚠️ \S+ is not authorized$/u,
  // reaction-router.ts / lifecycle.ts — session capacity refusal
  /^⚠️ \*{0,2}Too busy\*{0,2} - \d+ sessions active\. Please try again later\.$/u,
  // message-handler.ts / commands/handler.ts — session cancelled notice
  /^🛑 \*{0,2}Session cancelled\*{0,2} by \S+$/u,
  // message-handler.ts — !kill broadcast, both shapes
  /^🔴 \*{0,2}EMERGENCY SHUTDOWN\*{0,2} (?:by \S+|initiated by \S+ - killing \d+ active sessions?)$/u,
  // lifecycle.ts — idle timeout notice
  /^⏱️ \*{0,2}Session timed out\*{0,2} after \d+ minutes of inactivity\n\n💡 React with 🔄 to resume, or send a new message to continue\.$/u,
  // message-handler.ts — !kill authorization refusal
  /^⛔ Only authorized users can use `\S+`$/u,
];

/**
 * True when `message` is verbatim one of claude-threads' own status posts.
 *
 * A partial match is deliberately not enough: quoting a status post, or
 * appending a question to it, is a human asking about the notice and must
 * still reach the session.
 */
export function isBotStatusPost(message: string): boolean {
  if (!message) return false;
  const trimmed = message.trim();
  return STATUS_POST_TEMPLATES.some((template) => template.test(trimmed));
}

/** How long one (thread, user) pair stays silenced after a refusal. */
const RESUME_REFUSAL_WINDOW_MS = 10 * 60 * 1000;

/**
 * Hard cap on tracked pairs. The window sweep already bounds the map in
 * practice; this bounds it even under a flood that never idles long enough
 * to expire an entry.
 */
const RESUME_REFUSAL_MAX_ENTRIES = 500;

/** key = `${threadId}:${username}` → epoch ms of the last refusal posted. */
const resumeRefusalPostedAt = new Map<string, number>();

/**
 * Whether the "not authorized to resume this session" refusal should be posted
 * for this (thread, user) pair, or suppressed as a repeat.
 *
 * Pure — it does not open the window. Call `recordResumeRefusal` *after* the
 * post succeeds, so a transient platform failure doesn't silence a legitimate
 * user for the rest of the window with nothing posted.
 *
 * @param now - epoch ms; injectable so tests can step past the window without
 *              sleeping. Production callers omit it.
 */
export function shouldPostResumeRefusal(
  threadId: string,
  username: string,
  now: number = Date.now(),
): boolean {
  for (const [seen, postedAt] of resumeRefusalPostedAt) {
    if (now - postedAt > RESUME_REFUSAL_WINDOW_MS) resumeRefusalPostedAt.delete(seen);
  }
  return !resumeRefusalPostedAt.has(`${threadId}:${username}`);
}

/** Open the suppression window for a refusal that was actually posted. */
export function recordResumeRefusal(
  threadId: string,
  username: string,
  now: number = Date.now(),
): void {
  resumeRefusalPostedAt.set(`${threadId}:${username}`, now);
  // Map iteration is insertion-ordered, so this drops the oldest entry.
  while (resumeRefusalPostedAt.size > RESUME_REFUSAL_MAX_ENTRIES) {
    const oldest = resumeRefusalPostedAt.keys().next();
    if (oldest.done) break;
    resumeRefusalPostedAt.delete(oldest.value);
  }
}

/** Test seam: clear the in-memory refusal window between tests. */
export function _resetResumeRefusalState(): void {
  resumeRefusalPostedAt.clear();
}
