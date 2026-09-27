"""Every-frame detection and pixel-level checks at fractional/VFR camera cuts."""
import asyncio
import copy
import json
import subprocess
from pathlib import Path
from unittest.mock import AsyncMock

import numpy as np
import pytest
from clip_engine.services.camera_scan import scan_camera_changes
from clip_engine.services.manual_editor import manual_plan, run_editor, atomic_json
from clip_engine.services.layout_renderer import build_layout_graph
from clip_engine.services.rendering_service import RenderingService


def ffmpeg(args, data=None):
    result = subprocess.run(['ffmpeg', '-v', 'error', *args], input=data, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    return result.stdout


def source_video(tmp_path, fps='24000/1001', vfr=False):
    frames = np.zeros((60, 90, 160, 3), dtype=np.uint8)
    for a, b, left, right in [(0, 17, (255, 0, 0), (0, 255, 0)), (17, 35, (255, 255, 0), (0, 0, 255)), (35, 60, (0, 255, 0), (255, 0, 0))]:
        frames[a:b, :, :80] = left; frames[a:b, :, 80:] = right
    path = tmp_path / 'editor-source.mp4'
    filters = ['-vf', "settb=1/1000000,setpts=PTS+if(gte(N\\,20)\\,50000\\,0)+if(gte(N\\,40)\\,80000\\,0)"] if vfr else []
    ffmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '160x90', '-r', fps, '-i', 'pipe:0', *filters,
            '-fps_mode', 'passthrough', '-enc_time_base', '1:1000000', '-c:v', 'libx264', '-crf', '12', str(path)], frames.tobytes())
    return path


@pytest.mark.parametrize('fps', ['24000/1001', '30000/1001', '60'])
@pytest.mark.parametrize('vfr', [False, True])
def test_scan_every_frame_and_preview_keeps_exact_source_timestamps(tmp_path, fps, vfr):
    source = source_video(tmp_path, fps, vfr)
    scan = scan_camera_changes(source, 0, 3000)
    assert len(scan['frames']) == 60
    assert [m['at_ms'] for m in scan['markers']] == [scan['frames'][17], scan['frames'][35]]
    assert all(m['score'] > .08 for m in scan['markers'])
    clipped = scan_camera_changes(source, 1600, 2500)
    assert all(600 <= t <= 2500 for t in clipped['frames'])
    for m in clipped['markers']:
        assert min(abs(m['at_ms'] - t) for t in scan['frames']) < .01
    preview = tmp_path / 'preview.mp4'
    asyncio.run(RenderingService().capture_framing_source(str(source), str(preview)))
    scanned_preview = scan_camera_changes(preview, 0, 3000)
    assert scanned_preview['frames'] == pytest.approx(scan['frames'], abs=.002)


