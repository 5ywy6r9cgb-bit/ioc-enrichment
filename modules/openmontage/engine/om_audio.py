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


# ------------------------------------------------------- spectral shaping
# The one-pole filters above walk sample by sample, which is fine for a 0.2s
# drum hit and hopeless for a four-minute track. Anything full-length is shaped
# in the frequency domain instead: one FFT, a gain curve over the bins, one
# inverse. Shoulders are smoothed in log-frequency so the curve never rings.
def _shape(x: np.ndarray, points: list[tuple[float, float]]) -> np.ndarray:
    """Apply a gain curve. `points` is [(hz, gain), ...] in ascending Hz;
    gain is interpolated between them and held flat outside the ends."""
    n = len(x)
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(n, 1.0 / SR)
    hz = np.array([max(1e-3, p[0]) for p in points])
    gains = np.array([p[1] for p in points])
    curve = np.interp(np.log10(np.maximum(freqs, 1e-3)), np.log10(hz), gains)
    return np.fft.irfft(spec * curve, n=n)


def voice_notch(x: np.ndarray, depth_db: float = -9.0) -> np.ndarray:
    """Carve room for the narration across the whole mix.

    A broadcast engineer does this with a permanent dip in the music bus so the
    voice never has to fight for the same frequencies. Here it is done once,
    on the finished mix, with wide shoulders either side of the speech band so
    the music still sounds whole — it loses presence, not body or air.

    This is why a groove bed can carry chords and still leave the middle open.
    """
    g = 10 ** (depth_db / 20.0)
    return _shape(x, [(20, 1.0), (150, 1.0), (SPEECH_BAND[0], g),
                      (1400, g * 0.92), (SPEECH_BAND[1], g),
                      (6000, 1.0), (20000, 1.0)])


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


# ===================================================================== groove
# The second bed style. The drone above is for a piece that is mostly silence
# and one voice; this is for an episode with momentum — 124 BPM, four on the
# floor, and a bassline that keeps moving.
#
# THE RULE THIS IS BUILT ON: make the groove interesting, not the melody.
# The melodic content is four chords and a two-bar arpeggio, repeated for four
# minutes without development, because a viewer who notices the tune has
# stopped listening to the narration. Everything that holds attention is
# rhythmic — hat syncopation, bass placement, and a variation every eight bars.
#
# Mix targets, in order of priority:
#   1. the centre stays open       voice_notch() carves 300-3400 Hz on the bus
#   2. clean low end               one voice below 100 Hz at a time
#   3. crisp but soft highs        hats rolled off above 13k, never brittle
#
# The loop is seam-exact: any note or tail running past the final bar wraps
# around to the start, so the end joins the beginning with no click and no
# gap. Play it on repeat for an hour and there is no join to hear.

BPM = 124                       # the brief: 120-126, fast enough to carry momentum
BEATS_PER_BAR = 4
LOOP_BARS = 128                 # 128 bars at 124 BPM ≈ 4 minutes 8 seconds

# A minor, sevenths throughout. Four bars each, so the cycle is 16 bars and the
# ear stops tracking it after the first pass — which is the point.
#   Am7 · Fmaj7 · Cmaj7 · Em7
PROGRESSION = [
    {"name": "Am7",   "bass": 45, "pad": [57, 60, 64, 67]},
    {"name": "Fmaj7", "bass": 41, "pad": [57, 60, 64, 65]},
    {"name": "Cmaj7", "bass": 48, "pad": [55, 59, 64, 67]},
    {"name": "Em7",   "bass": 40, "pad": [55, 59, 62, 67]},
]


def _hz(midi: float) -> float:
    return 440.0 * (2 ** ((midi - 69) / 12.0))


def _beat_s() -> float:
    return 60.0 / BPM


def _bar_s() -> float:
    return _beat_s() * BEATS_PER_BAR


def _add(buf: np.ndarray, sample: np.ndarray, at: int) -> None:
    """Mix a sample in at a sample offset, wrapping past the end.

    The wrap is what makes the loop seamless: a kick on the last sixteenth and
    the tail of the final pad both continue into the top of the loop instead of
    being cut off at the boundary.
    """
    n, m = len(buf), len(sample)
    if m <= 0:
        return
    at %= n
    end = at + m
    if end <= n:
        buf[at:end] += sample
    else:
        first = n - at
        buf[at:] += sample[:first]
        rest = sample[first:]
        buf[:len(rest) % n if len(rest) > n else len(rest)] += rest[:n]


