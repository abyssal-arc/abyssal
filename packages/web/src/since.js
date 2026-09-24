/**
 * What changed in the tank while you were not looking at it.
 *
 * The visitor who adopts a whale and closes the tab comes back asking one
 * question: did anything happen to me? Answering it needs two observations of the
 * same address, and only one of them can come from the server. The other is ours:
 * the last `/who` answer this browser saw, kept on this device. So the baseline is
 * a memory, not a database — nothing is written to the tank's ledger, no read
 * turns into a write, and an address that has never visited has no history the
 * site invented for it.
 *
 * Three rules keep the answer honest:
 *
 *  1. *A disappearance is not a death.* The shelf is the visitor's own to empty,
 *     so an id that is simply gone from the list is not reported as killed — only
 *     an id that is still listed and no longer alive is.
 *  2. *Only the additions are news.* The server keeps the last 40 battle reports
 *     and shows one address the newest 8, so a report can fall out of the window
 *     without anything happening to the person who paid for it.
 *  3. *A row of an older shape is not a baseline.* `v` is checked, and a mismatch
 *     is reported as "no memory" rather than diffed field by field against
 *     whatever the previous version happened to store.
 *
 * Badges are deliberately not diffed. They are derived from the record, so a rule
 * change on our side would arrive as news about the visitor.
 */

/** Rows written by an earlier version are refused rather than reinterpreted. */
export const STANDING_V = 1;

/** How many changes fit in the drawer before the rest are counted, not dropped. */
export const SINCE_MAX = 5;

/** Worst news first, and never the order an object's keys happened to arrive in. */
export const KIND_ORDER = ['lost', 'added', 'report', 'burn', 'passTo', 'passGone', 'rank', 'cheer'];

/**
 * Reduce a `/who` answer to the fields a later answer can be compared with, plus
 * when we saw it. The tick and the day come from the snapshot, not from `/who`,
 * which describes an address rather than a moment.
 */
export function standingSeed(who, seen = {}) {
  return {
    v: STANDING_V,
    address: (who?.address ?? '').toLowerCase(),
    seenTick: Number.isFinite(seen.tick) ? seen.tick : null,
    seenDay: Number.isFinite(seen.day) ? seen.day : null,
    burned: num(who?.burned),
    burns: num(who?.burns),
    rank: who?.rank ?? null,
    cheer: who?.cheer ?? null,
    passActive: !!who?.pass?.active,
    passUntil: num(who?.pass?.until),
    adopted: (who?.adoptions ?? []).map((a) => ({
      id: a.id,
      name: a.name,
      archetype: a.archetype ?? '',
      alive: !!a.alive,
    })),
    reports: (who?.reports ?? []).map((r) => ({
      tx: r.tx,
      type: r.type,
      affected: num(r.affected),
      score: r.score ?? null,
    })),
  };
}

/** The diff as items, ordered by `KIND_ORDER`. `null` means "there is nothing to compare". */
export function diffStanding(prev, next) {
  if (!prev || !next) return null;
  if (prev.v !== STANDING_V || next.v !== STANDING_V) return null;
  // Two different addresses in one comparison is a bug somewhere above us, and
  // every item below would be a claim about the wrong person.
  if (!prev.address || prev.address !== next.address) return null;

  const out = [];
  const prevAdopted = new Map((prev.adopted ?? []).map((a) => [a.id, a]));
  const nextAdopted = new Map((next.adopted ?? []).map((a) => [a.id, a]));

  for (const [id, before] of prevAdopted) {
    const now = nextAdopted.get(id);
    // Gone from the shelf entirely: their own doing, and not a fact about the tank.
    if (!now) continue;
    if (before.alive && !now.alive) {
      out.push({ kind: 'lost', id, name: now.name, archetype: now.archetype });
    }
  }
  for (const [id, now] of nextAdopted) {
    if (!prevAdopted.has(id)) {
      out.push({ kind: 'added', id, name: now.name, archetype: now.archetype });
    }
  }

  const seenTx = new Set((prev.reports ?? []).map((r) => r.tx));
  for (const r of next.reports ?? []) {
    if (!seenTx.has(r.tx)) out.push({ kind: 'report', ...r });
  }

  const burnDelta = num(next.burns) - num(prev.burns);
  if (burnDelta > 0) {
    out.push({
      kind: 'burn',
      n: burnDelta,
      // A counter that went backwards is not a negative amount spent; clamp it and
      // let the count carry the news.
      amount: Math.max(0, num(next.burned) - num(prev.burned)),
    });
  }

  if (next.passActive && (!prev.passActive || num(next.passUntil) > num(prev.passUntil))) {
    out.push({ kind: 'passTo', until: num(next.passUntil) });
  } else if (!next.passActive && prev.passActive) {
    out.push({ kind: 'passGone' });
  }

  if (prev.rank !== next.rank) out.push({ kind: 'rank', from: prev.rank ?? null, to: next.rank ?? null });
  if ((prev.cheer ?? null) !== (next.cheer ?? null)) {
    out.push({ kind: 'cheer', from: prev.cheer ?? null, to: next.cheer ?? null });
  }

  return out.sort((x, y) => KIND_ORDER.indexOf(x.kind) - KIND_ORDER.indexOf(y.kind));
}

/**
 * Split a diff into what fits and what was left out.
 *
 * `more` is counted from the full list rather than guessed, because "+2 more" that
 * is really "+5 more" is worse than no number at all.
 */
export function trimSince(items, max = SINCE_MAX) {
  const list = items ?? [];
  return { shown: list.slice(0, max), more: Math.max(0, list.length - max) };
}

/** Days, because the drawer already speaks in days. Falls back to nothing sensible. */
export function sinceDay(until, ticksPerDay) {
  if (!Number.isFinite(until) || !Number.isFinite(ticksPerDay) || ticksPerDay <= 0) return null;
  return Math.floor(until / ticksPerDay);
}

function num(v) {
  return Number.isFinite(v) ? v : 0;
}
