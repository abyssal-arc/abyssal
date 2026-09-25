/**
 * The world's own "what happened while you were away".
 *
 * `since.js` answers that question for one address, off a `/who` answer. This
 * answers it for the tank, off the day book — which is the only part of the
 * world's past that outlives the reading it was taken from. Everything else a
 * returning visitor might be told (who was born, who died, which battles were
 * fought) lives in a ring that is already half-evicted by the time they come
 * back a week later, so this file does not pretend to know it: a day's row is
 * written once, its numbers never move, and its `txHash` arrives at most once
 * afterwards. Those three facts are the whole surface this diff is allowed to
 * speak about.
 *
 * Like `since.js`, the memory is kept on the visitor's device. Nothing here is
 * a server read that turns into a write, and an address that has never visited
 * has no history this site invented for it.
 *
 * Pure by construction: `worldSeed` takes a payload, `diffWorld` takes two seeds
 * plus the server's own per-day change list, and neither draws, fetches or
 * decides what a sentence should look like.
 */

/** Bumping this is a statement that stored baselines no longer mean the same thing. */
export const WORLD_SINCE_V = 1;

/** Worst news first; the order is the drawer's, not an object key's. */
export const WORLD_KIND_ORDER = ['extinct', 'days', 'population', 'emerged', 'anchored', 'net'];

/**
 * Reduce a `/history/census` payload to what a later payload can be compared
 * with. Only the fields `diffWorld` actually reads are kept, and nothing else:
 * the rows in between are the server's answer to `changes`, so re-storing them
 * here would be a second copy of a number that can be asked for, and a stored
 * field no comparison consults is a field nobody notices going stale.
 */
export function worldSeed(payload) {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  const last = rows[rows.length - 1];
  let anchoredThrough = null;
  // Counted off the rows in hand, not off `coverage`: a day whose transaction is
  // still on its way has no hash, and a row that predates the book keeping hashes
  // has none either. Neither is news on the next visit.
  for (const r of rows) if (typeof r.txHash === 'string' && r.txHash.startsWith('0x')) anchoredThrough = r.day;
  return {
    v: WORLD_SINCE_V,
    lastDay: Number.isFinite(last?.day) ? last.day : null,
    population: Number.isFinite(last?.population) ? last.population : null,
    byArchetype: { ...(last?.byArchetype ?? {}) },
    anchoredThrough,
    // Where the book's own window starts, so a later visit can tell "you were
    // away for two days" from "you were away for longer than this tank keeps".
    coverageFirst: Number.isFinite(payload?.coverage?.first) ? payload.coverage.first : null,
  };
}

/**
 * The diff as items, ordered by `WORLD_KIND_ORDER`. `null` means "there is
 * nothing honest to say", which is a frequent answer and never a failure:
 *
 *  - no baseline yet (a first visit), or a baseline of another shape;
 *  - the book went backwards, which cannot happen to a day that was written
 *    once — so it means the tank was replaced, and comparing across that would
 *    print a story about a world that never existed;
 *  - zero closed days between the two readings, which is the common case and
 *    says nothing.
 */
export function diffWorld(prev, next, changes) {
  if (!prev || !next) return null;
  if (prev.v !== WORLD_SINCE_V || next.v !== WORLD_SINCE_V) return null;
  if (!Number.isFinite(prev.lastDay) || !Number.isFinite(next.lastDay)) return null;
  if (next.lastDay < prev.lastDay) return null;

  const out = [];
  const span = next.lastDay - prev.lastDay;

  // Days the server has rows for, over exactly this span. `changes` is the
  // server's derivation from consecutive rows, so a species that vanished and
  // came back inside the window is reported as both, and this does not smooth
  // that into nothing.
  const inSpan = (changes ?? []).filter((c) => c.day > prev.lastDay && c.day <= next.lastDay);
  const emerged = [...new Set(inSpan.flatMap((c) => c.gained ?? []))].sort();
  const extinct = [...new Set(inSpan.flatMap((c) => c.lost ?? []))].sort();

  // Days the visitor never saw because the book no longer holds them. The
  // oldest row in the newer reading is the floor of what can still be spoken
  // about; anything under it was dropped by a trim, not by the tank ending.
  const trimmedBefore = Number.isFinite(next.coverageFirst) && prev.lastDay < next.coverageFirst
    ? next.coverageFirst - prev.lastDay
    : 0;

  if (extinct.length) out.push({ kind: 'extinct', species: extinct, trimmed: trimmedBefore > 0 });
  // The tank's clock, not a row count: `n` is how many day boundaries passed,
  // whether or not the book caught every one of them. A reading missing from the
  // middle of the window is said by the gap lines the same card draws above this,
  // which are derived from the rows; this item is derived from the two edges and
  // cannot see the difference between a gap and a trim.
  if (span > 0) {
    out.push({
      kind: 'days',
      n: span,
      from: prev.lastDay,
      to: next.lastDay,
      partial: trimmedBefore > 0,
      trimmed: trimmedBefore,
    });
  }
  // The two edges again, so a count that dipped and came back is not reported
  // here — the seed stores no middle. That is not the dip going unmentioned: a
  // species that vanished inside the span reaches `extinct`, which is the
  // server's per-day statement rather than this file's arithmetic.
  if (Number.isFinite(prev.population) && Number.isFinite(next.population) && next.population !== prev.population && span > 0) {
    out.push({ kind: 'population', from: prev.population, to: next.population, delta: next.population - prev.population });
  }
  if (emerged.length) out.push({ kind: 'emerged', species: emerged, trimmed: trimmedBefore > 0 });
  // Newly *confirmed*, which is a different sentence from newly closed: a day can
  // be in the book for hours before its transaction lands.
  //
  // The watermark and not a count. How many rows gained a hash since the last look
  // is not something two maxima can be subtracted with: a trim drops rows that
  // were already stamped, and a day can be stamped long after the day itself
  // closed — either way a difference of days would print a number nobody observed.
  const prevThrough = Number.isFinite(prev.anchoredThrough) ? prev.anchoredThrough : null;
  if (Number.isFinite(next.anchoredThrough) && (prevThrough === null || next.anchoredThrough > prevThrough)) {
    out.push({ kind: 'anchored', from: prevThrough, to: next.anchoredThrough });
  }

  // The net over the species the last row counts. Held apart from `emerged`/
  // `extinct` on purpose: the former two are per-species statements about days in
  // between, this is the arithmetic of the two edges, and a day that both lost
  // and gained something is where the two disagree.
  const keys = [...new Set([...Object.keys(prev.byArchetype ?? {}), ...Object.keys(next.byArchetype ?? {})])];
  if (span > 0 && keys.some((k) => (prev.byArchetype?.[k] ?? 0) !== (next.byArchetype?.[k] ?? 0))) {
    out.push({
      kind: 'net',
      // The biggest move first, and the alphabet only to break a tie: the line
      // names three species and counts the rest, so the order decides who gets
      // named, and a name is a worse reason than a number.
      perSpecies: keys
        .map((k) => ({ species: k, from: prev.byArchetype?.[k] ?? 0, to: next.byArchetype?.[k] ?? 0 }))
        .filter((r) => r.from !== r.to)
        .sort((a, b) => Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || a.species.localeCompare(b.species)),
    });
  }

  return out.sort((x, y) => WORLD_KIND_ORDER.indexOf(x.kind) - WORLD_KIND_ORDER.indexOf(y.kind));
}
