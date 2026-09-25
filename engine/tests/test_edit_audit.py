"""Pipeline and cross-language audit fixtures; no live inference or media."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from clip_engine.services import ai_clipping_pipeline as module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.intelligence_planner import ClipPlanResponse, ClipPlanSegment
from clip_engine.services.rendering_service import RenderingService, RenderResult
from clip_engine.services.transcription_service import TranscriptionResult
from tests.test_coherence_review import reviewer, report, transcript, repair_response


@pytest.mark.parametrize('accept', [True, False])
def test_full_transcript_and_rejected_candidates_are_saved(monkeypatch, tmp_path, accept):
    settings = module.get_settings()
    monkeypatch.setattr(settings, 'local_mode', True)
    monkeypatch.setattr(settings, 'local_output_dir', str(tmp_path / 'out'))
    monkeypatch.setattr(settings.__class__, 'temp_directory', property(lambda self: str(tmp_path / 'work')))
    monkeypatch.setattr(RenderingService, '_verify_ffmpeg', lambda self: None)
    pipeline = AIClippingPipeline()
    gate, _ = reviewer(lambda state, q: accept)
    gate.repair = AsyncMock(return_value=None)
    monkeypatch.setattr(module, 'CoherenceReviewer', lambda *args: gate)
    monkeypatch.setattr(module, 'protect_acknowledgments', AsyncMock())
    monkeypatch.setattr(module, 'review_duplicate_candidates', AsyncMock())
    async def download(url, output_dir):
        return SimpleNamespace(video_path=str(tmp_path / 'source.mp4'), file_size_bytes=1,
            metadata=SimpleNamespace(title='Synthetic source', duration_seconds=12, width=1920, height=1080))
    async def transcribe(**kwargs):
        assert kwargs['start_seconds'] is None and kwargs['end_seconds'] is None
        return TranscriptionResult(segments=transcript(), full_text='Complete source')
    async def plan(**kwargs):
        assert len(kwargs['transcript_result'].segments) == 4
        assert (kwargs['start_time_seconds'], kwargs['end_time_seconds']) == (3, 8)
        return ClipPlanResponse(segments=[ClipPlanSegment(0, 11000, .9, summary='Supported result')], total_clips=1)
    async def render(request):
        assert request.coherence_reviewer is gate and not request.apply_padding
        await gate.audit_edit(request.title_text, TimeMap([(0, 11000)], 11000), 0, 11000, request.editorial_context, None)
        Path(request.output_path).write_bytes(b'fixture')
        return RenderResult(output_path=request.output_path, file_size_bytes=7, duration_ms=11000)
    mocked_render = AsyncMock(side_effect=render)
    monkeypatch.setattr(pipeline.video_downloader, 'download_video', download)
    monkeypatch.setattr(pipeline.transcription_service, 'transcribe', transcribe)
    monkeypatch.setattr(pipeline.intelligence_planner, 'plan_clips', plan)
    monkeypatch.setattr(pipeline.rendering_service, 'render_clip', mocked_render)
    result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url='fixture.mp4', job_id='fixture', start_time_seconds=3, end_time_seconds=8)))
    audit = json.loads((tmp_path / 'out/fixture/edit_audit.json').read_text())
    assert audit['preferred_range'] == [3, 8] and len(audit['transcript']) == 4
    assert audit['candidates'][0]['status'] == ('rendered' if accept else 'rejected')
    assert audit['candidates'][0]['report']['coherence']['attempts'][0]['judgment']['questions']
    assert result.status == (JobStatus.COMPLETED if accept else JobStatus.FAILED), result.error
    assert mocked_render.await_count == int(accept)
    if accept:
        assert result.output.metrics["analysis_duration_seconds"] == 12
    if not accept:
        assert audit['outcome'] == 'no_approved_clips'
        assert 'No clip was forced' in result.error
        assert not list((tmp_path / 'out/fixture').glob('*.mp4'))


async def fixture():
    """Use real policy and adapter with mocked provider replies for the UI fixture."""
    from unittest.mock import patch
    gate, _ = reviewer(lambda state, q: 'removal_safe' not in q and 'setup' in state['retained_dialogue'] and 'qualification' in state['retained_dialogue'])
    async def completion(_client, _payload):
        return repair_response(json.dumps({'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'A supported result'})), {'cost': .001, 'prompt_tokens': 400, 'completion_tokens': 40, 'total_tokens': 440}
    segment = ClipPlanSegment(3000, 8000, .9, summary='Result')
    accepted = report()
    with patch('clip_engine.services.coherence_review.chat_completion', completion):
        assert await gate.prepare(segment, accepted)
    await gate.audit_edit(segment.summary, TimeMap([(0, 2000), (6000, 11000)], 11000), 0, 11000, accepted, None)
    rejected_gate, _ = reviewer(lambda state, q: False)
    rejected_gate.repair = AsyncMock(return_value=None)
    rejected = report()
    assert not await rejected_gate.prepare(ClipPlanSegment(3000, 5000, .7, summary='An incomplete event'), rejected)
    return {'version': 1, 'title': 'Synthetic context and repair example', 'duration_ms': 12000,
        'preferred_range': [3, 8], 'outcome': 'completed',
        'transcript': [{'start_ms': s.start_time_ms, 'end_ms': s.end_time_ms, 'text': s.text} for s in transcript()],
        'planner': {'requests': [{'model': 'fixture/cheap', 'status': 'parsed', 'messages': [{'role': 'user', 'content': 'Synthetic fixture: find complete ideas in the full transcript.'}], 'response': '{"clips":[{"start":3,"end":8}]}', 'usage': None}]},
        'candidates': [
            {'candidate_index': 0, 'title': segment.summary, 'original_interval': [3000, 8000], 'clip_index': 0, 'status': 'rendered', 'report': accepted},
            {'candidate_index': 1, 'title': 'An incomplete event', 'original_interval': [3000, 5000], 'clip_index': None, 'status': 'rejected', 'report': rejected}]}


if __name__ == '__main__':
    import sys
    Path(sys.argv[1]).write_text(json.dumps(asyncio.run(fixture()), indent=2) + '\n')
