# shader-tv

A local copy of [HackerTV](https://hackertv.org) (by Danny Salzman, [source](https://github.com/dsalzman/hackertv)).
It plays YouTube videos listed in `videos.json` as a 24/7 "broadcast".

The videos are graphics-programming talks, tutorials and lectures collected from links shared by
the community on the [Shadertoy](https://www.shadertoy.com) Discord server. All videos belong to
their creators and are played through YouTube's embedded player; nothing is rehosted here.

## Run

```sh
node tools/fill-metadata.mjs   # fill in titles + durations (run after editing videos.json)
python3 -m http.server 8000    # then open http://localhost:8000
```

It must be served over http; opening `index.html` as a file won't work.

## videos.json

The simplest version is a list of links:

```json
["https://www.youtube.com/watch?v=fNk_zzaMoSs", "https://youtu.be/NGFhc8R_uO4"]
```

For several channels, use this shape. Every field except `url` is optional:

```json
{
  "channels": [
    {
      "num": 2, "name": "HN PRIME", "tagline": "Shown under the channel name",
      "hours": [23, 5],
      "videos": [
        "https://youtu.be/NGFhc8R_uO4",
        { "url": "https://www.youtube.com/watch?v=fNk_zzaMoSs",
          "title": "…", "channel": "…", "duration": 591, "quote": "…", "year": "2018" }
      ]
    }
  ]
}
```

- Any YouTube link form works: `watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, or a bare 11-character ID.
- `duration` (in seconds) drives the schedule. Videos without one count as 10 minutes and the page
  shows the "durations are estimated" notice. `tools/fill-metadata.mjs` fills these in.
- A missing `title` or `channel` is looked up in the browser through YouTube oEmbed.
- `"oneVideoPerChannel": true` (at the top level, or on one channel) puts every video on its own
  channel, numbered upward from the channel's `num`. Each one is named after the YouTube uploader and
  uses the video title as its tagline.
- `"start": 1362` (seconds, or `"22m42s"`) plays a video from that point. A `t=` in the link
  (`youtu.be/…?t=1362`) works too. Keep `duration` as the full video length; the schedule uses the
  part after the start.
- `hours: [on, off]` limits a channel to those local hours (like the original's LATE NIGHT channel).

## Ads

As on the original site, the player is embedded with YouTube's privacy-enhanced host
(`youtube-nocookie.com`) and without YouTube's controls, related videos or annotations. In practice
this cuts out most ads, but it is not a real ad blocker: a page cannot strip ads from inside YouTube's
cross-origin iframe, so the occasional ad can still play on monetized videos.
