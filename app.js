import { slotAt, nextSlot, slotsBetween, onAir } from "./schedule.js";

const $ = (id) => document.getElementById(id);
const FILTERS = [
  { id: "off", name: "CLEAN" },
  { id: "crt", name: "CRT" },
  { id: "vhs", name: "VHS" },
  { id: "bw", name: "B&W 1962" },
];

const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const state = {
  editions: [],             // all weekly editions in lineup.json, by start time
  lineup: null,             // the edition on air now
  data: new Map(),          // "<edition path>/<channel id>" -> channel json
  idx: 0,                   // index into lineup.channels
  lastIdx: 0,
  powered: false,
  muted: store.get("hntv.muted", "0") === "1",
  captions: store.get("hntv.cc", "0") === "1",
  ccAppliedFor: null,      // video id captions were last applied to
  filter: Math.max(0, FILTERS.findIndex((f) => f.id === store.get("hntv.filter", "off"))),
  player: null,
  playerReady: null,
  loadedVid: null,
  slot: null,
  failed: false,            // current video errored (deleted / not embeddable)
  clockOffset: 0,           // server time - local time (s)
  digits: "",
  digitTimer: 0,
  theater: false,
  theaterFromFs: false,     // theater was switched on by entering fullscreen
};

const now = () => Date.now() / 1000 + state.clockOffset;
const chMeta = () => state.lineup.channels[state.idx];

// ---------- time sync: trust the server's Date header over the local clock ----------
async function syncClock() {
  try {
    const t0 = Date.now();
    const r = await fetch(location.pathname, { method: "HEAD", cache: "no-store" });
    const d = Date.parse(r.headers.get("date"));
    if (!isNaN(d)) {
      const rtt = Date.now() - t0;
      const off = (d + 500 + rtt / 2 - Date.now()) / 1000; // Date header has 1s resolution
      if (Math.abs(off) > 2) state.clockOffset = off;     // ignore sub-resolution noise
    }
  } catch {}
}

// ---------- data ----------
// Everything comes from one file: videos.json (see README.md for the format).
// It is turned into a single "edition" whose channels hold the parsed videos.
const VIDEOS_FILE = "videos.json";
const DEFAULT_DURATION = 600; // seconds, used when a video has no "duration" yet
const dataKey = (meta, ed) => `${ed.path ?? "v1"}/${meta.id}`;
const getData = (meta, ed = state.lineup) => state.data.get(dataKey(meta, ed));

/** Pull the 11-char video id out of any YouTube link (or accept a bare id). */
function youtubeId(link) {
  const s = String(link).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (u.hostname.endsWith("youtu.be")) return u.pathname.slice(1, 12);
    if (u.searchParams.get("v")) return u.searchParams.get("v").slice(0, 11);
    const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[1];
  } catch {}
  return null;
}

/** Start offset in seconds from a "start" field or the link's ?t= / &t= (e.g. 1362, "1362s", "22m42s"). */
function startOffset(o) {
  const parse = (x) => {
    if (x == null || x === "") return 0;
    if (/^\d+(\.\d+)?$/.test(String(x))) return Number(x);
    const m = String(x).match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
    return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
  };
  if (o.start != null) return parse(o.start);
  try { return parse(new URL(String(o.url ?? o.link)).searchParams.get("t")); } catch { return 0; }
}

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "ch";

