"""Real decoded frames exercise the pipeline's new refinement pass."""
import asyncio
import numpy as np
import pytest
from clip_engine.services.layout_analyzer import LayoutAnalyzer, Box, FrameInfo, frame_layout_evidence
from clip_engine.services.layout_precision import confirmed_cuts, detail_indices, select_expression
from .test_camera_scan import source_video, ffmpeg


def frame(t, x=.2, faces=True):
    return FrameInfo(t, [Box(x, .2, .15, .3)] if faces else [], np.zeros((24, 16), np.float32))


def test_weak_visual_hint_needs_sustained_abrupt_face_change():
    marker = [{'at_ms': 500, 'score': .05}]
    stable = [frame(450), *[frame(t, .65) for t in (500, 550, 600, 700, 800)]]
    assert confirmed_cuts(marker, stable, 1000, frame_layout_evidence) == [500]
    moving = [frame(450), *[frame(t, .2 + i * .04) for i, t in enumerate((500, 550, 600, 700, 800))]]
    assert confirmed_cuts(marker, moving, 1000, frame_layout_evidence) == []
    dropout = [frame(450), frame(500, faces=False), frame(550), frame(700), frame(800)]
    assert confirmed_cuts(marker, dropout, 1000, frame_layout_evidence) == []


def test_flash_pair_is_not_an_automatic_layout_change():
    assert confirmed_cuts([{'at_ms': 500, 'score': .4}, {'at_ms': 550, 'score': .4}], [], 1000, frame_layout_evidence) == []


def test_detail_budget_is_bounded_and_select_expression_balanced():
    with pytest.raises(ValueError, match='Too many'):
        detail_indices({'frames': list(range(10000))}, list(range(0, 10000, 300)))
    expression = select_expression(list(range(0, 1000, 2)))
    assert expression.count('between') == 500
    depth = maximum = 0
    for char in expression:
        depth += (char == '(') - (char == ')')
        maximum = max(maximum, depth)
    assert maximum < 12


