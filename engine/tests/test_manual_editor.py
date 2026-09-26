"""Manual review retains failed candidates and exports exactly the selected edit."""
import asyncio
import copy
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from clip_engine.services.manual_editor import prepare_project, review_candidate, manual_plan, validate_candidate, run_editor, signature, scene_motion, caption_transcript
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from clip_engine.services.coherence_review import CLIP_QUESTIONS, CUT_QUESTIONS
from clip_engine.services.layout_renderer import build_layout_graph, shot_views
from clip_engine.services.intelligence_planner import ClipPlanSegment
from clip_engine.services.rendering_service import RenderRequest, RenderingService, RenderingError
from tests.test_coherence_review import reviewer, transcript


def candidate():
    return {'id': 'candidate-1', 'title': 'The result', 'ranges': [[1000, 5000], [7000, 10000]],
        'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.1, 0, .31640625, 1]]},
                   {'at_ms': 8000, 'layout': 'split', 'crops': [[0, .1, .4, .35555556], [.5, .3, .4, .35555556]]}],
        'captions': True, 'caption_preset': 'pop', 'video_speed': 1.25, 'score': .8, 'reason': '', 'review': None, 'exports': []}


def test_all_jev_questions_and_cut_questions_are_preserved_without_repair():
    gate, calls = reviewer(lambda state, q: False)
    gate.repair = AsyncMock()
    c = candidate()
    original = copy.deepcopy(c)
    asyncio.run(review_candidate(c, gate))
    assert c['ranges'] == original['ranges'] and c['title'] == original['title']
    assert c['review']['decision'] == 'needs_attention'
    assert {q['id'] for q in c['review']['questions']} == set(CLIP_QUESTIONS)
    assert {q['id'] for q in c['review']['cuts'][0]['questions']} == set(CUT_QUESTIONS)
    assert c['review']['cuts'][0]['interval'] == [5000, 7000]
    assert c['review']['signature'] == signature(c)
    assert next(q for q in c['review']['questions'] if q['id'] == 'faithful_to_source')['threshold'] == .65
    gate.repair.assert_not_called()


def test_unavailable_jev_is_not_a_pass_and_still_shows_every_question():
    gate, _ = reviewer()
    gate.service._api_key = ''
    c = candidate()
    asyncio.run(review_candidate(c, gate))
    assert c['review']['decision'] == 'needs_attention'
    assert len(c['review']['questions']) == 8
    assert all(q['probability'] is None for q in c['review']['questions'])


def test_prepare_retains_rejected_candidates_and_does_not_render(tmp_path):
    gate, _ = reviewer(lambda state, q: False)
    source = tmp_path / 'original.mov'
    source.write_bytes(b'original source')
    out = tmp_path / 'run'; out.mkdir()
    async def preview(src, dest): Path(dest).write_bytes(b'preview')
    renderer = SimpleNamespace(_get_video_dimensions=AsyncMock(return_value=(1920, 1080)),
        capture_framing_source=AsyncMock(side_effect=preview), render_clip=AsyncMock())
    request = SimpleNamespace(aspect_ratio='9:16', layout_style='fit', include_captions=True, caption_preset='pop', video_speed=1)
    segments = [ClipPlanSegment(0, 5000, .9, summary='First'), ClipPlanSegment(6000, 11000, .7, summary='Second')]
    project = asyncio.run(prepare_project(request, segments, transcript(), SimpleNamespace(video_path=str(source),
        metadata=SimpleNamespace(title='Original', duration_seconds=12)), renderer, gate, str(out), lambda _: None))
    assert len(project['candidates']) == 2
    assert all(c['status'] == 'refining' and c['caption_edits'] == [] for c in project['candidates'])
    assert all(c['review']['decision'] == 'needs_attention' for c in project['candidates'])
    assert project['candidates'][0]['ranges'] == [[0, 5000]]
    assert (out / 'editor-source.mp4').read_bytes() == b'original source'
    source.write_bytes(b'changed elsewhere')
    assert (out / 'editor-source.mp4').read_bytes() == b'original source'
    renderer.render_clip.assert_not_called()
    assert json.loads((out / 'editor-project.json').read_text())['version'] == 1


