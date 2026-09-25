"""Recorded, deterministic editorial inspector fixture; no paid provider calls."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

from tests.framing_fixture import recorded_fixture
from tests.test_editorial_context import segment, service
from clip_engine.services.editorial_context import analyze_reactions, record_prevented_cuts, window_protection
from clip_engine.services.editorial_review import review_retained_clip
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.framing_trace import make_trace
from clip_engine.services.rendering_service import RenderRequest


def editorial_fixture():
    _, plan, _ = recorded_fixture()
    transcript = [segment(4000, 6000, 'Watch this demonstration.'), segment(10000, 13000, 'That was the part I meant. Now the reaction makes sense.')]
    client, _ = service()
    async def evaluate():
        report = await analyze_reactions(transcript, 2000, 14000, client)
        await review_retained_clip(client, 'A demonstration and its reaction', transcript, report)
        report['retained_source'] = [[2000, 14000]]
        return report
    report = asyncio.run(evaluate())
    # Wall clock is not deterministic; the example records representative
    # timings rather than fixture execution speed.
    for candidate in report['candidates']:
        for judgment in [candidate['judgment'], *candidate['judgment_history']]:
            judgment['latency_ms'] = 125
    report['qa']['judgment']['latency_ms'] = 125
    record_prevented_cuts(report, [(0, 5000), (6500, 12000)], [(5000, 6500)],
                          window_protection(report, 2000, 12000), 2000, 12000, plan)
    request = RenderRequest(video_path='fixture.mp4', output_path='clip.mp4', start_time_ms=2000, end_time_ms=14000,
                            source_width=640, source_height=360, editorial_context=report, skip_ranges_ms=[(7000, 8500)])
    trace = make_trace(request, plan, plan, plan, TimeMap([(0, 12000)], 12000), 2000, 12000, 360, 640, '30',
                       [dict(fallback=None, status='rendered', failure=None)],
                       SimpleNamespace(layout_vision_enabled=True, layout_vision_model='fixture/model'))
    trace['clip_index'] = 0
    trace['source'].update(duration_ms=16000, preview_status='available')
    return trace, plan


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    destination = root / 'tests/fixtures/editorial'
    destination.mkdir(exist_ok=True)
    (destination / 'trace.json').write_text(json.dumps(editorial_fixture()[0], indent=2) + '\n')
