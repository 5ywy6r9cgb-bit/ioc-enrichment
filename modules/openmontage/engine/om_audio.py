#!/usr/bin/env python3
"""
om_audio.py — the score, generated rather than sourced.

The same rule om_motifs.py applies to pictures, applied to sound: every tone
here is synthesised from an oscillator in this file. Nothing is sampled,
nothing is licensed, nothing has to be explained. The bed for an episode is
reproducible from the spec, hashable, and recorded in the build manifest like
every other input — which is the one thing a borrowed track can never be in a
system whose entire claim is provenance.

THE DESIGN IDEA — the bed is notched around your voice

You narrate over this. So it is built deliberately OUTSIDE the human speech
band (300-3400 Hz): a low drone underneath it, brief transient marks above it.
Nothing competes with the voice, which means you never have to duck music in
Detail or Captions — the hole is already there, cut at synthesis time.

`analyze()` measures exactly that and returns the share of total energy sitting
inside the speech band. A healthy bed lands in the low single digits. If a
change to this file pushes that number up, the score has started fighting the
narration, and the self-test says so instead of you discovering it in the edit.

  bed     detuned sines at 41 / 55 / 82.5 Hz (E1, A1, E2), slowly breathing
  marks   one per scene, register chosen by scene type:
            thump  50-110 Hz    weight, arrival, a document landing
            tick   5-9 kHz      paper, machine, a record being read
  level   normalised to -18 dBFS peak, leaving headroom for a voice on top

USAGE
    track = om_audio.build_track(scenes, total_seconds, gain, bed=True)
    om_audio.write_wav(path, track)
    stats = om_audio.analyze(track)

    python3 om_audio.py --demo bed.wav     # audition every cue, 30 seconds
    python3 om_audio.py --self-test
"""
from __future__ import annotations

import argparse
import math
import sys
import wave
from pathlib import Path

import numpy as np

SR = 48000                      # sample rate
PEAK_TARGET_DBFS = -18.0        # headroom for a voice on top
SPEECH_BAND = (300.0, 3400.0)   # the hole kept deliberately open

# How each scene type announces itself. A question does not arrive the way a
# number does, and a photograph should barely arrive at all.
CUE_FOR_TYPE = {
    "title":    "swell",
    "question": "ask",
    "quote":    "paper",
    "photo":    "air",
    "bignum":   "weight",
    "vchart":   "rise",
    "chart":    "rise",
    "hash":     "machine",
}
DEFAULT_CUE = "paper"


# ------------------------------------------------------------------ primitives
def _env_decay(n: int, tau: float) -> np.ndarray:
    return np.exp(-(np.arange(n) / SR) / max(1e-4, tau))


def _env_ar(n: int, attack: float, release: float) -> np.ndarray:
    """Attack/release. A hard transient on a low sine clicks; this stops it."""
    a = min(max(1, int(attack * SR)), n)
    env = np.empty(n, dtype=np.float64)
    env[:a] = np.linspace(0.0, 1.0, a)
    if n > a:
        env[a:] = _env_decay(n - a, release)
    return env


def _sine(freq: float, n: int, phase: float = 0.0) -> np.ndarray:
    return np.sin(2 * math.pi * freq * (np.arange(n) / SR) + phase)


def _hp1(x: np.ndarray, cutoff: float) -> np.ndarray:
    """One-pole high-pass, used to lift ticks clear of the speech band.
    Marks are short, so the Python-level loop cost is irrelevant."""
    rc = 1.0 / (2 * math.pi * cutoff)
    a = rc / (rc + 1.0 / SR)
    y = np.empty_like(x)
    px = py = 0.0
    for i, xi in enumerate(x):
        py = a * (py + xi - px)
        px = xi
        y[i] = py
    return y


