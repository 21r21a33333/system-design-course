#!/usr/bin/env python3
"""Rebuild a de-duplicated transcript from a yt-notes bundle.

YouTube auto-captions arrive as a rolling window: each cue repeats the
previous phrase(s), so the raw transcript says everything ~3x. This collapses
maximal adjacent repeated word-blocks and re-emits a clean, timestamped,
deep-linked transcript so downstream note authoring is ~3x lighter and clearer.

Usage: python3 clean_transcript.py <bundle_dir>
Writes <bundle_dir>/transcript.clean.md
"""
import json
import re
import sys
from pathlib import Path


def collapse(words, max_window=12):
    """Drop any block of up to max_window words that immediately repeats the
    just-emitted tail. Handles both intra-cue stutter and cross-cue overlap."""
    out_words = []
    out_times = []
    i = 0
    n = len(words)
    while i < n:
        matched = 0
        upper = min(len(out_words), n - i, max_window)
        for L in range(upper, 0, -1):
            if out_words[-L:] == [w for w, _ in words[i:i + L]]:
                matched = L
                break
        if matched:
            i += matched
        else:
            w, t = words[i]
            out_words.append(w)
            out_times.append(t)
            i += 1
    return list(zip(out_words, out_times))


def main(bundle_dir):
    bundle = Path(bundle_dir)
    cues = json.loads((bundle / "transcript.json").read_text())
    meta = json.loads((bundle / "meta.json").read_text())
    vid = meta["video_id"]

    words = []
    for cue in cues:
        start = cue.get("start", 0.0)
        for tok in re.findall(r"\S+", cue.get("text", "")):
            words.append((tok, start))

    cleaned = collapse(words)

    # Re-chunk into ~45-word lines, each prefixed with the timestamp deep-link
    # of its first word.
    lines = []
    chunk = []
    chunk_start = None
    for w, t in cleaned:
        if not chunk:
            chunk_start = t
        chunk.append(w)
        if len(chunk) >= 45:
            sec = int(chunk_start)
            m, s = divmod(sec, 60)
            lines.append(
                f"- [{m}:{s:02d}](https://youtu.be/{vid}?t={sec}) " + " ".join(chunk)
            )
            chunk = []
    if chunk:
        sec = int(chunk_start)
        m, s = divmod(sec, 60)
        lines.append(f"- [{m}:{s:02d}](https://youtu.be/{vid}?t={sec}) " + " ".join(chunk))

    header = f"# Transcript (de-duplicated)\n\n_{meta['title']}_\n\n"
    out = bundle / "transcript.clean.md"
    out.write_text(header + "\n".join(lines) + "\n")
    raw_words = len(words)
    clean_words = len(cleaned)
    print(f"{vid}: {raw_words} raw words -> {clean_words} clean words "
          f"({100 * clean_words // max(raw_words,1)}%), {len(lines)} lines -> {out}")


if __name__ == "__main__":
    main(sys.argv[1])