# ------------------------------------------------------------------ the kit
def _kick() -> np.ndarray:
    """Sub with a pitch drop and a short click. One voice under 100 Hz."""
    n = int(0.34 * SR)
    t = np.arange(n) / SR
    f = 48 + 78 * np.exp(-t / 0.024)                 # 126 Hz -> 48 Hz
    body = np.sin(2 * math.pi * np.cumsum(f) / SR) * np.exp(-t / 0.115)
    m = int(0.006 * SR)
    click = _hp1(_noise(m, 11) * _env_decay(m, 0.0022), 3000) * 0.30
    out = body * 0.95
    out[:m] += click
    return out


def _clap() -> np.ndarray:
    """Three quick noise bursts. Weighted high on purpose — a clap sitting at
    1-3 kHz is exactly where the voice lives, so this one sits above it."""
    n = int(0.20 * SR)
    out = np.zeros(n)
    for k, off in enumerate((0.0, 0.011, 0.021)):
        m = int(0.09 * SR)
        burst = _noise(m, 30 + k) * _env_decay(m, 0.016 + 0.012 * k)
        st = int(off * SR)
        out[st:st + m] += burst * (0.5 - 0.11 * k)
    return _hp1(_hp1(out, 3600), 3600) * 0.55


def _hat(open_: bool = False, seed: int = 0) -> np.ndarray:
    """Rolled off above 13k so it stays crisp without turning brittle."""
    dur = 0.16 if open_ else 0.045
    n = int(dur * SR)
    h = _noise(n, 60 + seed) * _env_decay(n, 0.055 if open_ else 0.013)
    h = _hp1(_hp1(h, 7200), 7200)
    return _lp1(h, 13000) * (0.16 if open_ else 0.13)


def _blip(midi: float, dur: float, seed: int) -> np.ndarray:
    """A terminal blip — the digital texture. Short, bright, harmonically thin,
    so it reads as data rather than as a melody instrument."""
    n = int(dur * SR)
    f = _hz(midi)
    env = _env_ar(n, 0.002, dur * 0.32)
    tone = (np.sin(2 * math.pi * f * np.arange(n) / SR)
            + 0.30 * np.sin(2 * math.pi * f * 2 * np.arange(n) / SR)
            + 0.12 * np.sin(2 * math.pi * f * 3.01 * np.arange(n) / SR))
    return tone * env * 0.10


def _bass_note(midi: float, dur: float) -> np.ndarray:
    """Warm and slightly funky: a saw softened to a rounded pulse, driven just
    into saturation so it has grit, then held under 260 Hz."""
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    f = _hz(midi)
    ph = (f * t) % 1.0
    saw = 2.0 * ph - 1.0
    sq = np.where(ph < 0.42, 1.0, -1.0)
    raw = 0.68 * saw + 0.32 * sq
    env = _env_ar(n, 0.006, max(0.05, dur * 0.55))
    return np.tanh(raw * env * 1.9) * 0.30


def _pad_note(midi: float, dur: float) -> np.ndarray:
    """Analog-ish: two slightly detuned saws, soft attack, long release."""
    n = max(1, int(dur * SR))
    t = np.arange(n) / SR
    f = _hz(midi)
    a = ((f * 0.9985 * t) % 1.0) * 2 - 1
    b = ((f * 1.0015 * t) % 1.0) * 2 - 1
    env = _env_ar(n, 0.25, dur * 0.75)
    return (a + b) * 0.5 * env * 0.085