def _lp1(x: np.ndarray, cutoff: float) -> np.ndarray:
    """One-pole low-pass. Keeps thumps under the voice."""
    dt = 1.0 / SR
    rc = 1.0 / (2 * math.pi * cutoff)
    a = dt / (rc + dt)
    y = np.empty_like(x)
    prev = 0.0
    for i, xi in enumerate(x):
        prev += a * (xi - prev)
        y[i] = prev
    return y


def _noise(n: int, seed: int) -> np.ndarray:
    return np.random.default_rng(seed).standard_normal(n)


# ----------------------------------------------------------------------- marks
def _mark(kind: str, seed: int) -> np.ndarray:
    """One scene mark. Everything is below 300 Hz or above 4.5 kHz on purpose."""
    if kind == "weight":
        # a figure landing on the table
        n = int(0.55 * SR)
        body = (_sine(58, n) + _sine(87, n) * 0.5) * _env_decay(n, 0.16)
        return _lp1(body, 220) * 0.9

    if kind == "swell":
        # a slow rise into the frame — opens and closes an episode
        n = int(1.20 * SR)
        body = (_sine(55, n) + _sine(82.5, n) * 0.6) * _env_ar(n, 0.45, 0.42)
        return _lp1(body, 200) * 0.8

    if kind == "ask":
        # a question: two low tones, the second higher, left unresolved
        n = int(0.70 * SR)
        low = _sine(98, n) * _env_ar(n, 0.02, 0.22)
        half = n // 2
        lift = np.zeros(n)
        lift[half:] = _sine(131, n - half) * _env_ar(n - half, 0.03, 0.20) * 0.7
        return _lp1((low + lift) * 0.7, 260)

    if kind == "paper":
        # a sheet set down: bright transient, no midrange at all
        n, n2 = int(0.16 * SR), int(0.30 * SR)
        tick = _hp1(_hp1(_noise(n, seed) * _env_decay(n, 0.028), 5200), 5200)
        under = _lp1(_sine(64, n2) * _env_decay(n2, 0.07), 180)
        out = np.zeros(max(n, n2))
        out[:n] += tick * 0.55
        out[:n2] += under * 0.45
        return out

    if kind == "air":
        # a photograph. Barely an event — the image should carry it, not a cue.
        n = int(0.85 * SR)
        return _lp1(_sine(49, n) * _env_ar(n, 0.30, 0.34), 170) * 0.45

    if kind == "machine":
        # a hash printing: four crisp ticks, evenly spaced, above the voice
        gap = int(0.085 * SR)
        n = gap * 4 + int(0.10 * SR)
        out = np.zeros(n)
        for k in range(4):
            m = int(0.055 * SR)
            t = _hp1(_hp1(_noise(m, seed + k) * _env_decay(m, 0.010), 6500), 6500)
            out[k * gap:k * gap + m] += t * (0.42 - 0.05 * k)
        return out

    if kind == "rise":
        # data drawing in: a short low sweep with a tick on the front
        n = int(0.60 * SR)
        t = np.arange(n) / SR
        sweep = np.sin(2 * math.pi * (62 + 40 * (t / (n / SR))) * t) * _env_ar(n, 0.05, 0.28)
        out = _lp1(sweep, 240) * 0.7
        m = int(0.10 * SR)
        out[:m] += _hp1(_noise(m, seed) * _env_decay(m, 0.018), 5800) * 0.35
        return out

    # An unknown cue name renders a neutral low mark rather than silence, so a
    # typo in a spec is audible in review instead of invisible.
    n = int(0.30 * SR)
    return _lp1(_sine(70, n) * _env_decay(n, 0.10), 200) * 0.6


