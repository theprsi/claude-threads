/**
 * Tests for loop-safety.ts (#491)
 *
 * The failure these guard against: bot A's "not authorized to resume this
 * session" refusal @-mentioned bot B, which woke B, which replied, which
 * re-triggered A — 1,941 messages in 37 minutes. Two bots, nothing
 * self-limiting.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  isBotStatusPost,
  shouldPostResumeRefusal,
  recordResumeRefusal,
  _resetResumeRefusalState,
} from './loop-safety.js';

/** The production sequence: ask, then record only once the post landed. */
function refuse(threadId: string, username: string, now?: number): boolean {
  const allowed = now === undefined
    ? shouldPostResumeRefusal(threadId, username)
    : shouldPostResumeRefusal(threadId, username, now);
  if (allowed) {
    if (now === undefined) recordResumeRefusal(threadId, username);
    else recordResumeRefusal(threadId, username, now);
  }
  return allowed;
}

describe('isBotStatusPost', () => {
  describe('recognizes claude-threads own status posts', () => {
    const statusPosts: [string, string][] = [
      ['resume refusal (code-formatted name)', '⚠️ `bot-b` is not authorized to resume this session'],
      ['resume refusal (legacy @mention name)', '⚠️ @bot-b is not authorized to resume this session'],
      ['resume refusal (Slack mention name)', '⚠️ <@U0123ALICE> is not authorized to resume this session'],
      ['short authorization refusal', '⚠️ `bot-b` is not authorized'],
      ['capacity refusal (Mattermost bold)', '⚠️ **Too busy** - 5 sessions active. Please try again later.'],
      ['capacity refusal (Slack bold)', '⚠️ *Too busy* - 5 sessions active. Please try again later.'],
      ['session cancelled', '🛑 **Session cancelled** by @alice'],
      ['emergency shutdown broadcast', '🔴 **EMERGENCY SHUTDOWN** by @alice'],
      [
        'emergency shutdown origin post',
        '🔴 **EMERGENCY SHUTDOWN** initiated by @alice - killing 3 active sessions',
      ],
      [
        'session timeout',
        '⏱️ **Session timed out** after 30 minutes of inactivity\n\n💡 React with 🔄 to resume, or send a new message to continue.',
      ],
      ['kill authorization refusal', '⛔ Only authorized users can use `!kill`'],
    ];

    for (const [label, message] of statusPosts) {
      test(label, () => {
        expect(isBotStatusPost(message)).toBe(true);
      });
    }
  });

  describe('lets human messages through', () => {
    // The maintainer's two explicit asks on #491: leading-emoji-only matching
    // is a false-positive generator, so neither of these may be dropped.
    test('a human message that merely starts with the warning emoji', () => {
      expect(isBotStatusPost('⚠️ careful, the migration is not authorized yet — can you check?')).toBe(false);
    });

    test('a human quoting a status post to ask about it', () => {
      const quoted =
        '> ⚠️ `bot-b` is not authorized to resume this session\n\nwhy did this happen? can you fix it?';
      expect(isBotStatusPost(quoted)).toBe(false);
    });

    test('a human pasting a status post and appending a question', () => {
      expect(
        isBotStatusPost('⚠️ `bot-b` is not authorized to resume this session — what does this mean?'),
      ).toBe(false);
    });

    test('a plain request', () => {
      expect(isBotStatusPost('@claude-bot please run the tests')).toBe(false);
    });

    test('an empty message', () => {
      expect(isBotStatusPost('')).toBe(false);
    });

    test('a message that only shares the leading emoji of the timeout notice', () => {
      expect(isBotStatusPost('⏱️ how long until this times out?')).toBe(false);
    });
  });

  test('tolerates surrounding whitespace on a real status post', () => {
    expect(isBotStatusPost('  ⚠️ `bot-b` is not authorized to resume this session  ')).toBe(true);
  });
});

describe('shouldPostResumeRefusal / recordResumeRefusal', () => {
  beforeEach(() => {
    _resetResumeRefusalState();
  });

  test('allows the first refusal for a (thread, user) pair', () => {
    expect(refuse('thread1', 'bot-b')).toBe(true);
  });

  test('the check alone does not open the window — only recording does', () => {
    // A refusal whose post throws must not silence the pair; the call sites
    // record after the await for exactly this reason.
    expect(shouldPostResumeRefusal('thread1', 'bot-b')).toBe(true);
    expect(shouldPostResumeRefusal('thread1', 'bot-b')).toBe(true);
    recordResumeRefusal('thread1', 'bot-b');
    expect(shouldPostResumeRefusal('thread1', 'bot-b')).toBe(false);
  });

  test('suppresses a repeat inside the window', () => {
    expect(refuse('thread1', 'bot-b')).toBe(true);
    expect(refuse('thread1', 'bot-b')).toBe(false);
    expect(refuse('thread1', 'bot-b')).toBe(false);
  });

  test('allows one again after the window has passed', () => {
    const t0 = 1_700_000_000_000;
    expect(refuse('thread1', 'bot-b', t0)).toBe(true);
    expect(refuse('thread1', 'bot-b', t0 + 9 * 60_000)).toBe(false);
    // A human who wanders back later must still be told why nothing happened.
    expect(refuse('thread1', 'bot-b', t0 + 11 * 60_000)).toBe(true);
  });

  test('scopes the window per thread and per user', () => {
    expect(refuse('thread1', 'bot-b')).toBe(true);
    expect(refuse('thread2', 'bot-b')).toBe(true);
    expect(refuse('thread1', 'alice')).toBe(true);
    expect(refuse('thread1', 'bot-b')).toBe(false);
  });

  test('stays bounded under a flood that never idles out of the window', () => {
    const t0 = 1_700_000_000_000;
    for (let i = 0; i < 2000; i++) {
      expect(refuse(`thread${i}`, 'bot-b', t0)).toBe(true);
    }
    // The oldest keys are evicted, so the very first pair is allowed again —
    // the point is that the map cannot grow without limit.
    expect(refuse('thread0', 'bot-b', t0)).toBe(true);
  });
});