@pytest.mark.parametrize('start', [0, 217, 503])
@pytest.mark.parametrize('vfr', [False, True])
def test_pipeline_refines_real_fractional_frames_and_retains_scan(tmp_path, monkeypatch, start, vfr):
    source = source_video(tmp_path, vfr=vfr)
    analyzer = LayoutAnalyzer()
    monkeypatch.setattr(analyzer, '_get_detector', lambda *_: None)
    original = analyzer._frame_info
    class NoFaces:
        def detect(self, image): return None, None
    def observed(image, t, detector, width, height):
        result = original(image, t, NoFaces(), width, height)
        # Deterministic face cues isolate timestamp correctness from ML accuracy.
        b, g, r = image[height // 2, width // 4].astype(int)
        result.faces = [Box(.65 if r > 200 and g > 200 else .2, .2, .15, .3)]
        result.content_box = None
        return result
    monkeypatch.setattr(analyzer, '_frame_info', observed)
    updates = []
    plan = asyncio.run(analyzer.analyze(str(source), start, 2400-start, 160, 90, vision=False, capture=True,
                                        progress=lambda message, value: updates.append((message, value))))
    assert plan.camera_scan
    cuts = [m['at_ms'] - start for m in plan.camera_scan['markers'] if start < m['at_ms'] < 2400]
    assert len(cuts) == 2
    accepted = [b['t_ms'] for b in plan.trace['boundaries'] if b['kind'] == 'precise_scene']
    assert accepted == pytest.approx(cuts, abs=.002)
    for cut in cuts:
        sample = next(f for f in plan.face_samples if abs(f[0]-cut) < .002)
        assert sample[1][0].x == (.65 if cut == cuts[0] else .2)
    assert any(message == 'Refining face tracking' for message, _ in updates)
    if start == 0 and not vfr:
        from types import SimpleNamespace
        from unittest.mock import AsyncMock
        from clip_engine.services.manual_editor import prepare_project, validate_candidate
        from clip_engine.services.rendering_service import RenderingService
        from clip_engine.services.intelligence_planner import ClipPlanSegment
        from .test_manual_editor import reviewer
        gate, _ = reviewer(lambda state, q: True)
        renderer = RenderingService()
        monkeypatch.setattr(renderer.layout_analyzer, 'analyze', AsyncMock(return_value=plan))
        run = tmp_path / 'run'
        run.mkdir()
        request = SimpleNamespace(aspect_ratio='9:16', layout_style='auto', include_captions=True, caption_preset='pop', video_speed=1)
        project = asyncio.run(prepare_project(request, [ClipPlanSegment(0, 2400, .9)], [],
            SimpleNamespace(video_path=str(source), metadata=SimpleNamespace(title='Test', duration_seconds=2.4)),
            renderer, gate, str(run), lambda *_: None))
        candidate = project['candidates'][0]
        assert candidate['camera_scan'] == plan.camera_scan
        assert candidate['dismissed_camera_markers'] == []
        assert [scene['at_ms'] for scene in candidate['scenes'][1:]] == pytest.approx(cuts, abs=.002)
        validate_candidate(candidate, 2400)

    from clip_engine.services.layout_renderer import build_layout_graph
    graph = build_layout_graph(plan, 40, 44, fps='24000/1001')
    args = ['-ss', str(start/1000), '-t', str((2400-start)/1000), '-i', str(source)]
    raw = ffmpeg([*args, '-filter_complex', graph, '-map', '[base]', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    output = np.frombuffer(raw, np.uint8).reshape(-1, 44, 40, 3)
    raw = ffmpeg([*args, '-vf', 'fps=24000/1001:start_time=0:round=near', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    reference = np.frombuffer(raw, np.uint8).reshape(-1, 90, 160, 3)
    for i, image in enumerate(reference[:len(output)]):
        left = image[45, 40].astype(int)
        expected = image[45, 120] if left[0] > 200 and left[1] > 200 else left
        assert output[i, 22, 20] == pytest.approx(expected.astype(int), abs=12), (i, start, vfr)



def test_vision_budget_still_allows_cached_layouts(monkeypatch):
    import cv2
    from clip_engine.services.layout_analyzer import ShotLayout, LayoutType
    analyzer = LayoutAnalyzer()
    image = np.full((90, 160, 3), 100, np.uint8)
    _, encoded = cv2.imencode('.jpg', image)
    hist = cv2.calcHist([cv2.cvtColor(image, cv2.COLOR_BGR2HSV)], [0, 1], None, [24, 16], [0, 180, 0, 256])
    cv2.normalize(hist, hist)
    shot = ShotLayout(0, 1000, LayoutType.SCREEN)
    answer = {'layout': 'screen'}
    analyzer._vision_cache = [(hist, (LayoutType.SCREEN, ()), answer, {})]
    diagnostic = {}
    assert asyncio.run(analyzer._vision_classify(encoded.tobytes(), [], shot, diagnostic, cache_only=True)) == (answer, 0)
    assert diagnostic['cache_hit'] is True
    analyzer._vision_cache.clear()
    assert asyncio.run(analyzer._vision_classify(encoded.tobytes(), [], shot, diagnostic, cache_only=True)) == (None, 0)
    assert diagnostic['status'] == 'budget_limited'


def test_analysis_bounds_optional_paid_decisions_for_many_short_shots(monkeypatch):
    analyzer = LayoutAnalyzer()
    frames = [frame(t, .2 if (t // 500) % 2 else .65) for t in range(0, 8000, 50)]
    images = [(t, b'fake') for t in range(0, 8000, 500)]
    scan = {'frames': [f.t_ms for f in frames], 'markers': [{'at_ms': t, 'score': .2} for t in range(500, 8000, 500)]}
    monkeypatch.setattr(analyzer, '_decode_and_detect', lambda *_: (frames, images))
    monkeypatch.setattr(analyzer, '_precise_frames', lambda *_: (scan, frames, images))
    monkeypatch.setattr(analyzer, '_vision_enabled', lambda: True)
    modes = []
    async def classify(*_, cache_only=False):
        modes.append(cache_only)
        return None, 0
    monkeypatch.setattr(analyzer, '_vision_classify', classify)
    asyncio.run(analyzer.analyze('fixture.mp4', 0, 8000, 160, 90))
    assert len(modes) == 16
    assert modes == [False] * 12 + [True] * 4


def test_sparse_detail_selection_bounds_input_and_preserves_selected_frames(tmp_path, monkeypatch):
    """No selected frame reaches the requested end; output -t alone cannot stop decoding."""
    from contextlib import contextmanager
    from clip_engine.services import layout_analyzer as module, layout_precision
    from clip_engine.services.camera_scan import scan_camera_changes
    source = source_video(tmp_path)
    analyzer = LayoutAnalyzer()
    scan = scan_camera_changes(source, 0, 2200)
    monkeypatch.setattr(layout_precision, 'detail_indices', lambda *_: [2, 3, 4])
    class NoFaces:
        def detect(self, image): return None, None
    monkeypatch.setattr(analyzer, '_get_detector', lambda *_: NoFaces())
    original = module.media_process
    commands = []
    @contextmanager
    def bounded(cmd, **kwargs):
        commands.append(cmd)
        assert cmd.index('-t') < cmd.index('-i')
        assert float(cmd[cmd.index('-t') + 1]) == pytest.approx(2.2)
        with original(cmd, **kwargs) as process:
            yield process
    monkeypatch.setattr(module, 'media_process', bounded)
    result_scan, frames, _ = analyzer._precise_frames(str(source), 0, 2200, 160, 90, [], [])
    assert len(commands) == 1
    assert [f.t_ms for f in frames] == pytest.approx([scan['frames'][i] for i in [2, 3, 4]])
    assert result_scan['frames'] == scan['frames']
