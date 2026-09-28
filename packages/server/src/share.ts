import { censusChanges, type CensusDay } from './digest.js';

/**
 * The shareable surface: a small, self-contained HTML page for one thing in the
 * tank — a day the book committed, a creature, or the week that just ran — drawn
 * so that it looks like a poster when a person opens it and reads like a sentence
 * when a crawler unfurls the link.
 *
 * This module is deliberately pure. It takes display data that has already been
 * assembled and returns strings; it never reaches for the world, the store, or the
 * network, because the difference between "the number on this card" and "the
 * number on the chain" has to be checkable by reading one file, not by standing up
 * a tank. `handler.ts` does the assembling; the tests hand this fixed fixtures so
 * an assertion is about the card, not about a simulation that moves between runs.
 *
 * Everything below escapes what it interpolates. A creature's name is bought and
 * typed by a person (`customName` on the sim creature), so it is the one field on
 * these pages that is not ours, and this is the first place in the project that
 * writes HTML — every other route answers in JSON, where a name is just a string.
 * `escapeHtml` is therefore load-bearing, and the mutation battery guards it as
 * such rather than trusting a comment that says "we escape things".
 */

/**
 * Escape the five characters that let text end its own context.
 *
 * `&` first, or it would escape the escapes. The quotes are escaped too because
 * these strings land inside `content="…"` attributes on the `og:` tags as well as
 * in text nodes, and a name containing a double quote is a name that would
 * otherwise close its own attribute and start a new one.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Insert ASCII thousands separators. Deterministic, unlike `toLocaleString`. */
function groupDigits(n: number): string {
  const neg = n < 0;
  const digits = Math.abs(Math.round(n)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '-' : '') + grouped;
}

/** A UTC calendar day, e.g. `2026-09-27`, from a wall-clock millisecond stamp. */
function utcDay(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** `APE:12` (the committed `topPredator` shape) into a readable clause, or null. */
function topPredatorPhrase(top: string | null): { species: string; kills: number } | null {
  if (!top) return null;
  const idx = top.lastIndexOf(':');
  if (idx < 0) return null;
  const kills = Number(top.slice(idx + 1));
  if (!Number.isFinite(kills)) return null;
  return { species: top.slice(0, idx), kills };
}

/**
 * One card in the fact grid. `value` is already a display string (it may carry a
 * comma, a species name, a date); it is escaped at render time like everything else.
 */
export interface PosterFact {
  label: string;
  value: string;
  /** A tone recolors just this value — used to make "on chain" read as gold. */
  tone?: 'default' | 'gold' | 'danger' | 'dim';
}

/** A badge is the one-line status pill: what kind of thing this page is about. */
export interface PosterBadge {
  text: string;
  tone: 'chain' | 'live' | 'gone' | 'plain';
}

/**
 * A fully-assembled poster, before it becomes bytes. `title` and `description` are
 * both the visible headline pair and the `og:` pair — one source, so a link that
 * unfurls and a page that opens cannot quietly disagree about what they are showing.
 */
export interface PosterSpec {
  kind: 'day' | 'creature' | 'story' | 'notfound';
  title: string;
  description: string;
  /** Absolute, same-origin URL of THIS page (also `og:url` and the canonical). */
  url: string;
  eyebrow: string;
  headline: string;
  subline?: string;
  badge?: PosterBadge;
  facts: PosterFact[];
  /** Where the "open the live thing" link points in the SPA. */
  href: string;
  hrefLabel: string;
  footnote?: string;
  /** HTTP status to serve this under — a missing subject is a 404, not a 200. */
  status?: number;
}

// ---------------------------------------------------------------------------
// Spec builders. Each turns assembled facts into a PosterSpec; none touch I/O.
// ---------------------------------------------------------------------------

/** The committed numbers for one day, rendered as a day poster. */
export function buildDayPoster(row: CensusDay, opts: { origin: string }): PosterSpec {
  const url = `${opts.origin}/s/day/${row.day}`;
  const href = `/?view=observe&day=${row.day}${row.txHash ? '&verify=1' : ''}`;
  const predator = topPredatorPhrase(row.topPredator);
  const stamped = typeof row.txHash === 'string' && row.txHash.length > 0;

  const facts: PosterFact[] = [
    { label: 'Population', value: groupDigits(row.population) },
    { label: 'Total energy', value: groupDigits(row.totalEnergy) },
    { label: 'Born (cumulative)', value: groupDigits(row.born) },
    { label: 'Died (cumulative)', value: groupDigits(row.died) },
    { label: 'Predations', value: groupDigits(row.predations) },
    { label: 'Top predator', value: predator ? `${predator.species} · ${groupDigits(predator.kills)} kills` : 'none', tone: 'gold' },
  ];

  const speciesLine = Object.entries(row.byArchetype)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([a, n]) => `${a} ${n}`)
    .join(' · ');
  if (speciesLine) facts.push({ label: 'Who was there', value: speciesLine, tone: 'dim' });

  const when = utcDay(row.ts);
  const description = stamped
    ? `Day ${row.day} on Arc: ${groupDigits(row.population)} creatures, ${groupDigits(row.predations)} predations, top predator ${predator ? `${predator.species} (${predator.kills})` : 'none'}. Committed to the chain — verifiable.`
    : `Day ${row.day} in the tank: ${groupDigits(row.population)} creatures, ${groupDigits(row.predations)} predations. Not yet on chain.`;

  return {
    kind: 'day',
    title: `ABYSSAL · Day ${row.day}`,
    description,
    url,
    eyebrow: `ANCHORED DAY · ${when}`,
    headline: `Day ${row.day}`,
    subline: `${groupDigits(row.population)} creatures, one shared history`,
    badge: stamped ? { text: 'On chain · verifiable', tone: 'chain' } : { text: 'In the book · not yet anchored', tone: 'plain' },
    facts,
    href,
    hrefLabel: stamped ? 'Verify this day →' : 'Open the tank →',
    footnote: stamped
      ? 'Every number above is inside the hash this transaction carries. Recompute it with GET /history/census and GET /verify.'
      : 'The row exists but its transaction does not yet. Day commitments are made when a day closes.',
    status: 200,
  };
}

