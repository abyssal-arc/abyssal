/**
 * Census maths: the day book in, drawable numbers out.
 *
 * Kept out of app.js for the same reason `format.js` exists. Drawing a stacked
 * area is not the hard part; the hard part is deciding what a missing day, a
 * missing species or a one-creature wobble *means*, and every one of those
 * decisions is a claim the chart makes to a viewer. A test can reach these; it
 * cannot reach a `ctx.fill()` sitting between two constants.
 *
 * The counts themselves are never recomputed here. `population` and
 * `byArchetype` arrive from the server already tied to one reading of the world
 * (see the day book in `packages/server/src/digest.ts`), so this file only ever
 * rearranges them.
 */

/** Below this many creatures per day, a line is not going anywhere. */
export const TREND_EPSILON_PER_DAY = 0.05;

/** Days between two readings that are not consecutive. */
export function censusGaps(rows) {
  const gaps = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].day - rows[i - 1].day !== 1) gaps.push({ after: rows[i - 1].day, before: rows[i].day });
  }
  return gaps;
}

/**
 * Stacked bands, one per archetype, in the order given.
 *
 * `unlisted` is the part of a day's published population that the archetypes we
 * know about do not account for — a species added after the row was written, or
 * a count that arrived without one. It is carried as its own band instead of
 * being dropped, because a stack that stops short of the population line is a
 * chart that contradicts the number printed above it, and the reader cannot tell
 * which one is lying.
 */
export function censusSeries(rows, archetypes) {
  const days = rows.map((r) => r.day);
  const counts = archetypes.map((a) => rows.map((r) => r.byArchetype?.[a] ?? 0));
  let run = rows.map(() => 0);
  const stacks = archetypes.map((a, i) => {
    const lo = run;
    run = lo.map((v, d) => v + counts[i][d]);
    return { archetype: a, lo, hi: run, values: counts[i] };
  });
  const unlisted = rows.map((r, d) => Math.max(0, r.population - run[d]));
  return { days, stacks, unlisted, totals: run, gaps: censusGaps(rows) };
}

/**
 * Extinctions and emergences as chart markers, oldest first.
 *
 * `lost`/`gained` are derived by the server from consecutive rows, so this only
 * flattens them. It does not re-decide anything: a species that dipped to zero
 * for one reading and came back is reported by the server as lost and gained,
 * and the chart says the same two things rather than quietly smoothing them out.
 *
 * On a day that both lost and gained something, the loss is listed first — the
 * order is stated rather than left to alphabetical luck, because the list ends up
 * as the text under the chart and "vanished, then something appeared" is the true
 * sentence about that day.
 */
const KIND_RANK = { lost: 0, gained: 1 };

export function censusEvents(changes) {
  const out = [];
  for (const c of changes ?? []) {
    for (const a of c.lost ?? []) out.push({ day: c.day, archetype: a, kind: 'lost' });
    for (const a of c.gained ?? []) out.push({ day: c.day, archetype: a, kind: 'gained' });
  }
  return out.sort((x, y) => x.day - y.day || KIND_RANK[x.kind] - KIND_RANK[y.kind]);
}

/**
 * One word for where a species is going, over the last `span` readings.
 *
 * `unknown` is a real answer and not a failure: one row cannot have a slope, and
 * a book that has been running for a single day does not know whether anything
 * is expanding. Rendering that as `steady` would be the chart equivalent of
 * guessing.
 */
export function censusTrend(rows, archetype, span = 7) {
  if (rows.length < 2) return { state: 'unknown', perDay: null, from: null, to: null };
  const first = rows[Math.max(0, rows.length - span)];
  const last = rows[rows.length - 1];
  const days = last.day - first.day;
  const a = first.byArchetype?.[archetype] ?? 0;
  const b = last.byArchetype?.[archetype] ?? 0;
  if (days <= 0) return { state: 'unknown', perDay: null, from: a, to: b };
  const perDay = (b - a) / days;
  // `gone` outranks `shrinking`: reaching zero is a different sentence, and a
  // viewer scanning for extinct species should not have to notice the number.
  const state = b === 0 && a > 0 ? 'gone'
    : perDay > TREND_EPSILON_PER_DAY ? 'expanding'
      : perDay < -TREND_EPSILON_PER_DAY ? 'shrinking'
        : 'steady';
  return { state, perDay, from: a, to: b };
}