@pytest.mark.parametrize('fps', ['24000/1001', '30000/1001'])
@pytest.mark.parametrize('start', [0, 217, 503])
@pytest.mark.parametrize('vfr', [False, True])
@pytest.mark.parametrize('gap', [False, True])
def test_new_crop_starts_on_exact_first_camera_frame_in_real_export(tmp_path, fps, start, vfr, gap):
    source = source_video(tmp_path, fps, vfr)
    scan = scan_camera_changes(source, 0, 3000)
    cuts = [m['at_ms'] for m in scan['markers']]
    candidate = {'ranges': [[start, 2400]], 'scenes': [
        {'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, .5, 1]]},
        {'at_ms': cuts[0], 'layout': 'fill', 'crops': [[.5, 0, .5, 1]]},
        {'at_ms': cuts[1], 'layout': 'fill', 'crops': [[0, 0, .5, 1]]}]}
    # Use the renderer's actual output rate, including a VFR file's average.
    fps = asyncio.run(RenderingService()._probe_fps(str(source)))
    keeps = [(0, 280), (440, 2400 - start)] if gap else None
    graph = build_layout_graph(manual_plan({'width': 160, 'height': 90}, candidate), 40, 44, keeps, fps=fps)
    args = ['-ss', str(start / 1000), '-t', str((2400 - start) / 1000), '-i', str(source)]
    out = ffmpeg([*args, '-filter_complex', graph, '-map', '[base]', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    out = np.frombuffer(out, np.uint8).reshape(-1, 44, 40, 3)
    if gap:
        # The camera and crop must agree after removing footage too. Yellow
        # or red on the right half reveals a one-frame layout mismatch.
        allowed = [(255, 0, 0), (0, 0, 255), (0, 255, 0)]
        for pixel in out[:, 22, 20].astype(int):
            assert any(np.max(np.abs(pixel - color)) < 12 for color in allowed), pixel
        return
    reference = ffmpeg([*args, '-vf', f'fps={fps}:start_time=0:round=near', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'])
    reference = np.frombuffer(reference, np.uint8).reshape(-1, 90, 160, 3)
    for i, frame in enumerate(reference[:len(out)]):
        left = frame[45, 40].astype(int)
        expected = frame[45, 120] if left[0] > 200 and left[1] > 200 else left
        assert out[i, 22, 20] == pytest.approx(expected.astype(int), abs=12), (i, start, fps, vfr, out[i, 22, 20], expected)


def test_scan_persists_without_changing_edits_or_status_and_rescan_preserves_dismissals(tmp_path):
    source_video(tmp_path)
    project = json.loads((Path(__file__).parents[2] / 'tests/fixtures/editor/project.json').read_text())
    project.update(width=160, height=90, duration_ms=3000, transcript=[], frame_preview=True)
    c = project['candidates'][0]
    c.update(ranges=[[100, 2400]], scenes=c['scenes'][:1], caption_edits=[], status='baked')
    project['candidates'] = [c]
    atomic_json(tmp_path / 'editor-project.json', project)
    before = copy.deepcopy(c)
    def scan():
        current = json.loads((tmp_path / 'editor-project.json').read_text())
        asyncio.run(run_editor({'run': str(tmp_path), 'action': 'scan-cameras', 'revision': current['revision'], 'candidate_id': c['id']}))
        return json.loads((tmp_path / 'editor-project.json').read_text())
    saved = scan()
    assert {k: v for k, v in saved['candidates'][0].items() if k not in ('camera_scan', 'dismissed_camera_markers')} == before
    marker = saved['candidates'][0]['camera_scan']['markers'][0]['at_ms']
    saved['candidates'][0]['dismissed_camera_markers'] = [marker]
    atomic_json(tmp_path / 'editor-project.json', saved)
    assert scan()['candidates'][0]['dismissed_camera_markers'] == [marker]


@pytest.mark.parametrize('failure', [RuntimeError('failed'), asyncio.CancelledError()])
def test_failed_preview_upgrade_preserves_previous_scan(tmp_path, monkeypatch, failure):
    source_video(tmp_path)
    project = {'version': 1, 'revision': 1, 'duration_ms': 3000, 'transcript': [], 'candidates': [
        {'id': 'c', 'title': 'Test', 'ranges': [[0, 2400]], 'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}], 'video_speed': 1, 'captions': False}]}
    atomic_json(tmp_path / 'editor-project.json', project)
    monkeypatch.setattr(RenderingService, 'capture_framing_source', AsyncMock(side_effect=failure))
    with pytest.raises(type(failure)):
        asyncio.run(run_editor({'run': str(tmp_path), 'action': 'scan-cameras', 'revision': 1, 'candidate_id': 'c'}))
    assert json.loads((tmp_path / 'editor-project.json').read_text()) == project
    assert not list(tmp_path.glob('editor-preview*'))


def test_oversized_scan_fails_instead_of_silently_missing_later_frames(tmp_path, monkeypatch):
    from clip_engine.services import camera_scan
    source = source_video(tmp_path)
    monkeypatch.setattr(camera_scan, 'MAX_FRAMES', 10)
    with pytest.raises(ValueError, match='too long'):
        scan_camera_changes(source, 0, 3000)


def test_adding_layouts_cannot_change_which_source_frames_are_exported():
    from clip_engine.services.layout_renderer import video_frame_pieces
    project = {'width': 160, 'height': 90}
    scene = {'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, .5, 1]]}
    c = {'ranges': [[0, 280], [440, 2400]], 'scenes': [scene]}
    split = {**c, 'scenes': [scene, {**scene, 'at_ms': 709.042}, {**scene, 'at_ms': 1509.792}]}
    keeps = [(0, 280), (440, 2400)]
    def frames(candidate):
        return [n for _, first, count in video_frame_pieces(manual_plan(project, candidate), keeps, '24000/1053') for n in range(first, first + count)]
    assert frames(c) == frames(split)


def test_real_scan_and_preview_report_measured_monotonic_progress(tmp_path):
    source = source_video(tmp_path)
    scan_progress, preview_progress = [], []
    scan_camera_changes(source, 0, 2500, progress=scan_progress.append)
    asyncio.run(RenderingService().capture_framing_source(
        str(source), str(tmp_path / 'preview.mp4'),
        progress=preview_progress.append, duration_ms=2500))
    for updates in [scan_progress, preview_progress]:
        assert updates[0] == 0
        assert updates[-1] == 100
        assert updates == sorted(set(updates))
        assert any(0 < p < 100 for p in updates)


def test_failed_scan_does_not_report_complete(tmp_path, monkeypatch):
    from clip_engine.services import camera_scan
    source = source_video(tmp_path)
    monkeypatch.setattr(camera_scan, 'MAX_FRAMES', 10)
    updates = []
    with pytest.raises(ValueError):
        scan_camera_changes(source, 0, 2500, progress=updates.append)
    assert updates[0] == 0
    assert 100 not in updates
