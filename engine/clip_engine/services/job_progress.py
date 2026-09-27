"""Measured stage progress. Provider calls with no denominator stay indeterminate."""
import time

AUTOMATIC = ['download', 'source_context', 'transcription', 'planning', 'reviewing', 'rendering', 'saving', 'preview']
REVIEW = ['download', 'source_context', 'transcription', 'planning', 'preparing', 'saving', 'preview']
STATUS_STAGE = {'downloading': 'download', 'contextualizing': 'source_context', 'transcribing': 'transcription',
                'planning': 'planning', 'rendering': 'rendering', 'uploading': 'saving'}


class StageProgress:
    def __init__(self, review=False, clock=time.monotonic):
        self.clock = clock
        self.rows = {key: {'id': key, 'state': 'pending', 'percent': None, 'elapsed_ms': 0} for key in (REVIEW if review else AUTOMATIC)}
        self.active = None
        self.started = None

    def update(self, status, stage=None, percent=None, completed=None, total=None, unit=None):
        if status in ('completed', 'failed', 'cancelled'):
            if self.active:
                row = self.rows[self.active]
                row['elapsed_ms'] = round((self.clock() - self.started) * 1000)
                row['state'] = 'completed' if status == 'completed' else status
                if status == 'completed': row['percent'] = 100
            self.active = None
            for row in self.rows.values():
                if row['state'] == 'pending' and status == 'completed': row['state'] = 'skipped'
            return self.snapshot()
        key = stage or STATUS_STAGE.get(status)
        if key not in self.rows:
            return self.snapshot()
        if key != self.active:
            if self.active:
                previous = self.rows[self.active]
                previous.update(state='completed', percent=100, elapsed_ms=round((self.clock() - self.started) * 1000))
            self.active, self.started = key, self.clock()
        row = self.rows[key]
        row.update(state='running', percent=percent)
        for name, value in [('completed', completed), ('total', total), ('unit', unit)]:
            if value is None: row.pop(name, None)
            else: row[name] = value
        return self.snapshot()

    def snapshot(self):
        rows = [dict(row) for row in self.rows.values()]
        for row in rows:
            if row['id'] == self.active:
                row['elapsed_ms'] = round((self.clock() - self.started) * 1000)
        return rows
