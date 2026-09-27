"""Local, every-frame cut suggestions. Never edits a user's layouts."""
import math
import re
from .media_process import MEDIA_INPUT_OPTIONS, media_process

MAX_FRAMES = 120000
MAX_MARKERS = 5000
MIN_SCORE = .025


def scan_camera_changes(source, start_ms, end_ms, progress=None):
    # Include context so a cut at the beginning of the kept interval is scored.
    start_ms = round(max(0, start_ms - 1000), 3)
    end_ms = round(end_ms, 3)
    frames, markers = [], []
    reported = 0
    if progress:
        progress(0)
    cmd = ['ffmpeg', '-nostdin', '-v', 'error', '-ss', f'{start_ms / 1000:.6f}',
           *MEDIA_INPUT_OPTIONS, '-i', str(source), '-t', f'{(end_ms - start_ms) / 1000:.6f}',
           '-map', '0:v:0', '-an', '-sn', '-dn', '-vf',
           "scale=320:-2,settb=1/1000000,select='gte(scene,0)',metadata=mode=print:file='pipe\\:1'",
           '-fps_mode', 'passthrough', '-f', 'null', '-']
    at = None
    with media_process(cmd, timeout=20 * 60) as (process, _):
        while raw := process.stdout.readline(1025):
            if len(raw) > 1024:
                raise ValueError('Invalid camera scan output')
            line = raw.decode('ascii', errors='replace').strip()
            match = re.match(r'frame:\d+\s+pts:(-?\d+)\s', line)
            if match:
                # Integer microsecond PTS avoids pts_time's six significant digits
                # losing sub-frame precision late in a long source.
                at = round(start_ms + int(match[1]) / 1000, 3)
                if at < start_ms or at > end_ms or (frames and at <= frames[-1]):
                    at = None
                    continue
                frames.append(at)
                percent = min(99, int((at - start_ms) / max(1, end_ms - start_ms) * 100))
                if progress and percent > reported:
                    reported = percent
                    progress(percent)
                if len(frames) > MAX_FRAMES:
                    raise ValueError('Camera scan is too long')
            elif at is not None and line.startswith('lavfi.scene_score='):
                score = float(line.split('=', 1)[1])
                if not math.isfinite(score) or not 0 <= score <= 1:
                    raise ValueError('Invalid camera score')
                if score >= MIN_SCORE:
                    markers.append({'at_ms': at, 'score': score})
                    if len(markers) > MAX_MARKERS:
                        raise ValueError('Too many camera changes')
        if process.wait() != 0:
            raise ValueError('Camera scan failed')
    if not frames:
        raise ValueError('Camera scan has no video frames')
    if progress:
        progress(100)
    return {'start_ms': start_ms, 'end_ms': end_ms, 'frames': frames, 'markers': markers}
