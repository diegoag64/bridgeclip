"""Per-run, bounded usage and preparation timings. Never records prompts or credentials."""
import math
import re
import time
from contextvars import ContextVar
from contextlib import contextmanager

CURRENT = ContextVar('run_diagnostics', default=None)
PHASES = ('sampling', 'camera_scan', 'face_tracking', 'vision', 'jev')


def number(value):
    # Reject huge JSON integers before math.isfinite coerces them to float.
    return value if type(value) in (int, float) and 0 <= value <= 1e12 and math.isfinite(value) else None


class RunDiagnostics:
    def __init__(self, clock=time.monotonic):
        self.clock, self.models, self.stage = clock, {}, 'planning'
        self.preparation = None
        self.phase_started = None
        self.phase_totals = {phase: 0 for phase in PHASES}

    def candidate(self, index, total, duration_ms):
        self.phase(None)
        self.preparation = {'candidate': index, 'total': total, 'source_duration_ms': duration_ms,
                            'phase': None, 'percent': None}

    def phase(self, phase, percent=None):
        if self.preparation is None:
            return
        old = self.preparation['phase']
        now = self.clock()
        if old != phase:
            if old is not None:
                self.phase_totals[old] += (now - self.phase_started) * 1000
            self.phase_started = now if phase is not None else None
        self.preparation.update(phase=phase, percent=percent)

    def snapshot(self):
        result = {'models': [dict(row) for row in self.models.values()]}
        if self.preparation is not None:
            totals = dict(self.phase_totals)
            phase = self.preparation['phase']
            elapsed = max(0, (self.clock() - self.phase_started) * 1000) if phase else 0
            if phase:
                totals[phase] += elapsed
            result['preparation'] = {**self.preparation, 'phase_elapsed_ms': round(elapsed),
                                     'timings': {key: round(value) for key, value in totals.items()}}
        return result


@contextmanager
def model_request(model):
    tracker = CURRENT.get()
    data = {}
    if tracker is None or not isinstance(model, str) or not re.fullmatch(r'[\w./:@+-]{1,160}', model):
        yield data
        return
    key = (tracker.stage, model)
    if key not in tracker.models and len(tracker.models) >= 64:
        yield data
        return
    row = tracker.models.setdefault(key, {'stage': tracker.stage, 'model': model, 'requests': 0, 'active': 0,
        'failed': 0, 'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0, 'elapsed_ms': 0,
        'unknown_usage': 0, 'unknown_cost': 0})
    row['requests'] += 1
    row['active'] += 1
    started = tracker.clock()
    try:
        yield data
    finally:
        row['active'] -= 1
        row['elapsed_ms'] += max(0, round((tracker.clock() - started) * 1000))
        row['failed'] += int(not data.get('success', False))
        inputs, outputs, cost = (number(data.get(key)) for key in ('input_tokens', 'output_tokens', 'cost_usd'))
        row['unknown_usage'] += int(inputs is None or outputs is None)
        row['unknown_cost'] += int(cost is None)
        row['input_tokens'] += inputs or 0
        row['output_tokens'] += outputs or 0
        row['cost_usd'] += cost or 0