/**
 * A creature's record, living or remembered. `facts` are the durable traits —
 * the things that do not change tick to tick — so the same link reads the same
 * whether or not the animal is still in the tank when it is opened.
 */
export function buildCreaturePoster(
  c: {
    id: number;
    name: string;
    /** True when `name` is a bought custom name, so the card can show the species codename. */
    customName?: boolean;
    codename?: string;
    archetype: string;
    generation: number;
    kills: number;
    offspring: number;
    alive: boolean;
    legendary?: boolean;
  },
  opts: { origin: string },
): PosterSpec {
  const url = `${opts.origin}/s/creature/${c.id}`;
  const href = `/?view=world&creature=${c.id}`;
  const facts: PosterFact[] = [
    { label: 'Species', value: c.archetype },
    { label: 'Generation', value: groupDigits(c.generation), tone: c.legendary ? 'gold' : 'default' },
    { label: 'Kills', value: groupDigits(c.kills) },
    { label: 'Offspring', value: groupDigits(c.offspring) },
  ];
  const headline = c.name;
  const subline = c.customName && c.codename ? `${c.archetype} · once ${c.codename}` : `${c.archetype} · #${c.id}`;
  const badge = c.alive
    ? { text: c.legendary ? 'Legendary · alive in the tank' : 'Alive in the tank', tone: 'live' as const }
    : { text: 'Remembered · no longer in the tank', tone: 'gone' as const };

  return {
    kind: 'creature',
    title: `ABYSSAL · ${headline}`,
    description: `${headline} — ${subline}. Generation ${groupDigits(c.generation)}, ${groupDigits(c.kills)} kills, ${groupDigits(c.offspring)} offspring. ${c.alive ? 'Swimming in' : 'Remembered from'} the abyssal tank on Arc.`,
    url,
    eyebrow: c.alive ? 'RESIDENT' : 'IN MEMORIAM',
    headline,
    subline,
    badge,
    facts,
    href,
    hrefLabel: c.alive ? 'Find it in the tank →' : 'Open the tank →',
    footnote: 'Names in this tank are bought with a burn; a custom name here was paid for on chain.',
    status: 200,
  };
}

/**
 * The facts a week poster states, derived from the day book. Public so the story
 * builder and the tests share one definition of "what the recap says".
 */