def build_groove(bars: int = LOOP_BARS, seed: int = 7,
                 notch_db: float = -9.0) -> np.ndarray:
    """Render a seam-exact loop of `bars` bars at 124 BPM."""
    rng = np.random.default_rng(seed)
    beat, bar_s = _beat_s(), _bar_s()
    step = beat / 4.0                              # a sixteenth
    n = int(round(bars * bar_s * SR))
    drums = np.zeros(n)
    bass = np.zeros(n)
    keys = np.zeros(n)

    kick, clap = _kick(), _clap()
    hats = [_hat(False, i) for i in range(4)]
    ohat = _hat(True, 9)

    # 16-step patterns. The groove lives here, so this is the part that varies.
    KICK_STEPS = [0, 4, 8, 12]
    KICK_GHOST = [14, 6]
    CLAP_STEPS = [4, 12]
    BASS_STEPS = [0, 3, 6, 8, 11, 14]              # syncopated, always moving

    for b in range(bars):
        chord = PROGRESSION[(b // 4) % len(PROGRESSION)]
        bar0 = int(round(b * bar_s * SR))
        phase = b % 16                             # position in the 16-bar cycle

        # --- micro-variation. Every 8 bars something changes, and the change
        # is rhythmic, never melodic.
        drop_hats = (phase == 7)                   # one bar of air
        busy_bass = (phase >= 8)                   # second half drives harder
        fill = (phase == 15)                       # a fill into the turnaround
        no_pad = (phase in (7, 15))

        for st in range(16):
            at = bar0 + int(round(st * step * SR))

            if st in KICK_STEPS and not (fill and st == 12):
                _add(drums, kick, at)
            elif st in KICK_GHOST and phase % 4 == 3:
                _add(drums, kick * 0.45, at)

            if st in CLAP_STEPS:
                _add(drums, clap, at)

            if not drop_hats:
                if st % 2 == 0:
                    _add(drums, hats[st % 4] * (1.0 if st % 4 == 0 else 0.72), at)
                elif rng.random() < (0.75 if busy_bass else 0.45):
                    _add(drums, hats[st % 4] * 0.5, at)          # syncopation
                if st == 14 and phase % 4 == 3:
                    _add(drums, ohat, at)

            if fill and st >= 12:
                _add(drums, clap * (0.35 + 0.2 * (st - 12)), at)

            # --- bass: root, octave and fifth, placed off the beat
            hit = st in BASS_STEPS or (busy_bass and st == 10)
            if hit:
                if st == 0:
                    m, d = chord["bass"], step * 2.6
                elif st in (6, 14):
                    m, d = chord["bass"] + 12, step * 1.1
                elif st == 11:
                    m, d = chord["bass"] + 7, step * 1.4
                else:
                    m, d = chord["bass"], step * 1.5
                _add(bass, _bass_note(m, d), at)

            # --- arpeggio: two bars of chord tones, high and thin. It repeats
            # without development on purpose.
            if st % 2 == 0:
                tone = chord["pad"][(st // 2 + b) % len(chord["pad"])] + 24
                _add(keys, _blip(tone, step * 1.6, seed + st), at)

            # occasional terminal chirp, far above the voice
            if st == 9 and phase in (3, 11) and rng.random() < 0.7:
                _add(keys, _blip(chord["pad"][0] + 36, step * 0.7, seed + b), at)

        if not no_pad:
            for m in chord["pad"]:
                _add(keys, _pad_note(m, bar_s * 1.15), bar0)

    # --- bus shaping, in the order an engineer would do it
    drums = _shape(drums, [(20, 0.65), (45, 1.0), (110, 1.0), (300, 0.8),
                           (3000, 0.9), (9000, 1.0), (14000, 0.75), (20000, 0.5)])
    bass = _shape(bass, [(20, 0.5), (55, 1.0), (180, 1.0), (260, 0.45),
                         (700, 0.10), (20000, 0.02)])
    keys = _shape(keys, [(20, 0.2), (200, 0.55), (900, 0.8), (4000, 1.0),
                         (12000, 0.9), (20000, 0.6)])

    mix = drums * 0.92 + bass * 1.0 + keys * 0.85
    # Subsonic filter. Energy below ~30 Hz is inaudible on a phone speaker and
    # on most laptops, but it is real amplitude — it eats the headroom that
    # would otherwise go to the parts you can actually hear. Removing it is
    # most of what "clean low end" means in practice.
    mix = _shape(mix, [(8, 0.0), (22, 0.18), (34, 0.85), (55, 1.0), (20000, 1.0)])
    mix = voice_notch(mix, notch_db)               # the centre stays open
    mix = np.tanh(mix * 1.15) * 0.92               # gentle bus glue, no pumping

    peak = float(np.max(np.abs(mix))) or 1.0
    return (mix * (10 ** (PEAK_TARGET_DBFS / 20.0) / peak)).astype(np.float32)


def groove_for(total: float, gain: float = 1.0, seed: int = 7,
               notch_db: float = -9.0) -> np.ndarray:
    """A groove bed cut to exactly `total` seconds, looping as many times as
    it needs to and fading only at the very ends."""
    bars = max(8, int(math.ceil(total / _bar_s())) + 1)
    loop = build_groove(bars=bars, seed=seed, notch_db=notch_db)
    n = int(total * SR)
    if len(loop) < n:
        loop = np.tile(loop, int(math.ceil(n / len(loop))))
    out = np.array(loop[:n], dtype=np.float64)
    out = _fade_edges(out, 0.9)
    peak = float(np.max(np.abs(out))) or 1.0
    return np.clip(out * (10 ** (PEAK_TARGET_DBFS / 20.0) / peak) * gain,
                   -1.0, 1.0).astype(np.float32)


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

    # --- groove: the 124 BPM bed -------------------------------------------
    g = np.asarray(build_groove(bars=8), dtype=np.float64)
    bar_s = _bar_s()
    check(f"groove runs at {BPM} BPM to the sample",
          abs(len(g) / SR - 8 * bar_s) < 0.002)
    check("groove peaks on the -18 dBFS target",
          -19.5 <= analyze(g)["peak_dbfs"] <= -16.5)

    gst = analyze(g)
    check(f"groove keeps the narration band open "
          f"({gst['speech_band_energy_pct']}%)",
          gst["speech_band_energy_pct"] < 3.0)

    # A loop with a click at the join is not a loop. Compare the jump at the
    # seam against the jumps everywhere else in the track.
    d = np.abs(np.diff(np.concatenate([g, g])))
    check("the loop seam is not a click",
          float(d[len(g) - 1]) <= float(np.percentile(d, 99.9)))

    # A mix that collapsed into sub-bass would still pass every check above,
    # so check the top end is actually present: hats and arp must carry real
    # level, not be buried under the kick.
    spec = np.abs(np.fft.rfft(g * np.hanning(len(g)))) ** 2
    fr = np.fft.rfftfreq(len(g), 1.0 / SR)
    hi = float(spec[(fr >= 3400) & (fr < 16000)].sum())
    lo = float(spec[(fr >= 20) & (fr < 300)].sum()) or 1.0
    check(f"the top end survives the mix (hi/lo ratio {hi / lo:.4f})",
          hi / lo > 1e-4)

    check("the same seed renders the same groove",
          np.array_equal(np.asarray(build_groove(bars=8)), g.astype(np.float32)))
    check("a different seed renders a different groove",
          not np.array_equal(np.asarray(build_groove(bars=8, seed=99)),
                             g.astype(np.float32)))

    cut = groove_for(5.0)
    check("groove_for cuts to an exact duration",
          abs(len(cut) / SR - 5.0) < 0.002)
    check("a groove cut for video starts and ends in silence",
          abs(float(cut[0])) < 1e-3 and abs(float(cut[-1])) < 1e-3)

    check("voice_notch attenuates the speech band and leaves the rest alone",
          analyze(voice_notch(np.asarray(_sine(1000, SR), dtype=np.float64))
                  )["rms_dbfs"] <
          analyze(np.asarray(_sine(1000, SR), dtype=np.float64))["rms_dbfs"] - 6)

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
    ap.add_argument("--demo", help="write a 30s audition of every drone cue here")
    ap.add_argument("--groove", help="write a seamless 124 BPM loop here")
    ap.add_argument("--minutes", type=float, default=4.0,
                    help="length of --groove, rounded to whole bars (default 4)")
    ap.add_argument("--seed", type=int, default=7,
                    help="change it for a different variation of the same palette")
    ap.add_argument("--notch", type=float, default=-9.0,
                    help="dB carved out of the narration band (default -9)")
    ap.add_argument("--self-test", action="store_true")
    a = ap.parse_args()
    if a.self_test:
        sys.exit(self_test())
    if a.groove:
        bars = max(8, int(round(a.minutes * 60.0 / _bar_s())))
        print(f"rendering {bars} bars at {BPM} BPM "
              f"({bars * _bar_s() / 60:.2f} min), seed {a.seed}…")
        g = build_groove(bars=bars, seed=a.seed, notch_db=a.notch)
        write_wav(a.groove, g)
        st = analyze(g)
        print(f"-> {a.groove}")
        print(f"   {st['seconds']}s · peak {st['peak_dbfs']} dBFS · "
              f"rms {st['rms_dbfs']} dBFS")
        print(f"   {st['speech_band_energy_pct']}% of energy in the narration "
              f"band · loops seamlessly")
        return
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