# ------------------------------------------------------------------------- bed
def _bed(total: float) -> np.ndarray:
    """Detuned low sines that breathe. Entirely below the speech band."""
    n = int(total * SR)
    t = np.arange(n) / SR
    breathe = 0.72 + 0.28 * np.sin(2 * math.pi * 0.045 * t)        # ~22s cycle
    drift = 0.85 + 0.15 * np.sin(2 * math.pi * 0.017 * t + 1.1)    # slower still
    a1 = np.sin(2 * math.pi * 55.0 * t)
    e2 = np.sin(2 * math.pi * 82.5 * t + 0.6) * 0.55
    e1 = np.sin(2 * math.pi * 41.2 * t + 2.2) * 0.30
    return (a1 + e2 + e1) * breathe * drift * 0.30


def _fade_edges(x: np.ndarray, seconds: float = 0.6) -> np.ndarray:
    n = min(int(seconds * SR), len(x) // 2)
    if n <= 0:
        return x
    ramp = np.linspace(0.0, 1.0, n)
    x[:n] *= ramp
    x[-n:] *= ramp[::-1]
    return x


# ------------------------------------------------------------------ public API
def build_track(scenes, total: float, gain: float = 1.0, bed: bool = True) -> np.ndarray:
    """Build the whole track for a scene list.

    scenes  resolved scene dicts (needs "dur"; "type" chooses the cue; a scene
            may override with "sfx": "paper" | "weight" | ... | "none")
    total   total duration in seconds — the track is cut to exactly this
    gain    scales the finished track after normalisation
    bed     False renders marks only, no drone
    """
    total = float(total)
    if total <= 0:
        raise ValueError("total duration must be greater than zero")
    n = int(total * SR)
    track = _bed(total) if bed else np.zeros(n, dtype=np.float64)
    if len(track) < n:
        track = np.pad(track, (0, n - len(track)))

    at = 0.0
    for i, s in enumerate(scenes):
        cue = str(s.get("sfx") or CUE_FOR_TYPE.get(s.get("type", ""), DEFAULT_CUE))
        if cue != "none":
            m = _mark(cue, seed=1000 + i * 7)
            start = int(at * SR)
            end = min(n, start + len(m))
            if end > start:
                track[start:end] += m[:end - start]
        at += float(s.get("dur", 0.0))

    track = _fade_edges(track)
    peak = float(np.max(np.abs(track))) or 1.0
    target = 10 ** (PEAK_TARGET_DBFS / 20.0)
    return np.clip(track * (target / peak) * float(gain), -1.0, 1.0).astype(np.float32)


def write_wav(path, track: np.ndarray) -> Path:
    """16-bit PCM mono at 48 kHz — what ffmpeg wants, no extra dependency."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = (np.clip(np.asarray(track, dtype=np.float64), -1.0, 1.0) * 32767.0).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return path


def analyze(track: np.ndarray) -> dict:
    """Measure it. The speech-band number is the one that matters: it is the
    proof that the bed leaves room for the narration."""
    x = np.asarray(track, dtype=np.float64)
    if not len(x):
        return {"peak_dbfs": -math.inf, "rms_dbfs": -math.inf,
                "speech_band_energy_pct": 0.0, "seconds": 0.0}
    peak = float(np.max(np.abs(x)))
    rms = float(np.sqrt(np.mean(x ** 2)))
    spec = np.abs(np.fft.rfft(x * np.hanning(len(x)))) ** 2
    freqs = np.fft.rfftfreq(len(x), 1.0 / SR)
    band = (freqs >= SPEECH_BAND[0]) & (freqs <= SPEECH_BAND[1])
    total_e = float(spec.sum()) or 1.0
    return {
        "peak_dbfs": round(20 * math.log10(peak) if peak > 0 else -math.inf, 1),
        "rms_dbfs": round(20 * math.log10(rms) if rms > 0 else -math.inf, 1),
        "speech_band_energy_pct": round(100.0 * float(spec[band].sum()) / total_e, 2),
        "seconds": round(len(x) / SR, 3),
    }


# -------------------------------------------------------------------- self-test
def self_test() -> int:
    print("=== SELF-TEST: om_audio ===")
    fails = ran = 0

    def check(label, ok):
        nonlocal fails, ran
        ran += 1
        print(f"  {'PASS' if ok else 'FAIL'}  {label}")
        fails += (not ok)

    scenes = [{"type": "title", "dur": 6.0}, {"type": "question", "dur": 6.0},
              {"type": "quote", "dur": 10.0}, {"type": "photo", "dur": 4.0},
              {"type": "bignum", "dur": 7.0}, {"type": "hash", "dur": 9.0}]
    total = sum(s["dur"] for s in scenes)
    tr = build_track(scenes, total)

    check("track length matches the video duration exactly",
          abs(len(tr) / SR - total) < 0.002)
    check("track never clips", float(np.max(np.abs(tr))) <= 1.0)

    st = analyze(tr)
    check(f"peak lands on the -18 dBFS target (got {st['peak_dbfs']})",
          -19.5 <= st["peak_dbfs"] <= -16.5)
    # the entire reason this module exists:
    check(f"the speech band stays clear for narration "
          f"({st['speech_band_energy_pct']}%)",
          st["speech_band_energy_pct"] < 8.0)

    check("starts from silence (no click on the cut)", abs(float(tr[0])) < 1e-3)
    check("ends in silence", abs(float(tr[-1])) < 1e-3)
    check("gain scales the output",
          float(np.max(np.abs(build_track(scenes, total, gain=0.5)))) <
          float(np.max(np.abs(tr))) * 0.75)
    check("bed=False is quieter than bed=True at equal marks",
          float(np.sqrt(np.mean(np.asarray(build_track(scenes, total, bed=False),
                                           dtype=np.float64) ** 2))) <
          float(np.sqrt(np.mean(np.asarray(tr, dtype=np.float64) ** 2))))
    check("every scene type has a cue",
          all(t in CUE_FOR_TYPE for t in
              ("title", "question", "quote", "photo", "bignum", "vchart",
               "chart", "hash")))
    check("sfx:none suppresses a scene mark",
          float(np.max(np.abs(build_track([{"type": "bignum", "dur": 3, "sfx": "none"}],
                                          3, bed=False)))) < 1e-6)
    check("an unknown cue name still renders something audible",
          float(np.max(np.abs(build_track([{"type": "x", "dur": 3, "sfx": "wat"}],
                                          3, bed=False)))) > 0.0)
    check("the same spec renders the same bed every time",
          np.array_equal(build_track(scenes, total), tr))

    try:
        build_track(scenes, 0)
        ok = False
    except ValueError:
        ok = True
    check("zero duration is refused", ok)

    import tempfile
    with tempfile.TemporaryDirectory() as td:
        p = write_wav(Path(td) / "t.wav", tr)
        check("wav file is written", p.is_file() and p.stat().st_size > 1000)
        with wave.open(str(p)) as w:
            check("wav is 48kHz 16-bit mono",
                  w.getframerate() == SR and w.getsampwidth() == 2
                  and w.getnchannels() == 1)
            check("wav frame count matches the track", w.getnframes() == len(tr))

    print(f"\nSelf-test: {ran - fails}/{ran} behaved correctly.")
    return 1 if fails else 0


def main():
    ap = argparse.ArgumentParser(description="The Sentinel Report audio bed")
    ap.add_argument("--demo", help="write a 30s audition wav here")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test())
    if a.demo:
        scenes = [{"type": k, "dur": 30.0 / len(CUE_FOR_TYPE)} for k in CUE_FOR_TYPE]
        tr = build_track(scenes, 30.0)
        write_wav(a.demo, tr)
        st = analyze(tr)
        print(f"-> {a.demo}")
        print(f"   {st['seconds']}s · peak {st['peak_dbfs']} dBFS · "
              f"rms {st['rms_dbfs']} dBFS · "
              f"{st['speech_band_energy_pct']}% of energy in the speech band")
        return
    ap.print_help()


if __name__ == "__main__":
    main()
