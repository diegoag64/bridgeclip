"""Deterministic recorded-run fixture. No remote media or provider calls."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import cv2
import numpy as np

from clip_engine.services import layout_analyzer as module
from clip_engine.services.layout_analyzer import Box, FrameInfo, LayoutAnalyzer
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.framing_trace import make_trace
from clip_engine.services.rendering_service import RenderRequest

CAM = Box(.08, .78, .05, .09)
HEAD = Box(.43, .20, .14, .30)


def recorded_fixture():
    histogram = np.zeros((24, 16), np.float32)
    histogram[1, 1] = 1
    frames = [FrameInfo(t, [] if t in (6250, 6500) else [HEAD if 4000 <= t < 8000 else CAM],
                        histogram, [] if t in (6250, 6500) else [.973]) for t in range(0, 12000, 250)]
    images = [cv2.imencode('.jpg', np.full((90, 160, 3), color, np.uint8))[1].tobytes()
              for color in [(80, 30, 10), (10, 80, 150)]]
    keys = [(t, images[int(4000 <= t < 8000)]) for t in range(0, 12000, 1000)]
    replies = [dict(layout='screen_cam', cam_box=[650, 10, 980, 260], screen_box=[0, 0, 1000, 1000], screen_focus=[], people=[]),
               dict(layout='talking_head', cam_box=[], screen_box=[], screen_focus=[], people=[[100, 350, 700, 650]])]
    # Extra provider fields must never enter the persisted record.
    for reply in replies:
        reply['private_provider_field'] = 'must-not-be-persisted'
    completion = AsyncMock(side_effect=[({'model': 'fixture/model', 'choices': [{'message': {'content': json.dumps(r)}}]}, {'cost': .001}) for r in replies])
    analyzer = LayoutAnalyzer()
    with patch.object(LayoutAnalyzer, 'available', new_callable=lambda: property(lambda _: True)), \
         patch.object(analyzer, '_decode_and_detect', return_value=(frames, keys)), \
         patch.object(analyzer, '_vision_enabled', return_value=True), \
         patch.object(analyzer, '_get_client', new=AsyncMock(return_value=None)), \
         patch.object(module, 'chat_completion', new=completion):
        plan = asyncio.run(analyzer.analyze('fixture.mp4', 2000, 12000, 640, 360, capture=True))
    request = RenderRequest(video_path='fixture.mp4', output_path='clip.mp4', start_time_ms=2300,
                            end_time_ms=13500, source_width=640, source_height=360, debug_capture=True, skip_ranges_ms=[(7000, 8500)])
    settings = SimpleNamespace(layout_vision_enabled=True, layout_vision_model='fixture/model')
    time_map = TimeMap([(0, 5000), (6500, 12000)], 12000)
    trace = make_trace(request, plan, plan, plan, time_map, 2000, 12000, 360, 640, '30',
                       [dict(fallback=None, status='rendered', failure=None)], settings)
    trace['clip_index'] = 0
    trace['source'].update(duration_ms=16000, preview_status='available')
    return trace, plan, completion.call_count


if __name__ == '__main__':
    root = Path(__file__).resolve().parents[2]
    (root / 'tests/fixtures/framing/trace.json').write_text(json.dumps(recorded_fixture()[0], indent=2) + '\n')

    import sys
    if len(sys.argv) > 1:
        import subprocess
        from clip_engine.services.rendering_service import RenderingService
        from clip_engine.services.layout_renderer import build_layout_graph
        destination = Path(sys.argv[1]).resolve()
        destination.mkdir(parents=True, exist_ok=True)
        raw_source = destination / 'original.mp4'
        proc = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'bgr24',
                                 '-s', '640x360', '-r', '30', '-i', 'pipe:0', '-an', '-c:v', 'libx264',
                                 '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(raw_source)], stdin=subprocess.PIPE)
        for n in range(16 * 30):
            frame = np.full((360, 640, 3), (35, 25, 18), np.uint8)
            for x in range(0, 640, 40):
                cv2.line(frame, (x, 0), (x, 360), (55, 42, 28), 1)
            for y in range(0, 360, 40):
                cv2.line(frame, (0, y), (640, y), (55, 42, 28), 1)
            head = 6 <= n / 30 < 10
            face = HEAD if head else CAM
            if not head:
                cv2.rectangle(frame, (6, 234), (166, 353), (65, 45, 40), -1)
            x, y, w, h = [round(v * d) for v, d in zip(face.to_list(), [640, 360, 640, 360])]
            cv2.ellipse(frame, (x + w//2, y + h//2), (w//2, h//2), 0, 0, 360, (100, 165, 230), -1)
            cv2.putText(frame, 'FULL SCREEN' if head else 'SHARED SCREEN + WEBCAM', (180, 310 if head else 110), cv2.FONT_HERSHEY_SIMPLEX, .6, (220, 210, 200), 1)
            cv2.putText(frame, f'Source {n/30:05.2f}s', (440, 338), cv2.FONT_HERSHEY_SIMPLEX, .5, (220, 210, 200), 1)
            proc.stdin.write(frame.tobytes())
        proc.stdin.close()
        if proc.wait(timeout=30):
            raise RuntimeError('Fixture source encode failed')
        service = RenderingService()
        with patch.object(service.settings, 'local_mode', False):
            asyncio.run(service.capture_framing_source(str(raw_source), str(destination / 'source.mp4')))
        trace, plan, _ = recorded_fixture()
        graph = build_layout_graph(plan, 360, 640, keeps=[(0, 5000), (6500, 12000)])
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', '2', '-t', '12', '-i', str(raw_source),
                        '-filter_complex', graph, '-map', '[base]', '-an', '-c:v', 'libx264',
                        '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', str(destination / 'clip.mp4')], check=True, timeout=30)
