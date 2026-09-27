"""Source upgrades keep edits and switch media only after a complete preview exists."""
import asyncio
import copy
import json
import shutil
import subprocess
from unittest.mock import AsyncMock
from types import SimpleNamespace

import pytest

from clip_engine.services import manual_editor as editor


@pytest.fixture
def project(tmp_path):
    run = tmp_path / 'run'
    run.mkdir()
    def video(name, size='320x180', duration='2', audio=True):
        path = run / name
        cmd = ['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', f'testsrc2=size={size}:rate=30']
        if audio:
            cmd += ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
        subprocess.run(cmd + ['-t', duration, '-c:v', 'mpeg4', '-q:v', '3', '-c:a', 'aac', str(path)], check=True, capture_output=True)
        return path
    video('editor-source.mp4')
    shutil.copyfile(run / 'editor-source.mp4', run / 'editor-preview.mp4')
    candidate = {'id': 'candidate-1', 'status': 'baked', 'exports': [0], 'title': 'My edits',
                 'ranges': [[100, 1000], [1200, 1800]], 'scenes': [{'at_ms': 0, 'layout': 'fill', 'crops': [[.2, 0, .3, 1]]}],
                 'caption_edits': [{'segment': 0, 'text': 'Corrected'}], 'caption_suppression_ranges': [[500, 800]],
                 'video_speed': 1.25, 'review': {'signature': 'retained evidence'}}
    data = {'version': 1, 'revision': 7, 'width': 320, 'height': 180, 'duration_ms': 2000,
            'transcript': [{'start_ms': 100, 'end_ms': 1000, 'text': 'Original'}],
            'candidates': [dict(copy.deepcopy(candidate), status=status) for status in ('baked', 'ready', 'refining', 'discarded')]}
    editor.atomic_json(run / 'editor-project.json', data)
    return run, data, video


def replace(run, source_id='a' * 32, revision=7):
    asyncio.run(editor.run_editor({'run': str(run), 'library': str(run.parent), 'action': 'replace-source',
                                   'revision': revision, 'source_id': source_id}))


def test_higher_resolution_preserves_edits_and_repeated_replacement(project):
    run, original, video = project
    for index, source_id in enumerate(('a' * 32, 'b' * 32)):
        video(editor.media_name('source', source_id), size='640x360')
        replace(run, source_id, 7 + index)
        saved = editor.read_json(run, 'editor-project.json')
        assert saved['source_id'] == source_id
        assert (saved['width'], saved['height'], saved['revision']) == (640, 360, 8 + index)
        assert saved['duration_ms'] == original['duration_ms']
        assert saved['transcript'] == original['transcript']
        assert [c['status'] for c in saved['candidates']] == ['ready', 'ready', 'refining', 'discarded']
        for before, after in zip(original['candidates'], saved['candidates']):
            assert {k: v for k, v in before.items() if k != 'status'} == {k: v for k, v in after.items() if k != 'status'}
        preview = editor.source_info(run / editor.media_name('preview', source_id))
        assert (preview['width'], preview['height']) == (640, 360)
        assert abs(preview['duration'] - 2000) < 100


@pytest.mark.parametrize('options,code', [({'duration': '2.5'}, 'duration'), ({'size': '360x640'}, 'geometry'), ({'audio': False}, 'audio')])
def test_incompatible_video_never_changes_original(project, options, code):
    run, data, video = project
    original = (run / 'editor-source.mp4').read_bytes()
    video(editor.media_name('source', 'a' * 32), **options)
    with pytest.raises(editor.SourceReplacementError) as error:
        replace(run)
    assert error.value.code == code
    assert editor.read_json(run, 'editor-project.json') == data
    assert (run / 'editor-source.mp4').read_bytes() == original
    assert not (run / editor.media_name('preview', 'a' * 32)).exists()


@pytest.mark.parametrize('failure', [RuntimeError('preview failed'), asyncio.CancelledError()])
def test_preview_failure_or_cancellation_preserves_project(project, monkeypatch, failure):
    run, data, video = project
    video(editor.media_name('source', 'a' * 32), size='640x360')
    monkeypatch.setattr(editor.RenderingService, 'capture_framing_source', AsyncMock(side_effect=failure))
    with pytest.raises(type(failure)):
        replace(run)
    assert editor.read_json(run, 'editor-project.json') == data
    assert (run / 'editor-source.mp4').exists() and (run / 'editor-preview.mp4').exists()


def test_failed_commit_and_stale_revision_preserve_project(project, monkeypatch):
    run, data, video = project
    video(editor.media_name('source', 'a' * 32), size='640x360')
    preview = AsyncMock()
    monkeypatch.setattr(editor.RenderingService, 'capture_framing_source', preview)
    with pytest.raises(ValueError, match='changed'):
        replace(run, revision=6)
    preview.assert_not_called()
    def fail(*args):
        raise OSError('disk full')
    monkeypatch.setattr(editor, 'atomic_json', fail)
    with pytest.raises(OSError):
        replace(run)
    assert editor.read_json(run, 'editor-project.json') == data


def test_invalid_media_and_generation_are_rejected(project):
    run, data, _ = project
    (run / editor.media_name('source', 'a' * 32)).write_text('not a video')
    with pytest.raises(editor.SourceReplacementError) as error:
        replace(run)
    assert error.value.code == 'invalid'
    for source_id in ('../outside', 'a' * 31, '', None):
        with pytest.raises(ValueError):
            replace(run, source_id)
    assert json.loads((run / 'editor-project.json').read_text()) == data


def test_probe_normalizes_unspecified_pixel_aspect_and_rejects_tiny_dimensions(monkeypatch):
    video = {'codec_type': 'video', 'width': 320, 'height': 180, 'sample_aspect_ratio': '0:1'}
    monkeypatch.setattr(editor, 'run_media', lambda *a, **kw: SimpleNamespace(stdout=json.dumps({
        'streams': [video], 'format': {'duration': '2'}
    }).encode()))
    assert editor.source_info('fixture.mp4')['sar'] == '1:1'
    video.update(width=1, height=1)
    with pytest.raises(editor.SourceReplacementError):
        editor.source_info('fixture.mp4')


def test_source_replacement_invalidates_camera_frames_and_dismissals(project):
    run, data, video = project
    data['preview_id'] = 'b' * 32
    data['frame_preview'] = True
    for c in data['candidates']:
        c['camera_scan'] = {'start_ms': 0, 'end_ms': 2000, 'frames': [0, 500], 'markers': [{'at_ms': 500, 'score': .5}]}
        c['dismissed_camera_markers'] = [500]
    editor.atomic_json(run / 'editor-project.json', data)
    video(editor.media_name('source', 'a' * 32), size='640x360')
    replace(run)
    saved = editor.read_json(run, 'editor-project.json')
    assert 'preview_id' not in saved and saved['frame_preview'] is True
    assert all('camera_scan' not in c and 'dismissed_camera_markers' not in c for c in saved['candidates'])