export interface StoryFacts {
  fromDay: number;
  toDay: number;
  days: number;
  anchored: number;
  populationStart: number;
  populationEnd: number;
  populationDelta: number;
  /** Sum of per-day births, or null if any day in the window was a reseed. */
  births: number | null;
  deaths: number | null;
  predations: number | null;
  /** Species seen earlier in the window and gone by its end. */
  lost: string[];
  /** Species absent at the window's start and present by its end. */
  gained: string[];
  topPredator: string | null;
  /** Wall clock of the newest row, for a "recorded" date. */
  lastTs: number;
}

/**
 * Summarize the last `window` closed days of the book.
 *
 * The one non-obvious decision: `births`/`deaths`/`predations` are only summed
 * when every day in the window could be differenced at all. `censusChanges`
 * returns `null` for a counter that ran backwards (a reseed — a different tank
 * wearing the same day numbers), and adding across that would turn "we do not
 * know" into a confident number, which is the exact failure the day book refuses
 * everywhere else. So a reseed inside the window makes the whole flow figure
 * `null`, and the card says it does not know rather than showing a sum.
 */
export function buildStoryFacts(rows: readonly CensusDay[], window = 7): StoryFacts | null {
  const book = rows.slice(-Math.max(2, window));
  if (book.length < 2) return null;
  const changes = censusChanges(book);
  const first = book[0];
  const last = book[book.length - 1];

  const sumOrNull = (pick: (c: (typeof changes)[number]) => number | null): number | null => {
    let total = 0;
    let anyNull = false;
    for (const c of changes) {
      const v = pick(c);
      if (v === null) anyNull = true;
      else total += v;
    }
    return anyNull ? null : total;
  };

  const lostSet = new Set<string>();
  const gainedSet = new Set<string>();
  for (const c of changes) {
    for (const a of c.gained) gainedSet.add(a);
    // A species is "lost" only if no later row in the window has it again.
    for (const a of c.lost) if (!changes.slice(changes.indexOf(c) + 1).some((l) => (l.gained ?? []).includes(a))) lostSet.add(a);
  }
  // Also: present at the start, gone for the rest of the window entirely.
  for (const [a, n] of Object.entries(first.byArchetype)) {
    if (n > 0 && !book.slice(1).some((r) => (r.byArchetype[a] ?? 0) > 0)) lostSet.add(a);
  }
  for (const a of [...lostSet]) if ((last.byArchetype[a] ?? 0) > 0) lostSet.delete(a);

  return {
    fromDay: first.day,
    toDay: last.day,
    days: last.day - first.day + 1,
    anchored: book.filter((r) => typeof r.txHash === 'string' && r.txHash.length > 0).length,
    populationStart: first.population,
    populationEnd: last.population,
    populationDelta: last.population - first.population,
    births: sumOrNull((c) => c.born),
    deaths: sumOrNull((c) => c.died),
    predations: sumOrNull((c) => c.predations),
    lost: [...lostSet].sort(),
    gained: [...gainedSet].sort(),
    topPredator: last.topPredator,
    lastTs: last.ts,
  };
}