/** videos.json -> { edition, channels data }. Accepts a list of links, {videos:[…]} or {channels:[…]}. */
function parseVideosFile(json) {
  const listed = Array.isArray(json) ? [{ videos: json }]
    : json.channels ?? [{ ...json, videos: json.videos ?? [] }];
  // "oneVideoPerChannel": true (top level or on a channel) gives every video its own channel,
  // named after the YouTube uploader, with the video title as the tagline.
  const splitAll = !Array.isArray(json) && json.oneVideoPerChannel === true;
  const rawChannels = listed.flatMap((c) => {
    if (!(splitAll || c.oneVideoPerChannel === true)) return [c];
    return (c.videos ?? []).map((item, k) => {
      const o = typeof item === "string" ? { url: item } : item;
      const who = String(o.channel ?? o.author ?? "").trim();
      return {
        num: k === 0 ? c.num : undefined,
        id: `yt-${youtubeId(o.url ?? o.link ?? o.id) ?? k}`,
        name: (who || o.title || "").toUpperCase() || undefined,
        tagline: o.title ?? "",
        hours: c.hours,
        videos: [item],
      };
    });
  });
  let estimated = false;
  const used = new Set();
  const metas = [], data = [];
  rawChannels.forEach((c, i) => {
    const videos = [];
    for (const item of c.videos ?? []) {
      const o = typeof item === "string" ? { url: item } : item;
      const v = youtubeId(o.url ?? o.link ?? o.id);
      if (!v) { console.warn("[videos.json] skipped, not a YouTube link:", item); continue; }
      // "duration" is the full video length; a start offset plays only the part after it.
      const s = startOffset(o);
      const full = Number(o.duration) > 0 ? Number(o.duration) : 0;
      const d = full > s ? full - s : DEFAULT_DURATION;
      if (!(full > s)) estimated = true;
      videos.push({ v, s, d, t: o.title ?? "", c: o.channel ?? o.author ?? "", q: o.quote, y: o.year, h: o.hn });
    }
    if (!videos.length) return;
    let num = Number(c.num) || (metas.length ? metas[metas.length - 1].num + 1 : 2);
    while (used.has(num)) num++;
    used.add(num);
    const id = c.id ?? slug(c.name ?? `ch${num}`);
    const total = videos.reduce((a, x) => a + x.d, 0);
    const meta = { num, id, name: c.name ?? `CHANNEL ${num}`, tagline: c.tagline ?? "", count: videos.length, total };
    if (Array.isArray(c.hours)) meta.hours = c.hours;
    metas.push(meta);
    data.push({ id, total, videos });
  });
  const edition = { from: Date.UTC(2026, 0, 1) / 1000, path: null, estimated, channels: metas };
  return { edition, data };
}

