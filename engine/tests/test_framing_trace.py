"""Recorded diagnostics match actual analysis, edit geometry and render fallback."""
import asyncio
import json
from pathlib import Path

import pytest

from tests.framing_fixture import recorded_fixture
from tests.test_render_fallback import service, stub_render, request_for, render
from clip_engine.services import rendering_service as renderer
from clip_engine.services.framing_trace import plan_record, save_trace
from clip_engine.services.layout_renderer import shot_views


def test_recorded_samples_transitions_cache_and_track_associations():
    trace, plan, calls = recorded_fixture()
    assert calls == 2  # third segment reuses the original webcam result
    assert [s['layout'] for s in trace['rendered_plan']] == ['screen_cam', 'talking_head', 'screen_cam']
    assert [b['t_ms'] for b in trace['boundaries']] == [4000, 8000]
    assert all(b['samples'] >= 3 and b['hold_ms'] >= 500 for b in trace['boundaries'])
    assert trace['samples'][0]['faces'][0]['score'] == .973
    assert trace['samples'][25]['faces'] == []
    assert trace['decisions'][2]['vision']['cache_hit'] is True
    assert trace['decisions'][2]['vision']['source_ms'] == 12000
    assert trace['decisions'][2]['vision']['cache_source_ms'] == 4000
    assert trace['decisions'][2]['vision']['cache_id'] == trace['decisions'][0]['vision']['cache_id']
    for d in trace['decisions']:
        for track in d['tracks']:
            for t, index in track['samples']:
                sample = next(s for s in trace['samples'] if s['t_ms'] == t)
                assert index < len(sample['faces']) and d['start_ms'] <= t < d['end_ms']
    assert 'must-not-be-persisted' not in json.dumps(trace)
    assert 'private_provider_field' not in json.dumps(trace)
    assert 'api_key' not in json.dumps(trace)
    # The committed JSON is the actual Python trace consumed by desktop tests.
    fixture = Path(__file__).resolve().parents[2] / 'tests/fixtures/framing/trace.json'
    assert json.loads(fixture.read_text()) == json.loads(json.dumps(trace))


def test_padding_cut_mapping_and_renderer_geometry():
    trace, plan, _ = recorded_fixture()
    assert trace['window'] == dict(start_ms=2000, duration_ms=12000, requested_start_ms=2300, requested_end_ms=13500)
    assert trace['planner_skips'] == [[5000, 6500]]
    assert trace['output']['duration_ms'] == 10500
    assert sum(p['source_end_ms'] - p['source_start_ms'] for p in trace['video_pieces']) == 10500
    assert not any(p['source_start_ms'] < 6500 and p['source_end_ms'] > 5000 for p in trace['video_pieces'])
    for shot, record in zip(plan.shots, plan_record(plan, 360, 640)):
        views = shot_views(shot, shot.start_ms, 640, 360, 360, 640)
        for (src, dst), saved in zip(views, record['views']):
            assert saved['source'] == list(src)
            assert saved['destination'] == list(dst)
        if record['crop_path']:
            assert record['crop_path'][0][0] == shot.start_ms


@pytest.mark.parametrize('failures', [0, 1, 2])
def test_fallback_retains_attempted_and_actual_plans(service, monkeypatch, tmp_path, failures):
    stub_render(monkeypatch, service, failures, [])
    result = render(service, request_for(tmp_path, debug_capture=True))
    trace = json.loads(Path(result.framing_trace_path).read_text())
    assert len(trace['attempts']) == failures + 1
    assert trace['attempted_plan'][0]['layout'] == 'screen_cam'
    assert trace['rendered_plan'][0]['layout'] == ('screen_cam' if not failures else 'screen')
    assert trace['attempts'][-1]['status'] == 'rendered'
    assert trace['output']['duration_ms'] == result.duration_ms
    assert 'Cannot select channel' not in json.dumps(trace)
    assert Path(result.framing_trace_path).stat().st_mode & 0o777 == 0o600


def test_diagnostics_failure_does_not_lose_rendered_clip(service, monkeypatch, tmp_path):
    stub_render(monkeypatch, service, 0, [])
    monkeypatch.setattr(renderer, 'make_trace', lambda *args: (_ for _ in ()).throw(ValueError('synthetic')))
    result = render(service, request_for(tmp_path, debug_capture=True))
    assert result.framing_trace_path is None
    assert Path(result.output_path).is_file()


def test_capture_default_off_and_trace_write_never_follows_existing_path(service, monkeypatch, tmp_path):
    stub_render(monkeypatch, service, 0, [])
    result = render(service, request_for(tmp_path))
    assert result.framing_trace_path is None
    target = tmp_path / 'secret'
    target.write_text('original')
    link = tmp_path / 'trace.json'
    link.symlink_to(target)
    with pytest.raises(FileExistsError):
        save_trace(str(link), {'version': 1})
    assert target.read_text() == 'original'
    with pytest.raises(ValueError):
        save_trace(str(tmp_path / 'invalid.json'), {'score': float('nan')})


def test_source_capture_scales_once_without_cropping_or_trimming(service, monkeypatch, tmp_path):
    calls = []
    async def run(cmd):
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b'preview')
    monkeypatch.setattr(service, '_run_cmd', run)
    target = tmp_path / 'framing-source.mp4'
    asyncio.run(service.capture_framing_source('source.mp4', str(target)))
    assert len(calls) == 1
    assert 'scale=1280:720' in calls[0][calls[0].index('-vf') + 1]
    assert not any(option in calls[0] for option in ('-ss', '-t', '-to'))
    assert target.read_bytes() == b'preview'
    assert not Path(str(target) + '.partial.mp4').exists()


def test_landscape_preview_records_whole_source_and_fitted_foreground():
    from clip_engine.services.layout_analyzer import ClipLayoutPlan, ShotLayout
    plan = ClipLayoutPlan([ShotLayout(0, 1000, 'screen')], 640, 480)
    view = plan_record(plan, 1920, 1080, landscape=True)[0]['views'][0]
    assert view['source'] == [0, 0, 640, 480]
    assert view['destination'] == [240, 0, 1440, 1080]
