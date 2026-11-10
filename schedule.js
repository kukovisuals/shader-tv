// Deterministic broadcast schedule. Every viewer computes the same thing from
// (channel data, wall-clock time) — no server state.
//
// Each channel is an endless sequence of "cycles". A cycle plays every video in
// the channel once, in an order shuffled by a PRNG seeded with (channel id, cycle #).

export const EPOCH = Date.UTC(2026, 0, 1) / 1000; // first edition; each edition sets ch.from
const startOf = (ch) => ch.from ?? EPOCH;

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const cycleCache = new Map(); // `${id}:${cycle}` -> { order, starts }

function cycleFor(ch, cycle) {
  const key = `${startOf(ch)}:${ch.id}:${cycle}`;
  let c = cycleCache.get(key);
  if (c) return c;
  const rand = mulberry32(hashStr(ch.id) ^ Math.imul(cycle + 1, 2654435761));
  const order = ch.videos.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const starts = new Float64Array(order.length);
  let acc = 0;
  for (let i = 0; i < order.length; i++) { starts[i] = acc; acc += ch.videos[order[i]].d; }
  c = { order, starts };
  if (cycleCache.size > 200) cycleCache.clear();
  cycleCache.set(key, c);
  return c;
}

function slotFromIndex(ch, cycle, i) {
  const { order, starts } = cycleFor(ch, cycle);
  const video = ch.videos[order[i]];
  const start = startOf(ch) + cycle * ch.total + starts[i];
  return { video, start, end: start + video.d, cycle, index: i };
}

/** The program airing on `ch` at unix time `t` (seconds). */
export function slotAt(ch, t) {
  const since = t - startOf(ch);
  const cycle = Math.floor(since / ch.total);
  const pos = since - cycle * ch.total;
  const { starts } = cycleFor(ch, cycle);
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) { // last start <= pos
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid; else hi = mid - 1;
  }
  return slotFromIndex(ch, cycle, lo);
}

export function nextSlot(ch, slot) {
  const n = ch.videos.length;
  return slot.index + 1 < n ? slotFromIndex(ch, slot.cycle, slot.index + 1)
                            : slotFromIndex(ch, slot.cycle + 1, 0);
}

/** All programs overlapping [t0, t1). */
export function slotsBetween(ch, t0, t1) {
  const out = [];
  for (let s = slotAt(ch, t0); s.start < t1; s = nextSlot(ch, s)) out.push(s);
  return out;
}

/** Channels with `hours: [on, off]` only broadcast in that window of the viewer's local time. */
export function onAir(meta, date = new Date()) {
  if (!meta.hours) return true;
  if (new URLSearchParams(location.search).has("alwayson")) return true;
  const [on, off] = meta.hours, h = date.getHours();
  return on > off ? (h >= on || h < off) : (h >= on && h < off);
}