/** Fill in a missing title / channel name in the browser via YouTube oEmbed (only for videos on screen). */
const titleJobs = new Map();
function ensureTitle(x) {
  if (x.t && x.c) return Promise.resolve();
  if (!titleJobs.has(x.v)) titleJobs.set(x.v, (async () => {
    try {
      const r = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent("https://www.youtube.com/watch?v=" + x.v)}`);
      if (r.ok) { const j = await r.json(); x.t ||= j.title; x.c ||= j.author_name; }
    } catch {}
    x.t ||= `youtu.be/${x.v}`; x.c ||= "YouTube";
  })());
  return titleJobs.get(x.v);
}

async function loadVideos() {
  const r = await fetch(VIDEOS_FILE, { cache: "no-store" });
  if (!r.ok) throw new Error(`${VIDEOS_FILE}: HTTP ${r.status}`);
  const { edition, data } = parseVideosFile(await r.json());
  if (!edition.channels.length) throw new Error(`${VIDEOS_FILE} has no valid YouTube links`);
  state.data.clear();
  for (const ch of data) { ch.from = edition.from; state.data.set(dataKey(ch, edition), ch); }
  return [edition];
}

async function loadChannel(meta, ed = state.lineup) {
  return state.data.get(dataKey(meta, ed));
}

function editionAt(t) {
  let ed = state.editions[0];
  for (const e of state.editions) if (e.from <= t) ed = e;
  return ed;
}

async function refreshLineup() {} // single static videos.json: reload the page to pick up edits

/** Called every second: hop to the new edition when its start time arrives. */
async function checkEdition() {
  const ed = editionAt(now());
  if (!ed || ed === state.lineup || (ed.path === state.lineup.path && ed.from === state.lineup.from)) return;
  const id = chMeta()?.id;
  state.lineup = ed;
  const i = ed.channels.findIndex((c) => c.id === id);
  state.idx = i >= 0 ? i : 0;
  state.lastIdx = state.idx;
  $("estNotice").hidden = !ed.estimated;
  if (state.powered) {
    flashOSD("NEW WEEK ON HNTV", 4000);
    await tune(state.idx, { quiet: true });
    noise.burst(600);
  }
}

// ---------- YouTube player ----------
function ytReady() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player && window.YT.loaded) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev && prev(); resolve(); };
  });
}

function createPlayer() {
  state.playerReady = ytReady().then(() => new Promise((resolve) => {
    state.player = new YT.Player("player", {
      host: "https://www.youtube-nocookie.com",
      width: "100%", height: "100%",
      playerVars: {
        controls: 0, disablekb: 1, modestbranding: 1, rel: 0, iv_load_policy: 3,
        playsinline: 1, fs: 0, cc_load_policy: state.captions ? 1 : 0, cc_lang_pref: "en", origin: location.origin,
      },
      events: {
        onReady: () => resolve(state.player),
        onError: () => { state.failed = true; render(); },
        onStateChange: (e) => {
          // YouTube resets caption state per video, so re-apply ours once each program starts.
          if (e.data === YT.PlayerState.PLAYING && state.ccAppliedFor !== state.loadedVid) {
            state.ccAppliedFor = state.loadedVid;
            applyCaptions();
          }
          render();
        },
      },
    });
  }));
}

// ---------- static noise (video + audio) ----------
const noise = (() => {
  const c = $("static"), g = c.getContext("2d");
  const img = g.createImageData(c.width, c.height);
  let raf = 0, until = 0, actx = null, buf = null;
  function frame() {
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      d[i] = d[i + 1] = d[i + 2] = v; d[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    if (performance.now() < until) raf = requestAnimationFrame(frame);
    else { c.classList.remove("on"); raf = 0; }
  }
  function sound(ms) {
    if (state.muted) return;
    try {
      actx ??= new AudioContext();
      if (!buf) {
        buf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
        const ch = buf.getChannelData(0);
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      }
      const src = actx.createBufferSource(); src.buffer = buf;
      const bp = actx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.value = 3000; bp.Q.value = 0.4;
      const gain = actx.createGain();
      gain.gain.setValueAtTime(0.12, actx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, actx.currentTime + ms / 1000);
      src.connect(bp).connect(gain).connect(actx.destination);
      src.start(); src.stop(actx.currentTime + ms / 1000);
    } catch {}
  }
  return {
    burst(ms = 450, withSound = true) {
      until = Math.max(until, performance.now() + ms);
      c.classList.add("on");
      if (withSound) sound(ms);
      if (!raf) raf = requestAnimationFrame(frame);
    },
  };
})();

// ---------- UI helpers ----------
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const fmtDur = (s) => {
  s = Math.round(s);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
};
const pad2 = (n) => String(n).padStart(2, "0");

let osdTimer = 0;
function flashOSD(text, ms = 2500) {
  const el = $("osdCh");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => el.classList.remove("on"), ms);
}

let ltTimer = 0;
function showLowerThird(meta, slot) {
  const v = slot.video;
  $("ltNum").textContent = meta.num;
  $("ltName").textContent = meta.name;
  $("ltTitle").textContent = v.t;
  $("ltQuote").textContent = v.q ? `“${v.q}”${v.h ? " — HN" : v.y ? " —" : ""}${v.y ? (v.h ? ", " : " ") + v.y : ""}` : v.c;
  const el = $("lowerthird");
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add("on"));
  clearTimeout(ltTimer);
  ltTimer = setTimeout(() => { el.classList.remove("on"); setTimeout(() => (el.hidden = true), 600); }, 7000);
}

function setStandby(on, title = "PLEASE STAND BY", sub = "", bars = false) {
  const el = $("standby");
  el.hidden = !on;
  el.classList.toggle("with-bars", bars);
  $("standbyTitle").textContent = title;
  $("standbySub").textContent = sub;
}

function applyFilter() {
  const f = FILTERS[state.filter];
  $("screen").className = `screen filter-${f.id}`;
  $("fxName").textContent = `PICTURE: ${f.name}`;
  $("hudFx").textContent = f.name;
  $("knobFx").style.setProperty("--rot", `${state.filter * 70 - 105}deg`);
  store.set("hntv.filter", f.id);
}

function applyMute() {
  $("osdMute").hidden = !state.muted || !state.powered;
  store.set("hntv.muted", state.muted ? "1" : "0");
  if (!state.player?.mute) return;
  state.muted ? state.player.mute() : state.player.unMute();
}

// ---------- captions ----------
function applyCaptions() {
  const p = state.player;
  if (!p?.loadModule) return;
  try {
    if (state.captions) {
      p.loadModule("captions");
      p.setOption("captions", "track", { languageCode: "en" });
    } else {
      p.setOption("captions", "track", {});
      p.unloadModule("captions");
    }
  } catch {}
}

function toggleCaptions() {
  state.captions = !state.captions;
  store.set("hntv.cc", state.captions ? "1" : "0");
  document.querySelectorAll('[data-act="captions"]').forEach((b) => b.classList.toggle("on", state.captions));
  document.body.classList.toggle("cc-on", state.captions);
  if (!state.powered) return;
  applyCaptions();
  flashOSD(state.captions ? "CC ON" : "CC OFF", 1500);
  if (state.captions) {
    setTimeout(() => {
      let tracks;
      try { tracks = state.player.getOption("captions", "tracklist"); } catch {}
      if (state.captions && Array.isArray(tracks) && tracks.length === 0) flashOSD("NO CAPTIONS", 2000);
    }, 1500);
  }
}

// ---------- tuning ----------
async function tune(idx, { quiet = false } = {}) {
  const n = state.lineup.channels.length;
  idx = ((idx % n) + n) % n;
  if (idx !== state.idx) state.lastIdx = state.idx;
  state.idx = idx;
  store.set("hntv.ch", chMeta().id);
  if (state.powered) presence.changed();
  const meta = chMeta();
  $("led").textContent = pad2(meta.num);
  $("hudCh").textContent = pad2(meta.num);
  $("knobCh").style.setProperty("--rot", `${(idx / n) * 300 - 150}deg`);
  if (!state.powered) return;
  if (!quiet) noise.burst(500);
  flashOSD(`${pad2(meta.num)} ${meta.name}`);
  state.loadedVid = null; // force reload of whatever is airing
  state.failed = false;
  await loadChannel(meta);
  if (state.idx === idx) await sync(true);
}

/** Make the screen match the schedule. Called on tune and every second. */
async function sync(fromTune = false) {
  if (!state.powered) return;
  const meta = chMeta();
  const ch = getData(meta);
  if (!ch) return;
  const player = await state.playerReady;

  if (!onAir(meta)) {
    if (state.loadedVid !== "offair") {
      player.stopVideo();
      state.loadedVid = "offair";
      state.slot = null;
      setStandby(true, `${meta.name} IS OFF THE AIR`, `Broadcasting nightly ${meta.hours[0] % 12 || 12} PM – ${meta.hours[1]} AM your time`, true);
    }
    return render();
  }
  if (state.loadedVid === "offair") state.loadedVid = null;

  const t = now();
  const slot = slotAt(ch, t);
  const offset = t - slot.start;
  state.slot = slot;

  if (slot.video.v !== state.loadedVid) {
    if (!fromTune) noise.burst(350, false); // program change: brief interference
    state.loadedVid = slot.video.v;
    state.failed = false;
    setStandby(false);
    player.loadVideoById({ videoId: slot.video.v, startSeconds: slot.video.s + offset });
    applyMute();
    ensureTitle(slot.video).then(() => state.slot === slot && showLowerThird(meta, slot));
  } else if (!state.failed) {
    const ps = player.getPlayerState?.();
    if (ps === YT.PlayerState.PLAYING) {
      const drift = player.getCurrentTime() - (slot.video.s + offset);
      if (Math.abs(drift) > 5) player.seekTo(slot.video.s + offset, true);
    } else if (ps === YT.PlayerState.PAUSED || ps === YT.PlayerState.CUED) {
      player.playVideo(); // it's live TV: no pausing
    }
  }
  render();
}

// ---------- render info + standby ----------
function render() {
  const meta = state.lineup && chMeta();
  if (!meta) return;
  $("infoNum").textContent = pad2(meta.num);
  $("infoCh").textContent = meta.name;
  $("infoTag").textContent = meta.tagline;
  const slot = state.slot;
  $("now").hidden = !slot || !state.powered;
  $("ytLink").hidden = !slot || !state.powered;
  if (!slot || !state.powered) return;

  const t = now(), v = slot.video;
  const ch = getData(meta);
  if (!v.t || !v.c) ensureTitle(v).then(render);
  const ps = state.player?.getPlayerState?.();

  if (state.failed) setStandby(true, "SIGNAL LOST", `This program is unavailable. Next up at ${fmtTime(slot.end)}`);
  else if (ps === YT.PlayerState.ENDED) setStandby(true, "PLEASE STAND BY", `Next program at ${fmtTime(slot.end)}`);
  else if (state.loadedVid !== "offair") setStandby(false);

  $("nowTitle").textContent = v.t;
  $("nowMeta").textContent = `${v.c} · ${fmtTime(slot.start)} – ${fmtTime(slot.end)} · ${fmtDur(Math.max(0, slot.end - t))} left`;
  $("progressBar").style.width = `${Math.min(100, ((t - slot.start) / v.d) * 100)}%`;
  const q = $("nowQuote");
  if (v.q) {
    q.hidden = false;
    q.innerHTML = "";
    q.append(`“${v.q}”`);
    if (v.h) {
      const cite = document.createElement("a");
      cite.href = `https://news.ycombinator.com/item?id=${v.h}`;
      cite.target = "_blank"; cite.rel = "noopener";
      cite.textContent = ` — HN comment${v.y ? ", " + v.y : ""}`;
      q.append(cite);
    } else if (v.y) q.append(` — ${v.y}`);
  } else q.hidden = true;
  const nx = nextSlot(ch, slot);
  if (!nx.video.t) ensureTitle(nx.video).then(render);
  $("nextLine").textContent = `${fmtTime(nx.start)}  ${nx.video.t}`;
  $("ytLink").href = `https://www.youtube.com/watch?v=${v.v}&t=${Math.floor(v.s + t - slot.start)}s`;
}

// ---------- power ----------
async function power(on = !state.powered) {
  state.powered = on;
  const tube = $("tube");
  $("tv").classList.toggle("is-on", on);
  if (on) {
    $("poweroff").hidden = true;
    tube.classList.remove("turning-off");
    tube.classList.add("turning-on");
    setTimeout(() => tube.classList.remove("turning-on"), 900);
    applyMute();
    await tune(state.idx, { quiet: true });
    noise.burst(300);
    presence.start();
  } else {
    presence.stop();
    tube.classList.add("turning-off");
    state.player?.stopVideo?.();
    state.loadedVid = null;
    state.slot = null;
    setStandby(false);
    setTimeout(() => { if (!state.powered) { $("poweroff").hidden = false; tube.classList.remove("turning-off"); } }, 700);
    $("osdMute").hidden = true;
    render();
  }
}

// ---------- guide ----------
async function openGuide() {
  const g = $("guide");
  g.hidden = false;
  const grid = $("guideGrid");
  const SPAN = 3 * 3600;
  const t = now();
  const t0 = Math.floor(t / 1800) * 1800;
  const t1 = t0 + SPAN;
  // Editions on air during the guide window (usually one; two around Monday 00:00 UTC).
  const segs = state.editions
    .map((ed, k) => ({ ed, a: Math.max(t0, ed.from), b: Math.min(t1, state.editions[k + 1]?.from ?? Infinity) }))
    .filter((s) => s.a < s.b);
  await Promise.all(segs.flatMap(({ ed }) => ed.channels.map((m) => loadChannel(m, ed))));
  await Promise.all(segs.flatMap(({ ed, a, b }) => ed.channels.filter((m) => onAir(m)).flatMap((m) => {
    const ch = getData(m, ed);
    return ch ? slotsBetween(ch, a, b).map((s) => ensureTitle(s.video)) : [];
  })));
  const pct = (x) => ((Math.max(t0, Math.min(t1, x)) - t0) / SPAN) * 100;

  const frag = document.createDocumentFragment();
  const head = document.createElement("div");
  head.className = "g-row g-head";
  head.innerHTML = `<div class="g-ch"></div><div class="g-track"></div>`;
  for (let s = t0; s < t1; s += 1800) {
    const c = document.createElement("span");
    c.style.left = `${pct(s)}%`;
    c.textContent = fmtTime(s);
    head.lastChild.append(c);
  }
  const nowLine = document.createElement("i");
  nowLine.className = "g-now";
  nowLine.style.left = `${pct(t)}%`;
  head.lastChild.append(nowLine);
  frag.append(head);

  state.lineup.channels.forEach((meta, i) => {
    const row = document.createElement("div");
    row.className = "g-row" + (i === state.idx ? " current" : "");
    const label = document.createElement("button");
    label.type = "button";
    label.className = "g-ch";
    label.innerHTML = `<b>${pad2(meta.num)}</b> <span></span>`;
    label.lastChild.textContent = meta.name;
    label.onclick = () => { closeGuide(); tune(i); };
    const track = document.createElement("div");
    track.className = "g-track";
    if (!onAir(meta)) {
      const b = document.createElement("div");
      b.className = "g-prog offair";
      b.style.left = "0"; b.style.width = "100%";
      b.textContent = `Off the air · signs on at ${meta.hours[0] % 12 || 12} PM`;
      track.append(b);
    } else {
      for (const seg of segs) {
        const m = seg.ed.channels.find((c) => c.id === meta.id);
        const ch = m && getData(m, seg.ed);
        if (!ch) continue;
        for (const s of slotsBetween(ch, seg.a, seg.b)) {
          const a = Math.max(s.start, seg.a), z = Math.min(s.end, seg.b);
          const b = document.createElement("button");
          b.type = "button";
          b.className = "g-prog" + (a <= t && t < z ? " live" : "");
          b.style.left = `${pct(a)}%`;
          b.style.width = `${pct(z) - pct(a)}%`;
          b.title = `${fmtTime(a)} ${s.video.t} (${s.video.c})`;
          b.textContent = s.video.t;
          b.onclick = () => { closeGuide(); tune(i); };
          track.append(b);
        }
      }
    }
    row.append(label, track);
    frag.append(row);
  });
  grid.replaceChildren(frag);
  $("guideClock").textContent = new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  grid.querySelector(".current")?.scrollIntoView({ block: "center" });
}
function closeGuide() { $("guide").hidden = true; }
const toggleGuide = () => ($("guide").hidden ? openGuide() : closeGuide());

// ---------- live viewer count ----------
// Anonymous heartbeat to the Worker's /api/presence while the TV is on and visible.
// Fails quietly (counter stays hidden), e.g. on a plain local static server.
const presence = (() => {
  let id = null;
  try { id = sessionStorage.getItem("hntv.sid"); } catch {}
  if (!id) {
    id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    try { sessionStorage.setItem("hntv.sid", id); } catch {}
  }
  let timer = 0, soon = 0;
  const fmt = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}K` : String(n));

  function show(d) {
    const ok = d && Number.isFinite(d.total) && d.total > 0;
    $("viewers").hidden = !ok;
    $("hudViewers").hidden = !ok;
    if (!ok) return;
    $("viewersText").textContent = `${fmt(d.total)} WATCHING · ${fmt(d.channel)} HERE`;
    $("viewers").title = `${d.total} watching HackerTV right now, ${d.channel} on this channel`;
    $("hudViewers").textContent = `● ${fmt(d.total)}`;
    $("hudViewers").title = `${d.total} watching HackerTV, ${d.channel} on this channel`;
  }

  async function beat() {
    if (!state.powered || document.hidden || !state.lineup) return;
    try {
      const r = await fetch("/api/presence", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, ch: chMeta().id }),
      });
      if (!r.ok) throw new Error(r.status);
      show(await r.json());
    } catch { show(null); }
  }

  function leave() {
    try {
      const body = new Blob([JSON.stringify({ id, leave: true })], { type: "application/json" });
      navigator.sendBeacon?.("/api/presence", body);
    } catch {}
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) beat(); });
  addEventListener("pagehide", leave);

  return {
    start() { clearInterval(timer); beat(); timer = setInterval(beat, 60_000); },
    stop() { clearInterval(timer); clearTimeout(soon); leave(); show(null); },
    // channel flips: report once the viewer settles instead of on every press
    changed() { clearTimeout(soon); soon = setTimeout(beat, 2_000); },
  };
})();

// ---------- theater / fullscreen ----------
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement;

function setTheater(on) {
  state.theater = on;
  document.body.classList.toggle("theater", on);
  if (!on) {
    state.theaterFromFs = false;
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  }
  pokeHud();
}

async function toggleFullscreen() {
  if (fsElement()) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    return;
  }
  // Fullscreen = theater layout + browser fullscreen on the whole page, so the guide still works.
  if (!state.theater) { setTheater(true); state.theaterFromFs = true; }
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen;
  if (!req) return; // e.g. iPhone Safari: theater mode is the best we can do
  try {
    await req.call(el, { navigationUI: "hide" });
    await screen.orientation?.lock?.("landscape");
  } catch {}
}

function onFullscreenChange() {
  if (!fsElement() && state.theaterFromFs) setTheater(false);
}
document.addEventListener("fullscreenchange", onFullscreenChange);
document.addEventListener("webkitfullscreenchange", onFullscreenChange);

// Floating controls: visible while the pointer moves, hidden (with the cursor) when idle.
let hudTimer = 0;
function pokeHud() {
  const hud = $("hud");
  if (!state.theater) { hud.classList.remove("show"); document.body.classList.remove("idle"); return; }
  hud.classList.add("show");
  document.body.classList.remove("idle");
  clearTimeout(hudTimer);
  hudTimer = setTimeout(() => {
    if (hud.matches(":hover")) return pokeHud();
    hud.classList.remove("show");
    document.body.classList.add("idle");
  }, 2500);
}
["mousemove", "touchstart", "keydown"].forEach((ev) => document.addEventListener(ev, () => state.theater && pokeHud(), { passive: true }));
$("tube").addEventListener("dblclick", () => state.powered && toggleFullscreen());

// ---------- input ----------
function enterDigit(d) {
  if (!state.powered) return;
  state.digits = (state.digits + d).slice(-2);
  flashOSD(state.digits.padEnd(2, "-"), 1500);
  $("led").textContent = state.digits.padEnd(2, "-");
  clearTimeout(state.digitTimer);
  state.digitTimer = setTimeout(commitDigits, state.digits.length >= 2 ? 300 : 1300);
}
function commitDigits() {
  clearTimeout(state.digitTimer);
  const num = parseInt(state.digits, 10);
  state.digits = "";
  const i = state.lineup.channels.findIndex((c) => c.num === num);
  if (i >= 0) tune(i);
  else { flashOSD(`NO CH ${num}`, 1500); $("led").textContent = pad2(chMeta().num); }
}

const actions = {
  chup: () => state.powered && tune(state.idx + 1),
  chdown: () => state.powered && tune(state.idx - 1),
  guide: () => toggleGuide(),
  filter: () => { state.filter = (state.filter + 1) % FILTERS.length; applyFilter(); state.powered && flashOSD(FILTERS[state.filter].name, 1500); },
  mute: () => { state.muted = !state.muted; applyMute(); },
  captions: () => toggleCaptions(),
  power: () => power(),
  theater: () => setTheater(!state.theater),
  fullscreen: () => toggleFullscreen(),
  info: () => state.powered && state.slot && showLowerThird(chMeta(), state.slot),
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-act],[data-key]");
  if (!b) return;
  if (b.dataset.act) actions[b.dataset.act]();
  const k = b.dataset.key;
  if (k === "enter") state.digits && commitDigits();
  else if (k === "last") state.powered && tune(state.lastIdx);
  else if (k) enterDigit(k);
});
$("powerCta").addEventListener("click", () => power(true));
$("guideClose").addEventListener("click", closeGuide);
$("guide").addEventListener("click", (e) => { if (e.target.id === "guide") closeGuide(); });

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (k === "Escape") {
    if (!$("guide").hidden) return closeGuide();
    if (state.theater && !fsElement()) return setTheater(false);
    return;
  }
  if (/^[0-9]$/.test(k)) return enterDigit(k);
  if (k === "Enter" && state.digits) return commitDigits();
  const map = { ArrowUp: "chup", ArrowDown: "chdown", PageUp: "chup", PageDown: "chdown",
                g: "guide", f: "filter", m: "mute", p: "power", i: "info", t: "theater", c: "captions" };
  const act = map[k] || map[k.toLowerCase()];
  if (act) { e.preventDefault(); actions[act](); }
});

// ---------- VHS date stamp ----------
function tickVhsDate() {
  const d = new Date(now() * 1000);
  const mon = d.toLocaleString("en", { month: "short" }).toUpperCase();
  $("vhsDate").textContent = `${d.getHours() % 12 || 12}:${pad2(d.getMinutes())}${d.getHours() < 12 ? "AM" : "PM"}\n${mon} ${pad2(d.getDate())} ${d.getFullYear()}`;
}

// ---------- boot ----------
(async function boot() {
  syncClock();
  try {
    state.editions = await loadVideos();
  } catch (err) {
    console.error(err);
    $("poweroff").hidden = true;
    setStandby(true, "NO SIGNAL", `Could not read ${VIDEOS_FILE}: ${err.message}`, true);
    $("infoTag").textContent = `Add YouTube links to ${VIDEOS_FILE} and reload`;
    return;
  }
  state.lineup = editionAt(now());
  $("estNotice").hidden = !state.lineup.estimated;
  const built = Math.max(0, ...state.editions.map((e) => e.built || 0));
  if (built) $("dataUpdated").textContent = ` · updated ${new Date(built * 1000).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}`;
  const saved = store.get("hntv.ch", "prime");
  state.idx = Math.max(0, state.lineup.channels.findIndex((c) => c.id === saved));
  state.lastIdx = state.idx;
  applyFilter();
  document.querySelectorAll('[data-act="captions"]').forEach((b) => b.classList.toggle("on", state.captions));
  document.body.classList.toggle("cc-on", state.captions);
  await tune(state.idx);
  loadChannel(chMeta());
  createPlayer();
  render();
  setInterval(async () => { await checkEdition(); sync(); tickVhsDate(); }, 1000);
  setInterval(syncClock, 10 * 60 * 1000);
  setInterval(refreshLineup, 60 * 60 * 1000); // pick up next week's edition in open tabs
  tickVhsDate();
})();
