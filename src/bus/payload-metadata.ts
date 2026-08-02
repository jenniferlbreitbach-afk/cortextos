/**
 * payload-metadata.ts — Reduce injected content to content-free measurement
 * data at the call site.
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The usage ledger must record *how much* was injected. It must not record, and
 * must not be able to reconstruct, *what* was injected. Performing the
 * reduction here means the ledger module — which does file I/O, JSON
 * serialization, rotation, and error handling — never has raw prompt or message
 * text in scope, so a bug there cannot leak content.
 *
 * NO CONTENT-DERIVED IDENTIFIERS
 * ------------------------------
 * This module deliberately produces no hash, digest, excerpt, prefix, suffix,
 * or encoding of the payload. An unsalted digest of a short or predictable
 * message (a Telegram reply, a stock cron prompt) is a persistent fingerprint
 * of private data and is vulnerable to dictionary matching. Correlation and
 * deduplication must use pre-existing immutable identifiers — message ids, cron
 * names, request ids — never anything derived from content. Where no such
 * identifier exists, the ledger stores null.
 *
 * This module is pure: no I/O, no logging, and total — it cannot throw, so no
 * exception can carry the content it was given.
 */

/** Content-free measurement of an injected payload. */
export interface PayloadMetadata {
  /**
   * Size of the payload in UTF-8 bytes. `Buffer.byteLength`, not `String.length`
   * — the latter counts UTF-16 code units and undercounts multi-byte
   * characters (and miscounts astral-plane characters such as emoji), which
   * would systematically understate spend on non-ASCII traffic.
   */
  payloadBytes: number;
  /**
   * Number of discrete messages combined into this injection, when the caller
   * knows it. A fast-checker batch may carry several inbox and/or Telegram
   * messages in one PTY write. Null when not known.
   */
  messageCount: number | null;
}

/** Metadata used when a caller has no payload, or supplied something unusable. */
export const EMPTY_PAYLOAD: PayloadMetadata = Object.freeze({
  payloadBytes: 0,
  messageCount: null,
});

/**
 * Measure content. Total function: any input, including non-strings from an
 * un-typed caller, yields valid metadata rather than throwing — an exception
 * here could otherwise surface the content in a stack trace or error message.
 */
export function measurePayload(
  content: unknown,
  messageCount?: number | null,
): PayloadMetadata {
  const count = typeof messageCount === 'number' && Number.isFinite(messageCount) && messageCount >= 0
    ? Math.floor(messageCount)
    : null;

  if (typeof content !== 'string') {
    return { payloadBytes: 0, messageCount: count };
  }

  let payloadBytes: number;
  try {
    payloadBytes = Buffer.byteLength(content, 'utf8');
  } catch {
    payloadBytes = 0;
  }

  return { payloadBytes, messageCount: count };
}