/** The week recap: a story card built from `buildStoryFacts`. */
export function buildStoryPoster(facts: StoryFacts, opts: { origin: string }): PosterSpec {
  const url = `${opts.origin}/s/story`;
  const predator = topPredatorPhrase(facts.topPredator);
  const fmt = (n: number | null): string => (n === null ? 'unknown' : groupDigits(n));
  const delta = `${facts.populationDelta >= 0 ? '+' : '−'}${groupDigits(Math.abs(facts.populationDelta))}`;

  const cardFacts: PosterFact[] = [
    { label: 'Days', value: groupDigits(facts.days) },
    { label: 'On chain', value: `${groupDigits(facts.anchored)} of ${groupDigits(facts.days)}`, tone: 'gold' },
    { label: 'Population', value: `${groupDigits(facts.populationStart)} → ${groupDigits(facts.populationEnd)} (${delta})` },
    { label: 'Births', value: fmt(facts.births) },
    { label: 'Deaths', value: fmt(facts.deaths) },
    { label: 'Predations', value: fmt(facts.predations) },
  ];
  if (facts.lost.length) cardFacts.push({ label: 'Went extinct', value: facts.lost.join(', '), tone: 'danger' });
  if (facts.gained.length) cardFacts.push({ label: 'Emerged', value: facts.gained.join(', '), tone: 'gold' });
  if (predator) cardFacts.push({ label: 'Top predator', value: `${predator.species} · ${groupDigits(predator.kills)} kills`, tone: 'gold' });

  const span = `Day ${facts.fromDay}–${facts.toDay}`;
  const storyBits: string[] = [];
  storyBits.push(`${facts.anchored} of ${facts.days} days anchored on chain`);
  if (facts.predations !== null) storyBits.push(`${groupDigits(facts.predations)} predations`);
  if (facts.lost.length) storyBits.push(`${facts.lost.join(', ')} went extinct`);
  if (facts.gained.length) storyBits.push(`${facts.gained.join(', ')} emerged`);

  return {
    kind: 'story',
    title: `ABYSSAL · ${span}`,
    description: `A week in the tank: ${storyBits.join(', ')}. Every number committed to Arc and independently verifiable.`,
    url,
    eyebrow: `A WEEK IN THE TANK · ${utcDay(facts.lastTs)}`,
    headline: span,
    subline: storyBits[0] ?? 'the numbers, committed',
    badge: { text: 'Derived from the day book', tone: 'chain' },
    facts: cardFacts,
    href: '/?view=observe&drawer=mem',
    hrefLabel: 'Read the whole day book →',
    footnote: 'This recap is computed from consecutive rows of the published day book — the same rows /verify checks against the chain. Nothing here is stored; re-run censusChanges() on the book to disagree.',
    status: 200,
  };
}

/** A named thing that is not there. Honest about what it looked for, status 404. */
export function buildNotFoundPoster(kind: string, ident: string, opts: { origin: string }): PosterSpec {
  const url = `${opts.origin}/s/${kind}/${encodeURIComponent(ident)}`;
  return {
    kind: 'notfound',
    title: 'ABYSSAL · nothing to share yet',
    description: `There is no ${kind} ${ident} to show — it may not have happened, or it may have outlived the tank's memory.`,
    url,
    eyebrow: 'NOTHING HERE',
    headline: 'Nothing to share yet',
    subline: `${kind} ${ident} is not in the book`,
    badge: { text: 'Not found', tone: 'plain' },
    facts: [],
    href: '/?view=world',
    hrefLabel: 'Open the tank →',
    footnote: 'A creature id is not a permanent handle, and a day is only in the book once it has closed. This is not an error in your link so much as a fact about time.',
    status: 404,
  };
}

// ---------------------------------------------------------------------------
// Rendering: one shell, one stylesheet, every interpolated string escaped.
// ---------------------------------------------------------------------------

const PALETTE = {
  bg0: '#020709',
  bg1: '#031015',
  accent: '#6fd6ff',
  gold: '#ffd166',
  danger: '#ff4d6d',
  dim: '#8ea6c0',
  text: '#e6f1ff',
  glass: 'rgba(10, 16, 29, 0.62)',
  border: 'rgba(120, 160, 220, 0.14)',
};

const TONE_COLOR: Record<NonNullable<PosterFact['tone']>, string> = {
  default: PALETTE.text,
  gold: PALETTE.gold,
  danger: PALETTE.danger,
  dim: PALETTE.dim,
};

const BADGE_STYLE: Record<NonNullable<PosterSpec['badge']>['tone'], string> = {
  chain: `color:${PALETTE.gold};border-color:${PALETTE.gold}55;background:${PALETTE.gold}12`,
  live: `color:${PALETTE.accent};border-color:${PALETTE.accent}55;background:${PALETTE.accent}12`,
  gone: `color:${PALETTE.dim};border-color:${PALETTE.border};background:transparent`,
  plain: `color:${PALETTE.dim};border-color:${PALETTE.border};background:transparent`,
};

function renderFact(f: PosterFact): string {
  const color = TONE_COLOR[f.tone ?? 'default'];
  return `<div class="fact"><div class="fl">${escapeHtml(f.label)}</div><div class="fv" style="color:${color}">${escapeHtml(f.value)}</div></div>`;
}

