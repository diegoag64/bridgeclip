"""Bounded, local refinement of layout boundaries using decoded source frames."""
from bisect import bisect_left, bisect_right

MAX_DETAIL_FRAMES = 6000
MAX_HINTS = 160


def detail_indices(scan, hints):
    """Only run additional face detection around likely changes, not every frame."""
    times = scan['frames']
    selected = set()
    for t in hints[:MAX_HINTS]:
        selected.update(range(bisect_left(times, t - 300), bisect_right(times, t + 350)))
    if len(selected) > MAX_DETAIL_FRAMES:
        raise ValueError('Too many detailed layout frames')
    return sorted(selected)


def select_expression(indices):
    # Balanced expressions avoid FFmpeg's parser depth limit on long sums.
    runs = []
    for n in indices:
        if runs and n == runs[-1][1] + 1:
            runs[-1][1] = n
        else:
            runs.append([n, n])
    terms = [f'between(n,{a},{b})' for a, b in runs]
    while len(terms) > 1:
        terms = [f'({terms[i]}+{terms[i+1]})' if i + 1 < len(terms) else terms[i]
                 for i in range(0, len(terms), 2)]
    return terms[0] if terms else '0'


def confirmed_cuts(markers, frames, duration_ms, evidence):
    """Strong cuts or abrupt, sustained composition changes; keep weak hints for review."""
    accepted = []
    for i, marker in enumerate(markers):
        t, score = marker['at_ms'], marker['score']
        if not 0 < t < duration_ms:
            continue
        # Flash on/off pairs and very brief inserts should not cause crop flicker.
        if any(abs(t - other['at_ms']) < 150 for other in markers[max(0, i-1):i+2] if other is not marker and other['score'] >= max(.12, score * .6)):
            continue
        before = [f for f in frames if t - 250 <= f.t_ms < t]
        after = [f for f in frames if t <= f.t_ms <= t + 350]
        stable = len(after) >= 3 and after[-1].t_ms - after[0].t_ms >= 180
        changed = False
        if before and stable:
            old, new = evidence(before[-1]), evidence(after[0])
            changed = old is not None and new is not None and old != new and all(evidence(f) == new for f in after)
            # A relocated/enlarged face needs a discontinuity followed by a stable
            # position. Ordinary gradual tracking or a momentary dropout is not a cut.
            if not changed and score >= .04 and all(len(f.faces) == 1 for f in [before[-1], *after]):
                a, b = before[-1].faces[0], after[0].faces[0]
                jump = abs(a.cx - b.cx) > .22 or abs(a.cy - b.cy) > .22 or max(a.h, b.h) / max(.001, min(a.h, b.h)) > 1.8
                settled = all(abs(f.faces[0].cx - b.cx) < .05 and abs(f.faces[0].cy - b.cy) < .05 and abs(f.faces[0].h - b.h) < .05 for f in after)
                changed = jump and settled
        if score >= .15 or changed:
            if not accepted or t - accepted[-1] >= 150:
                accepted.append(t)
    return accepted


def align_boundaries(cuts, markers, duration_ms):
    """Refine existing evidence to a nearby observed change without inventing a cut."""
    aligned = {0, duration_ms}
    for t in cuts:
        if not 0 < t < duration_ms:
            continue
        nearby = [m for m in markers if 0 < m['at_ms'] < duration_ms and abs(m['at_ms'] - t) <= 250]
        aligned.add(min(nearby, key=lambda m: (abs(m['at_ms'] - t), -m['score']))['at_ms'] if nearby else t)
    return sorted(aligned)
