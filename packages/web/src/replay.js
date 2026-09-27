/**
 * The offline replay: one downloaded file, played with no server under it.
 *
 * `GET /export?pass=…&kind=replay` hands back the two series the live observatory
 * is built on — the volume `pulse` and the individual USDC `flows` — as one JSON
 * document. That document is a snapshot of a fixed window, so it can be handed to
 * this page and replayed long after the window closed, on a machine with no
 * backend, no wallet and no day pass. The whole point of shipping it as a file is
 * that it stops depending on the thing that wrote it; a player that reached back
 * for the server to draw a frame would undo that.
 *
 * `buildReplay` is the read-only half: it turns the parsed payload into a single
 * chronologically-ordered timeline the player can sweep. Three ways a display
 * quietly lies about a file, and this refuses all three:
 *
 *   - *Inventing a timestamp.* A row with no readable `t` cannot be placed, and
 *     dropping it to `t = 0` pins it to the start of the window — a made-up event
 *     that then leads every replay. Such rows are counted as `dropped` and left on
 *     the timeline's floor where the player can say "N rows were skipped", so an
 *     unreadable file reads as unreadable rather than as a quiet one.
 *   - *Sorting by insertion order.* `pulse` and `flows` arrive as two arrays and
 *     each is already time-ordered, but the merge of the two is not. The timeline
 *     is sorted by `t`; a tie keeps pulse before flow, which is deterministic, so
 *     the same file replays the same way every time.
 *   - *Folding "empty" into "quiet".* A file that holds no usable events is not a
 *     window where nothing happened — it is a file with nothing to play. `empty`
 *     says which, and the player renders it as its own state rather than as a
 *     zero-length chart that looks identical to an idle market.
 *
 * @param {object|null|undefined} payload the parsed `abyssal-replay.json` body
 * @returns {{
 *   frames: { t: number, kind: 'pulse'|'flow', [k: string]: unknown }[],
 *   start: number|null,
 *   end: number|null,
 *   spanMs: number,
 *   count: number,
 *   dropped: number,
 *   totals: { transfers: number, volume: number, pulses: number, flows: number },
 *   empty: boolean,
 * }}
 */
export function buildReplay(payload) {
  const rows = [];
  let dropped = 0;
  const pulse = payload && Array.isArray(payload.pulse) ? payload.pulse : [];
  const flows = payload && Array.isArray(payload.flows) ? payload.flows : [];

  // A number the timeline may place a row by. Anything that is not a finite number
  // — absent, NaN, a string a future export turned a millisecond into — is dropped,
  // never coerced: `Number('')` is 0 and would put the row at the very start.
  const stamp = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

  for (const p of pulse) {
    const t = p ? stamp(p.t) : null;
    if (t === null) { dropped++; continue; }
    rows.push({
      t,
      kind: 'pulse',
      count: stamp(p.count) ?? 0,
      volume: stamp(p.volume) ?? 0,
      x402: stamp(p.x402) ?? 0,
      resolved: stamp(p.resolved) ?? 0,
    });
  }
  for (const f of flows) {
    const t = f ? stamp(f.t) : null;
    if (t === null) { dropped++; continue; }
    rows.push({
      t,
      kind: 'flow',
      amount: stamp(f.amount) ?? 0,
      from: typeof f.from === 'string' ? f.from : '',
      to: typeof f.to === 'string' ? f.to : '',
      venue: typeof f.venue === 'string' ? f.venue : null,
      x402: typeof f.x402 === 'boolean' ? f.x402 : null,
    });
  }

  // Sort by time; on equal timestamps keep pulse ahead of flow so the merge of two
  // independently-ordered arrays is stable rather than dependent on which loop ran
  // first. `Array#sort` is not guaranteed stable across every engine's history, so
  // the tie is broken explicitly instead of trusting it.
  rows.sort((a, b) => (a.t - b.t) || (a.kind === b.kind ? 0 : a.kind === 'pulse' ? -1 : 1));

  let transfers = 0;
  let volume = 0;
  let pulses = 0;
  let flowCount = 0;
  for (const r of rows) {
    if (r.kind === 'pulse') { pulses++; transfers += r.count; volume += r.volume; }
    else flowCount++;
  }

  const count = rows.length;
  return {
    frames: rows,
    start: count ? rows[0].t : null,
    end: count ? rows[count - 1].t : null,
    // Fewer than two events have no interval to speak of; 0 here is "no span",
    // not "an instant", and the player says so with its own word rather than a 0s.
    spanMs: count > 1 ? rows[count - 1].t - rows[0].t : 0,
    count,
    dropped,
    totals: { transfers, volume: Math.round(volume * 100) / 100, pulses, flows: flowCount },
    empty: count === 0,
  };
}

/**
 * What the playhead has revealed, sitting at one frame.
 *
 * The player sweeps `replay.frames` with an integer cursor; this is the readout it
 * owes at any cursor position — how far the sweep has reached and what has run by
 * then. It clamps rather than throwing: a scrub dragged past the end, or a cursor
 * set before a file loads, should land on the last (or first) real frame instead of
 * reading `undefined` off the array. An empty timeline reveals nothing and returns
 * null, which the player renders as "nothing to play" rather than "at event 0 of 0".
 *
 * @param {ReturnType<typeof buildReplay>} replay
 * @param {number} index the playhead's frame index
 * @returns {null|{
 *   index: number, t: number, shown: number, pulses: number, flows: number,
 *   transfers: number, volume: number,
 * }}
 */
export function revealThrough(replay, index) {
  const frames = replay && Array.isArray(replay.frames) ? replay.frames : [];
  if (!frames.length) return null;
  // A non-integer or non-finite cursor (an empty range input reads as NaN) falls to
  // the first frame; the range is otherwise clamped to a real index.
  const raw = Number.isFinite(index) ? index : 0;
  const to = Math.max(0, Math.min(frames.length - 1, Math.trunc(raw)));
  let pulses = 0;
  let flows = 0;
  let transfers = 0;
  let volume = 0;
  for (let i = 0; i <= to; i++) {
    const r = frames[i];
    if (r.kind === 'pulse') { pulses++; transfers += r.count; volume += r.volume; }
    else flows++;
  }
  return {
    index: to,
    t: frames[to].t,
    shown: to + 1,
    pulses,
    flows,
    transfers,
    volume: Math.round(volume * 100) / 100,
  };
}