def test_manual_crop_geometry_and_layout_switches_survive_cut_mapping():
    c = candidate()
    p = manual_plan({'width': 1920, 'height': 1080}, c)
    assert [(s.start_ms, s.end_ms) for s in p.shots] == [(0, 7000), (7000, 9000)]
    assert shot_views(p.shots[0], 0, 1920, 1080, 1080, 1920) == [((192, 0, 606, 1080), (0, 0, 1080, 1920))]
    graph = build_layout_graph(p, 1080, 1920, [(0, 4000), (6000, 9000)], True)
    assert 'crop=606:1080:192:0' in graph
    assert 'vstack=inputs=2' in graph and 'atrim=start=6.000:end=9.000' in graph


@pytest.mark.parametrize('duration', [-1, 99, 5001, float('inf'), float('nan'), '600', 600.5, None, True])
def test_invalid_movement_fails_before_rendering(duration):
    c = candidate()
    c['scenes'] = [c['scenes'][0], {**copy.deepcopy(c['scenes'][0]), 'at_ms': 2000, 'transition_ms': duration}]
    with pytest.raises(ValueError, match='movement'): validate_candidate(c, 12000)


def test_movement_is_continuous_when_interrupted_and_rejects_incompatible_layouts():
    c = candidate()
    c['scenes'] = [
        {'at_ms': 0, 'layout': 'fill', 'crops': [[0, 0, .4, 1]]},
        {'at_ms': 2000, 'layout': 'fill', 'crops': [[.6, .5, .2, .5]], 'transition_ms': 1000},
        {'at_ms': 2500, 'layout': 'fill', 'crops': [[0, 0, .4, 1]], 'transition_ms': 1000},
    ]
    validate_candidate(c, 12000)
    assert list(scene_motion(c))[2][1][0] == pytest.approx([.3, .25, .3, .75])
    p = manual_plan({'width': 1920, 'height': 1080}, c)
    shot = next(s for s in p.shots if s.start_ms <= 2000 < s.end_ms)
    assert shot_views(shot, 2000, 1920, 1080, 1080, 1920)[0][0] == pytest.approx([288, 134, 672, 944], abs=2)
    animated = signature(c)
    c['scenes'][1]['transition_ms'] = 600
    assert signature(c) != animated
    c['scenes'][0]['layout'] = 'fit'
    with pytest.raises(ValueError, match='movement'): validate_candidate(c, 12000)


