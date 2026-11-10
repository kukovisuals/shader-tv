// Fills in "title", "channel" and "duration" for every video in videos.json.
// Usage: node tools/fill-metadata.mjs [path/to/videos.json]
// Durations matter: the broadcast schedule is computed from them, so without
// them every video is assumed to be 10 minutes long.
import { readFile, writeFile } from "node:fs/promises";

const file = process.argv[2] ?? new URL("../videos.json", import.meta.url).pathname;
const json = JSON.parse(await readFile(file, "utf8"));
const channels = Array.isArray(json) ? null : json.channels ?? [json];
const lists = channels ? channels.map((c) => c.videos ?? []) : [json];

function youtubeId(link) {
  const s = String(link).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1, 12);
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    return u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/)?.[1] ?? null;
  } catch { return null; }
}

async function lookup(id) {
  const out = {};
  try {
    const r = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${id}`);
    if (r.ok) { const j = await r.json(); out.title = j.title; out.channel = j.author_name; }
  } catch {}
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${id}`, {
      headers: { "user-agent": "Mozilla/5.0", "accept-language": "en" },
    });
    const m = (await r.text()).match(/"lengthSeconds":"(\d+)"/);
    if (m) out.duration = Number(m[1]);
  } catch {}
  return out;
}

let done = 0, failed = 0;
for (const list of lists) {
  for (let i = 0; i < list.length; i++) {
    const o = typeof list[i] === "string" ? { url: list[i] } : list[i];
    const id = youtubeId(o.url ?? o.link ?? o.id);
    if (!id) { console.warn("skip (not a YouTube link):", list[i]); continue; }
    if (o.title && o.channel && o.duration) { list[i] = o; continue; }
    const info = await lookup(id);
    for (const k of ["title", "channel", "duration"]) o[k] ??= info[k];
    list[i] = o;
    if (o.duration) done++; else { failed++; console.warn("no duration for", id, "(private, deleted or region-locked?)"); }
    console.log(`${o.duration ?? "?"}s  ${o.title ?? id}`);
  }
}
await writeFile(file, JSON.stringify(json, null, 2) + "\n");
console.log(`\nUpdated ${file}: ${done} filled, ${failed} without duration.`);