/** Turn a spec into a full, standalone HTML document. */
export function renderPoster(spec: PosterSpec, opts: { ogImage: string }): string {
  const badge = spec.badge
    ? `<span class="badge" style="${BADGE_STYLE[spec.badge.tone]}">${escapeHtml(spec.badge.text)}</span>`
    : '';
  const facts = spec.facts.length
    ? `<div class="grid">${spec.facts.map(renderFact).join('')}</div>`
    : '';
  const subline = spec.subline ? `<p class="sub">${escapeHtml(spec.subline)}</p>` : '';
  const footnote = spec.footnote ? `<p class="foot">${escapeHtml(spec.footnote)}</p>` : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(spec.title)}</title>
<link rel="canonical" href="${escapeHtml(spec.url)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="ABYSSAL" />
<meta property="og:title" content="${escapeHtml(spec.title)}" />
<meta property="og:description" content="${escapeHtml(spec.description)}" />
<meta property="og:url" content="${escapeHtml(spec.url)}" />
<meta property="og:image" content="${escapeHtml(opts.ogImage)}" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${escapeHtml(spec.title)}" />
<meta name="twitter:description" content="${escapeHtml(spec.description)}" />
<meta name="twitter:image" content="${escapeHtml(opts.ogImage)}" />
<meta name="theme-color" content="${PALETTE.bg0}" />
<style>
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: "Space Grotesk", "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
    color: ${PALETTE.text};
    background:
      radial-gradient(ellipse at 50% -10%, #0a1322 0%, ${PALETTE.bg0} 60%),
      linear-gradient(180deg, ${PALETTE.bg1}, ${PALETTE.bg0});
    min-height: 100%;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .card {
    width: 100%; max-width: 620px;
    background: ${PALETTE.glass};
    border: 1px solid ${PALETTE.border};
    border-radius: 18px;
    padding: 34px 34px 26px;
    box-shadow: inset 0 1px 0 rgba(111, 214, 255, 0.08), 0 24px 70px rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(18px) saturate(1.4);
    position: relative; overflow: hidden;
  }
  .card::before {
    content: ""; position: absolute; inset: 0 0 auto 0; height: 1px;
    background: linear-gradient(to right, transparent, ${PALETTE.accent}55, transparent);
  }
  .eyebrow { letter-spacing: 0.18em; font-size: 11px; text-transform: uppercase; color: ${PALETTE.accent}; opacity: 0.85; }
  h1 { font-size: 40px; line-height: 1.05; margin: 10px 0 4px; font-weight: 600; }
  .sub { margin: 0 0 16px; color: ${PALETTE.dim}; font-size: 15px; }
  .badge { display: inline-block; font-size: 12px; padding: 5px 11px; border-radius: 999px; border: 1px solid; margin-bottom: 20px; letter-spacing: 0.02em; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 22px; margin: 4px 0 20px; }
  .fact { border-top: 1px solid ${PALETTE.border}; padding-top: 8px; }
  .fl { font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; color: ${PALETTE.dim}; margin-bottom: 3px; }
  .fv { font-size: 19px; font-variant-numeric: tabular-nums; font-weight: 500; }
  .foot { font-size: 12px; line-height: 1.5; color: ${PALETTE.dim}; margin: 18px 0 0; }
  .bar { display: flex; align-items: center; justify-content: space-between; margin-top: 22px; padding-top: 16px; border-top: 1px solid ${PALETTE.border}; }
  .brand { font-weight: 700; letter-spacing: 0.14em; font-size: 13px; color: ${PALETTE.text}; }
  .brand span { color: ${PALETTE.accent}; }
  a.cta { color: ${PALETTE.bg0}; background: ${PALETTE.accent}; text-decoration: none; font-weight: 600; font-size: 14px; padding: 9px 15px; border-radius: 10px; }
  a.cta:hover { filter: brightness(1.08); }
  @media (max-width: 460px) { .grid { grid-template-columns: 1fr; } h1 { font-size: 32px; } }
</style>
</head>
<body>
  <main class="card">
    <div class="eyebrow">${escapeHtml(spec.eyebrow)}</div>
    <h1>${escapeHtml(spec.headline)}</h1>
    ${subline}
    ${badge}
    ${facts}
    ${footnote}
    <div class="bar">
      <div class="brand">ABYSS<span>AL</span></div>
      <a class="cta" href="${escapeHtml(spec.href)}">${escapeHtml(spec.hrefLabel)}</a>
    </div>
  </main>
</body>
</html>`;
}