@pytest.mark.parametrize('layout', ['fill', 'split'])
@pytest.mark.parametrize('fps', ['30', '30000/1001'])
def test_real_render_moves_and_zooms_on_the_source_clock_across_trim_and_removed_gap(layout, fps):
    """Decoded pixels verify start/middle/end crops, not just filter syntax."""
    import shutil
    import subprocess
    from fractions import Fraction
    import numpy as np
    from clip_engine.services.layout_renderer import video_frame_pieces
    bundled = Path(__file__).resolve().parents[2] / 'engine-bin/ffmpeg'
    ffmpeg = str(bundled) if bundled.exists() else shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('FFmpeg is needed for the actual motion render check')
    c = candidate()
    c['ranges'] = [[1000, 1600], [2000, 2600]]
    origins, targets = [[0, 0, .5, 1]], [[.5, .5, .25, .5]]
    if layout == 'split':
        origins += [[.5, .5, .25, .5]]; targets += [[0, 0, .5, 1]]
    c['scenes'] = [{'at_ms': 0, 'layout': layout, 'crops': origins},
        {'at_ms': 800, 'layout': layout, 'crops': targets, 'transition_ms': 1600}]
    validate_candidate(c, 12000)
    plan = manual_plan({'width': 320, 'height': 180}, c)
    keeps = [(0, 600), (1000, 1600)]
    graph = build_layout_graph(plan, 80, 120, keeps, fps=fps)
    source = np.zeros((180, 320, 3), dtype=np.uint8)
    source[:, :, 0] = np.arange(320)[None, :] * 255 / 320
    source[:, :, 1] = np.arange(180)[:, None] * 255 / 180
    result = subprocess.run([ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '320x180',
        '-r', fps, '-i', 'pipe:0', '-filter_complex', graph, '-map', '[base]', '-pix_fmt', 'rgb24',
        '-f', 'rawvideo', 'pipe:1'], input=source.tobytes() * 60, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()
    frames = np.frombuffer(result.stdout, dtype=np.uint8).reshape(-1, 120, 80, 3)
    pieces = video_frame_pieces(plan, keeps, fps)
    assert len(frames) == sum(count for _, _, count in pieces)
    output_index = 0
    for _, first, count in pieces:
        for frame in range(count):
            source_ms = 1000 + float(Fraction(first + frame, 1) / Fraction(fps) * 1000)
            t = max(0, min(1, (source_ms - 800) / 1600)); ease = t * t * (3 - 2 * t)
            for panel, (origin, target) in enumerate(zip(origins, targets)):
                x, y, w, h = [a + (b - a) * ease for a, b in zip(origin, target)]
                panel_h = 120 // len(origins)
                # Two distinct points also detect incorrect zoom/aspect, not just pan.
                for u, v in [(.25, .25), (.75, .75)]:
                    pixel = frames[output_index, panel * panel_h + int(panel_h * v), int(80 * u)]
                    assert pixel[:2] == pytest.approx([(x + w * u) * 255, (y + h * v) * 255], abs=5), (source_ms, panel, pixel)
            output_index += 1


@pytest.mark.parametrize('patch', [
    {'ranges': [[2000, 1000]]}, {'ranges': [[0, 3000], [2000, 4000]]}, {'ranges': [[0, float('nan')]]},
    {'video_speed': 0}, {'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.8, 0, .4, 1]]}]},
    {'scenes': [{'at_ms': 1, 'layout': 'fill', 'crops': [[0, 0, 1, 1]]}]}
])
def test_invalid_manual_edits_fail_before_rendering(patch):
    c = {**candidate(), **patch}
    with pytest.raises(ValueError): validate_candidate(c, 12000)


@pytest.mark.parametrize('patch', [
    {'status': 'published'}, {'status': None}, {'caption_edits': None},
    {'caption_edits': [{'segment': 4, 'text': 'outside source'}]},
    {'caption_edits': [{'segment': True, 'text': 'not an index'}]},
    {'caption_edits': [{'segment': 0, 'text': 'a'}, {'segment': 0, 'text': 'b'}]},
    {'caption_edits': [{'segment': 0, 'text': 'x' * 2001}]},
    {'caption_edits': [{'segment': 0, 'text': 'bad\x00text'}]},
    {'caption_edits': [{'segment': i, 'text': ''} for i in range(2001)]},
])
def test_invalid_caption_edits_and_states_are_rejected(patch):
    with pytest.raises(ValueError): validate_candidate({**candidate(), **patch}, 12000, 4)


def test_caption_corrections_preserve_word_timing_without_mutating_source():
    source = [TranscriptSegment(0, 2000, 'The event happened.', words=[
        TranscriptWord('The', 100, 400), TranscriptWord('event', 500, 1000), TranscriptWord('happened.', 1200, 1900)
    ], speaker_label='Speaker 1'), TranscriptSegment(3000, 4000, 'Keep this.', words=[TranscriptWord('Keep this.', 3000, 4000)])]
    original = copy.deepcopy(source)
    changed = caption_transcript(source, [{'segment': 0, 'text': '  A\n  correction happened.  '}])
    assert changed[0].text == 'A correction happened.'
    assert [w.word for w in changed[0].words] == ['A', 'correction', 'happened.']
    assert [(w.start_time_ms, w.end_time_ms) for w in changed[0].words] == [(100, 400), (500, 1000), (1200, 1900)]
    assert changed[0].speaker_label == 'Speaker 1'
    changed[1].words[0].word = 'A renderer mutation'
    assert source == original


def test_caption_word_insertions_deletions_and_hidden_lines_use_original_spoken_interval():
    source = [TranscriptSegment(0, 2500, 'Original.', words=[TranscriptWord('Original.', 500, 2000)]),
        TranscriptSegment(3000, 4000, 'No words available.')]
    changed = caption_transcript(source, [{'segment': 0, 'text': 'Café is great!'}, {'segment': 1, 'text': '你好 again'}])
    assert [(w.word, w.start_time_ms, w.end_time_ms) for w in changed[0].words] == [('Café', 500, 1000), ('is', 1000, 1500), ('great!', 1500, 2000)]
    assert [(w.start_time_ms, w.end_time_ms) for w in changed[1].words] == [(3000, 3500), (3500, 4000)]
    fewer = caption_transcript(changed, [{'segment': 0, 'text': 'Great!'}])
    assert [(w.word, w.start_time_ms, w.end_time_ms) for w in fewer[0].words] == [('Great!', 500, 2000)]
    hidden = caption_transcript(source, [{'segment': 0, 'text': ' \n '}])
    assert len(hidden) == 1 and hidden[0].start_time_ms == 3000
    assert len(source) == 2 and source[0].text == 'Original.'


@pytest.mark.parametrize('ranges,speed', [
    ([[1000, 5000], [7000, 10000]], 1.25),
    ([[1000, 1200], [5000, 5200]], 1),  # Two short keeps must not restore the 3.8s gap.
    ([[1000, 1100], [2000, 5000], [6000, 6100]], 1),
    ([[1000, 2000], [3000, 3100], [5000, 6000]], 2),
    ([[1000, 1100]], 1),
])
def test_manual_render_never_replans_or_restores_user_cuts(monkeypatch, tmp_path, ranges, speed):
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda _: None)
    renderer = RenderingService()
    renderer._get_video_dimensions = AsyncMock(return_value=(1920, 1080))
    renderer._plan_layout = AsyncMock(side_effect=AssertionError('No automatic layout'))
    renderer._keep_intervals = lambda *args: pytest.fail('No automatic pacing for manual exports')
    renderer._write_subtitles = AsyncMock(return_value=None)
    c = {**candidate(), 'ranges': ranges, 'video_speed': speed}
    validate_candidate(c, 12000)
    plan = manual_plan({'width': 1920, 'height': 1080}, c)
    calls = []
    async def render(request, plan, time_map, *args):
        calls.append(time_map.keeps)
        Path(request.output_path).write_bytes(b'fixture')
    renderer._render_edit = render
    request = RenderRequest(video_path='source.mp4', output_path=str(tmp_path / 'clip.mp4'), start_time_ms=ranges[0][0],
        end_time_ms=ranges[-1][1], source_width=1920, source_height=1080, apply_padding=False, pacing='natural',
        transcript_segments=transcript(), manual_plan=plan, manual_ranges_ms=ranges, video_speed=speed)
    result = asyncio.run(renderer.render_clip(request))
    assert calls == [[(a - ranges[0][0], b - ranges[0][0]) for a, b in ranges]]
    assert result.duration_ms == round(sum(b - a for a, b in ranges) / speed)
    renderer._render_edit = AsyncMock(side_effect=RenderingError('fixture failure'))
    with pytest.raises(RenderingError): asyncio.run(renderer.render_clip(request))
    assert renderer._render_edit.await_count == 1


def test_export_appends_library_clip_and_preserves_source_and_previous_exports(monkeypatch, tmp_path):
    from dataclasses import asdict
    from clip_engine.services.rendering_service import RenderResult
    c = {**candidate(), 'status': 'ready', 'caption_edits': [{'segment': 1, 'text': 'The corrected event happened.'}]}
    project = {'version': 1, 'revision': 3, 'width': 1920, 'height': 1080, 'duration_ms': 12000, 'aspect_ratio': '9:16', 'candidates': [c],
        'transcript': [{'start_ms': s.start_time_ms, 'end_ms': s.end_time_ms, 'text': s.text} for s in transcript()]}
    (tmp_path / 'editor-project.json').write_text(json.dumps(project))
    (tmp_path / 'editor-source.mp4').write_bytes(b'original')
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': [asdict(s) for s in transcript()]}))
    (tmp_path / 'job_output.json').write_text(json.dumps({'clips': [], 'total_clips': 0, 'editor_project': True}))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda _: None)
    async def render(self, request):
        assert request.apply_padding is False and request.pacing == 'natural'
        assert request.manual_ranges_ms == [(1000, 5000), (7000, 10000)] and request.include_captions
        assert request.transcript_segments[1].text == 'The corrected event happened.'
        assert [w.word for w in request.transcript_segments[1].words] == ['The', 'corrected', 'event', 'happened.']
        Path(request.output_path).write_bytes(b'final clip')
        return RenderResult(request.output_path, 10, 5600, layout_type='two_shot')
    monkeypatch.setattr(RenderingService, 'render_clip', render)
    config = {'run': str(tmp_path), 'revision': 3, 'candidate_id': 'candidate-1', 'action': 'export'}
    asyncio.run(run_editor(config))
    output = json.loads((tmp_path / 'job_output.json').read_text())
    assert output['total_clips'] == 1 and output['clips'][0]['duration_ms'] == 5600
    assert (tmp_path / 'clip_00.mp4').read_bytes() == b'final clip'
    saved = json.loads((tmp_path / 'editor-project.json').read_text())
    assert saved['candidates'][0]['exports'] == [0] and saved['candidates'][0]['status'] == 'baked'
    assert saved['transcript'] == project['transcript']
    assert json.loads((tmp_path / 'transcript.json').read_text())['segments'][1]['text'] == transcript()[1].text
    with pytest.raises(ValueError, match='changed'): asyncio.run(run_editor(config))
    config['revision'] = 4
    with pytest.raises(ValueError, match='Mark this clip ready'): asyncio.run(run_editor(config))
    saved['candidates'][0]['status'] = 'ready'
    (tmp_path / 'editor-project.json').write_text(json.dumps(saved))
    asyncio.run(run_editor(config))
    assert (tmp_path / 'clip_01.mp4').exists() and (tmp_path / 'editor-source.mp4').read_bytes() == b'original'


