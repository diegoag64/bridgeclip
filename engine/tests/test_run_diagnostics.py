import asyncio
import pytest
from clip_engine.services.run_diagnostics import CURRENT, RunDiagnostics, model_request


@pytest.mark.parametrize('field', ['prompt_tokens', 'completion_tokens', 'cost'])
@pytest.mark.parametrize('invalid', [10**400, -(10**400), float('inf'), float('-inf'), float('nan'), True, 'bad'])
def test_invalid_provider_usage_does_not_abort_successful_transcription(field, invalid, monkeypatch):
    from unittest.mock import AsyncMock
    from clip_engine.services.transcription_service import TranscriptionService
    service = object.__new__(TranscriptionService)
    response = {'text': 'Hello.', 'words': [{'word': 'Hello.', 'start': 0, 'end': 1}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 2, 'cost': .01, field: invalid}}
    monkeypatch.setattr(service, '_request_transcript_body', AsyncMock(return_value=response))
    async def run():
        # Tracking must not change the result of an otherwise valid request.
        baseline = await service._request_transcript('unused.wav', None, None)
        tracker = RunDiagnostics()
        token = CURRENT.set(tracker)
        try:
            result = await service._request_transcript('unused.wav', None, None)
            assert result is baseline
            assert result['text'] == 'Hello.'
            row = tracker.snapshot()['models'][0]
            assert row['active'] == 0 and row['failed'] == 0
            assert row['unknown_cost'] == int(field == 'cost')
            assert row['unknown_usage'] == int(field != 'cost')
            assert row['cost_usd'] == (0 if field == 'cost' else .01)
            assert row['input_tokens'] == (0 if field == 'prompt_tokens' else 10)
            assert row['output_tokens'] == (0 if field == 'completion_tokens' else 2)
        finally:
            CURRENT.reset(token)
    asyncio.run(run())


def test_usage_reports_live_calls_failures_unknown_fields_and_no_prompt_data():
    now = [0.0]
    tracker = RunDiagnostics(clock=lambda: now[0])
    token = CURRENT.set(tracker)
    try:
        tracker.stage = 'preparing'
        with model_request('test/model') as call:
            assert tracker.snapshot()['models'][0]['active'] == 1
            call.update(success=True, input_tokens=120, output_tokens=30, cost_usd=.02, prompt='secret')
            now[0] = 2
        with pytest.raises(RuntimeError):
            with model_request('test/model'):
                now[0] = 3
                raise RuntimeError('secret failure')
        row = tracker.snapshot()['models'][0]
        assert row == {'stage': 'preparing', 'model': 'test/model', 'requests': 2, 'active': 0, 'failed': 1,
            'input_tokens': 120, 'output_tokens': 30, 'cost_usd': .02, 'elapsed_ms': 3000, 'unknown_usage': 1, 'unknown_cost': 1}
    finally:
        CURRENT.reset(token)


def test_preparation_timings_accumulate_across_candidates_and_freeze():
    now = [0.0]
    tracker = RunDiagnostics(clock=lambda: now[0])
    tracker.candidate(1, 2, 5000)
    tracker.phase('sampling'); now[0] = 2
    tracker.phase('camera_scan', 50); now[0] = 5
    assert tracker.snapshot()['preparation']['timings']['camera_scan'] == 3000
    tracker.candidate(2, 2, 8000)
    tracker.phase('sampling'); now[0] = 9
    tracker.phase('jev'); now[0] = 10
    tracker.phase(None)
    result = tracker.snapshot()['preparation']
    now[0] = 99
    assert tracker.snapshot()['preparation'] == result
    assert result['timings'] == {'sampling': 6000, 'camera_scan': 3000, 'face_tracking': 0, 'vision': 0, 'jev': 1000}


def test_concurrent_runs_and_cancelled_requests_are_isolated():
    async def run(model):
        tracker = RunDiagnostics()
        token = CURRENT.set(tracker)
        try:
            with pytest.raises(asyncio.CancelledError):
                with model_request(model):
                    await asyncio.sleep(0)
                    raise asyncio.CancelledError()
            return tracker.snapshot()
        finally:
            CURRENT.reset(token)
    async def all_runs():
        return await asyncio.gather(run('one/model'), run('two/model'))
    a, b = asyncio.run(all_runs())
    assert [r['model'] for r in a['models']] == ['one/model']
    assert [r['model'] for r in b['models']] == ['two/model']
    assert a['models'][0]['active'] == 0 and a['models'][0]['failed'] == 1
    assert CURRENT.get() is None


def test_cached_jev_answers_do_not_duplicate_billed_requests():
    from tests.test_editorial_context import service
    from clip_engine.services.jev_service import noul
    tracker = RunDiagnostics()
    token = CURRENT.set(tracker)
    try:
        client, _ = service()
        async def run():
            question = {'clear': noul('Clear?', 'Yes', 'No')}
            await client.evaluate({'text': 'Example'}, question)
            await client.evaluate({'text': 'Example'}, question)
        asyncio.run(run())
        assert tracker.snapshot()['models'][0]['requests'] == 1
        assert tracker.snapshot()['models'][0]['active'] == 0
    finally:
        CURRENT.reset(token)


def test_heartbeat_refreshes_usage_without_stage_callbacks_and_can_be_cancelled():
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, JobStatus
    from clip_engine.services.job_progress import StageProgress

    async def run():
        pipeline = object.__new__(AIClippingPipeline)
        pipeline._stage_progress = StageProgress(review=True)
        pipeline._diagnostics = RunDiagnostics()
        pipeline._current_callback_url = None
        updates = []
        received = asyncio.Event()
        def receive(progress):
            updates.append(progress)
            if progress.diagnostics['models']:
                received.set()
        pipeline.progress_callback = receive
        pipeline._update_progress('test', JobStatus.PLANNING, 30, 'Finding moments')
        task = asyncio.create_task(pipeline._diagnostic_heartbeat())
        token = CURRENT.set(pipeline._diagnostics)
        try:
            with model_request('test/model') as call:
                await asyncio.wait_for(received.wait(), timeout=3)
                assert updates[-1].diagnostics['models'][0]['active'] == 1
                call.update(success=True, input_tokens=10, output_tokens=2, cost_usd=.01)
            received.clear()
            await asyncio.wait_for(received.wait(), timeout=3)
            assert updates[-1].diagnostics['models'][0]['input_tokens'] == 10
            assert updates[-1].diagnostics['models'][0]['active'] == 0
            assert updates[-1].stages[3]['elapsed_ms'] >= 1000
        finally:
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            CURRENT.reset(token)
    asyncio.run(run())
