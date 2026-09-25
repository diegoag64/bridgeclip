"""Offline regressions for narrative anchors, alternatives and bounded rediscovery."""
import asyncio
import json
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import AsyncMock

import pytest

from clip_engine.services.editorial_evidence import parse_moment, discovery_feedback
from clip_engine.services.intelligence_planner import ClipPlanSegment, ClipPlanResponse, PlanningApiCosts
from tests.test_planner import make_planner, make_transcript, clip, completion


def moment():
    return {'topic': 'One example', 'topic_start_segment': 0, 'topic_end_segment': 7,
            'setup_segment': 1, 'payoff_segment': 5, 'requires_visual_context': False}


def test_candidate_construction_includes_setup_and_payoff_before_review():
    planner = make_planner()
    planner._current_transcript = make_transcript(40).segments
    planner._current_video_duration = 40
    result = planner._parse_clip_plan_response(completion(json.dumps({'clips': [{**clip(10, 19.5), 'moment': moment()}]})))
    assert len(result.segments) == 1
    candidate = result.segments[0]
    assert (candidate.start_time_ms, candidate.end_time_ms) == (5000, 29500)
    assert candidate.moment['setup']['speaker'] == 'S2'


def test_invalid_narrative_anchors_are_rejected():
    segments = make_transcript(40).segments
    for changed in [{'setup_segment': -1}, {'payoff_segment': 99}, {'setup_segment': True}, {'setup_segment': 6, 'payoff_segment': 1}]:
        with pytest.raises(ValueError):
            parse_moment({**moment(), **changed}, segments)


def test_discovery_keeps_alternatives_but_collapses_identical_boundaries():
    planner = make_planner()
    clips = [ClipPlanSegment(0, 30000, .9), ClipPlanSegment(10000, 40000, .8), ClipPlanSegment(0, 30000, .7)]
    assert len(planner._finalize_clips(clips, 8, allow_alternatives=True)) == 2


def test_second_pass_targets_at_most_six_unproposed_spans():
    entries = [{'original_interval': [i * 60000, i * 60000 + 10000], 'title': str(i), 'status': 'rejected'} for i in range(12)]
    feedback = discovery_feedback(entries, 720000)
    assert len(feedback['search_intervals']) == 6
    assert all(b - a >= 30000 for a, b in feedback['search_intervals'])


@pytest.mark.parametrize('search_fails', [False, True])
def test_pipeline_rediscovery_is_bounded_and_preserves_approved_clips(monkeypatch, tmp_path, search_fails):
    from clip_engine.services import ai_clipping_pipeline as module
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
    from clip_engine.services.rendering_service import RenderingService, RenderResult
    from clip_engine.services.transcription_service import TranscriptionResult, TranscriptSegment
    from tests.test_coherence_review import reviewer
    settings = module.get_settings()
    monkeypatch.setattr(settings, 'local_mode', True)
    monkeypatch.setattr(settings, 'openrouter_api_key', 'fixture')
    monkeypatch.setattr(settings, 'local_output_dir', str(tmp_path / 'out'))
    monkeypatch.setattr(settings.__class__, 'temp_directory', property(lambda self: str(tmp_path / 'work')))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda self: None)
    pipeline = AIClippingPipeline()
    gate, _ = reviewer(lambda state, q: 'Rejected' not in state['retained_dialogue'])
    gate.segments = [TranscriptSegment(0, 11000, 'Approved original.'), TranscriptSegment(40000, 51000, 'Rejected excerpt.'), TranscriptSegment(100000, 111000, 'Approved overlooked idea.')]
    gate.duration_ms = 360000
    gate.repair = AsyncMock(return_value=None)
    monkeypatch.setattr(module, 'CoherenceReviewer', lambda *args: gate)
    monkeypatch.setattr(module, 'protect_acknowledgments', AsyncMock())
    monkeypatch.setattr(module, 'review_duplicate_candidates', AsyncMock())
    download = AsyncMock(return_value=SimpleNamespace(video_path=str(tmp_path / 'source.mp4'), file_size_bytes=1,
        metadata=SimpleNamespace(title='Synthetic source', duration_seconds=360, width=1920, height=1080)))
    transcribe = AsyncMock(return_value=TranscriptionResult(segments=gate.segments, full_text='Full source'))
    calls = []
    async def plan(**kwargs):
        calls.append(kwargs)
        if len(calls) == 2:
            assert kwargs['max_clips'] == 1 and kwargs['auto_clip_count'] is False
            assert len(kwargs['discovery_feedback']['previous_candidates']) == 2
            if search_fails:
                raise RuntimeError('Fixture outage')
            segments = [ClipPlanSegment(100000, 111000, .9), ClipPlanSegment(0, 11000, .8)]
        else:
            segments = [ClipPlanSegment(0, 11000, .9), ClipPlanSegment(40000, 51000, .8)]
        return ClipPlanResponse(segments=segments, total_clips=2, api_costs=PlanningApiCosts(provider='fixture', model='fixture', estimated_cost_usd=.01, attempts=1))
    async def render(request):
        Path(request.output_path).write_bytes(b'fixture')
        return RenderResult(output_path=request.output_path, file_size_bytes=7, duration_ms=11000)
    monkeypatch.setattr(pipeline.video_downloader, 'download_video', download)
    monkeypatch.setattr(pipeline.transcription_service, 'transcribe', transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, 'plan_clips', plan)
    monkeypatch.setattr(pipeline.rendering_service, 'render_clip', AsyncMock(side_effect=render))
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url='fixture.mp4', job_id='fixture', max_clips=2, auto_clip_count=False)))
    assert result.status == JobStatus.COMPLETED, result.error
    audit = json.loads((tmp_path / 'out/fixture/edit_audit.json').read_text())
    assert len(calls) == 2 and transcribe.await_count == 1 and download.await_count == 1
    assert len(audit['candidates']) == (2 if search_fails else 3)
    assert audit['discovery']['status'] == ('unavailable' if search_fails else 'completed')
    assert sum(c['status'] == 'rendered' for c in audit['candidates']) == (1 if search_fails else 2)
    if not search_fails:
        assert audit['candidates'][-1]['discovery_pass'] == 2
        output = json.loads((tmp_path / 'out/fixture/job_output.json').read_text())
        assert output['metrics']['api_costs']['planning']['estimated_cost_usd'] == .02


def test_failed_second_discovery_has_no_transport_retry(monkeypatch):
    from clip_engine.services.intelligence_planner import IntelligencePlanningError
    planner = make_planner()
    planner.audit = {'requests': []}
    call = AsyncMock(side_effect=IntelligencePlanningError('Fixture outage', retryable=True))
    monkeypatch.setattr(planner, '_call_openrouter', call)
    with pytest.raises(IntelligencePlanningError):
        asyncio.run(planner.plan_clips(make_transcript(120), discovery_feedback={'search_intervals': [[0, 120000]], 'previous_candidates': []}))
    assert call.await_count == 1
    assert planner.audit['requests'][0]['discovery_pass'] == 2


def test_discovery_excludes_repaired_approved_footage():
    feedback = discovery_feedback([{'original_interval': [50000, 60000], 'title': 'Moment', 'status': 'accepted',
        'report': {'coherence': {'accepted_interval': [0, 90000]}}}], 150000)
    assert feedback['search_intervals'] == [[90000, 150000]]
    assert feedback['previous_candidates'][0]['interval'] == [0, 90000]