def test_short_manual_export_contains_only_the_selected_frames(monkeypatch, tmp_path):
    """Exercise the full export path: six red frames, six blue, no deleted green gap."""
    import shutil
    import subprocess
    from dataclasses import asdict
    import numpy as np
    from clip_engine.services import rendering_service

    if not shutil.which('ffmpeg') or not shutil.which('ffprobe'):
        pytest.skip('FFmpeg and FFprobe are needed for the actual export check')
    renderer = RenderingService()
    monkeypatch.setattr(renderer.settings, 'local_mode', True)
    renderer._verify_ffmpeg()
    monkeypatch.setattr(rendering_service, 'get_output_dimensions', lambda _: (80, 120))
    frames = np.zeros((180, 90, 160, 3), dtype=np.uint8)
    frames[:36, :, :, 0] = 255
    frames[36:150, :, :, 1] = 255
    frames[150:, :, :, 2] = 255
    source = tmp_path / 'editor-source.mp4'
    subprocess.run(['ffmpeg', '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '160x90', '-r', '30',
        '-i', 'pipe:0', *renderer._video_codec_args(160, 90), '-pix_fmt', 'yuv420p', str(source)],
        input=frames.tobytes(), capture_output=True, check=True, timeout=30)
    c = {**candidate(), 'ranges': [[1000, 1200], [5000, 5200]], 'status': 'ready', 'captions': False, 'video_speed': 1}
    project = {'version': 1, 'revision': 0, 'width': 160, 'height': 90, 'duration_ms': 12000, 'aspect_ratio': '9:16',
        'candidates': [c], 'transcript': [asdict(s) for s in transcript()]}
    (tmp_path / 'editor-project.json').write_text(json.dumps(project))
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': [asdict(s) for s in transcript()]}))
    (tmp_path / 'job_output.json').write_text(json.dumps({'clips': [], 'total_clips': 0, 'editor_project': True}))
    asyncio.run(run_editor({'run': str(tmp_path), 'revision': 0, 'candidate_id': c['id'], 'action': 'export'}))
    output = json.loads((tmp_path / 'job_output.json').read_text())['clips'][0]
    assert output['duration_ms'] == 400
    decoded = subprocess.run(['ffmpeg', '-v', 'error', '-i', output['s3_url'], '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1'],
        capture_output=True, check=True, timeout=30)
    pictures = np.frombuffer(decoded.stdout, dtype=np.uint8).reshape(-1, 120, 80, 3)
    assert len(pictures) == 12
    assert np.all(pictures[:6, 60, 40, 0] > 220)
    assert np.all(pictures[6:, 60, 40, 2] > 220)
    assert np.all(pictures[:, 60, 40, 1] < 30)


@pytest.mark.parametrize('status', ['refining', 'discarded', 'ready'])
def test_unready_or_failed_export_never_marks_baked(monkeypatch, tmp_path, status):
    from dataclasses import asdict
    c = {**candidate(), 'status': status}
    project = {'version': 1, 'revision': 0, 'width': 1920, 'height': 1080, 'duration_ms': 12000, 'aspect_ratio': '9:16',
        'candidates': [c], 'transcript': [asdict(s) for s in transcript()]}
    (tmp_path / 'editor-project.json').write_text(json.dumps(project))
    (tmp_path / 'editor-source.mp4').write_bytes(b'original')
    (tmp_path / 'transcript.json').write_text(json.dumps({'segments': [asdict(s) for s in transcript()]}))
    (tmp_path / 'job_output.json').write_text(json.dumps({'clips': [], 'total_clips': 0}))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda _: None)
    render = AsyncMock(side_effect=RenderingError('fixture render failure'))
    monkeypatch.setattr(RenderingService, 'render_clip', render)
    with pytest.raises((ValueError, RenderingError), match='fixture render failure|Mark this clip ready'):
        asyncio.run(run_editor({'run': str(tmp_path), 'revision': 0, 'candidate_id': c['id'], 'action': 'export'}))
    assert render.await_count == (1 if status == 'ready' else 0)
    assert json.loads((tmp_path / 'editor-project.json').read_text()) == project
    assert json.loads((tmp_path / 'job_output.json').read_text())['clips'] == []
    assert not list(tmp_path.glob('clip_*.mp4'))


def test_pipeline_review_stops_before_automatic_repairs_and_render(monkeypatch, tmp_path):
    from clip_engine.services import ai_clipping_pipeline as module
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
    from clip_engine.services.intelligence_planner import ClipPlanResponse
    from clip_engine.services.transcription_service import TranscriptionResult
    settings = module.get_settings()
    monkeypatch.setattr(settings, 'local_mode', True)
    monkeypatch.setattr(settings, 'openrouter_api_key', '')
    monkeypatch.setattr(settings, 'local_output_dir', str(tmp_path / 'out'))
    monkeypatch.setattr(settings.__class__, 'temp_directory', property(lambda self: str(tmp_path / 'work')))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda _: None)
    pipeline = AIClippingPipeline()
    source = tmp_path / 'original.mp4'; source.write_bytes(b'source')
    pipeline.video_downloader.download_video = AsyncMock(return_value=SimpleNamespace(video_path=str(source), file_size_bytes=6,
        metadata=SimpleNamespace(title='A manual source', duration_seconds=12, width=1920, height=1080)))
    pipeline.transcription_service.transcribe = AsyncMock(return_value=TranscriptionResult(segments=transcript(), full_text='Original source'))
    pipeline.intelligence_planner.plan_clips = AsyncMock(return_value=ClipPlanResponse(segments=[ClipPlanSegment(0, 5000, .8, summary='First'), ClipPlanSegment(6000, 11000, .7, summary='Second')], total_clips=2))
    pipeline.rendering_service._get_video_dimensions = AsyncMock(return_value=(1920, 1080))
    async def preview(src, dest): Path(dest).write_bytes(b'preview')
    pipeline.rendering_service.capture_framing_source = AsyncMock(side_effect=preview)
    pipeline.rendering_service.render_clip = AsyncMock(side_effect=AssertionError('Review must not render'))
    monkeypatch.setattr(module.CoherenceReviewer, 'prepare', AsyncMock(side_effect=AssertionError('Review must not repair')))
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url=str(source), job_id='review-run', workflow='review', layout_style='fit')))
    assert result.status == JobStatus.COMPLETED, result.error
    assert result.output.editor_project and result.output.total_clips == 0
    project = json.loads((tmp_path / 'out/review-run/editor-project.json').read_text())
    assert len(project['candidates']) == 2
    assert all(len(c['review']['questions']) == 8 for c in project['candidates'])
    assert all(c['review']['decision'] == 'needs_attention' for c in project['candidates'])
    assert source.exists() and not (tmp_path / 'work/review-run').exists()
    pipeline.rendering_service.render_clip.assert_not_called()
