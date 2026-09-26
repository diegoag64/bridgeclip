"""No paid calls: deterministic OpenRouter Jev contracts and exact cut-policy fixtures."""
import asyncio
import json
from types import SimpleNamespace

import httpx
import pytest

from clip_engine.services.jev_service import ENDPOINT, MODEL, JevService, choice, noul, score
from clip_engine.services.editorial_context import analyze_reactions, repair_context_boundaries, window_protection
from clip_engine.services.clip_editor import TimeMap, WindowWord, compute_keep_intervals, subtract_intervals
from clip_engine.services.layout_analyzer import ClipLayoutPlan, ShotLayout
from clip_engine.services.editorial_review import protect_acknowledgments, review_retained_clip, review_duplicate_candidates


def segment(a, b, text):
    return SimpleNamespace(start_time_ms=a, end_time_ms=b, text=text, words=[
        SimpleNamespace(start_time_ms=a, end_time_ms=b, word=text)], audio_events=[])


def response(questions, *, reaction=True, uncertain=False):
    answers = {}
    for key, q in questions.items():
        if q['type'] == 'noul':
            answers[key] = {'type': 'noul', 'noul': .5 if uncertain else .95 if reaction else .05}
        elif q['type'] == 'choice':
            options = list(q['criteria'])
            selected = 'sufficient' if 'sufficient' in options else options[0]
            answers[key] = {'type': 'choice', 'choice': selected, 'confidence': .9,
                            'probabilities': {k: 1.0 if k == selected else 0.0 for k in options}}
        else:
            answers[key] = {'type': 'score', 'score': 1.5, 'confidence': .3,
                            'probabilities': {'0': 0, '1': .5, '2': .5},
                            'legend': {str(i): v for i, v in enumerate(q['criteria'])}}
    return {'id': 'fixture-decision', 'provider': 'TypeSafe', 'model': MODEL + '-20260917', 'answers': answers,
            'usage': {'input_tokens': 300, 'output_tokens': 60, 'cost': .0000126}}


def service(*, reaction=True, uncertain=False):
    calls = []
    def handler(request):
        assert str(request.url) == ENDPOINT == 'https://openrouter.ai/api/alpha/decisions'
        assert request.headers['authorization'] == 'Bearer test-secret'
        payload = json.loads(request.content)
        assert payload['model'] == MODEL == 'typesafe/jev-1.13'
        calls.append(payload)
        return httpx.Response(200, json=response(payload['questions'], reaction=reaction, uncertain=uncertain))
    return JevService('test-secret', transport=httpx.MockTransport(handler)), calls


def test_typed_primitives_cache_and_usage():
    client, calls = service()
    questions = {'a': noul('Does this introduce footage?', 'Introduces footage', 'Does not'),
                 'b': choice('Is there enough evidence?', {'yes': 'Direct evidence', 'unknown': 'Not supplied'}),
                 'c': score('Is the excerpt self-contained?', ['Missing setup', 'Partial setup', 'Complete setup'])}
    async def run():
        first = await client.evaluate({'dialogue': 'Watch this'}, questions)
        second = await client.evaluate({'dialogue': 'Watch this'}, questions)
        third = await client.evaluate({'dialogue': 'Changed evidence'}, questions)
        return first, second, third
    first, second, third = asyncio.run(run())
    assert first['status'] == 'success'
    assert first['answers']['a'] == {'type': 'noul', 'noul': .95}
    assert first['answers']['c']['score'] == 1.5
    assert second['cache_hit'] and second['estimated_cost_usd'] == 0
    assert first['cache_id'] != third['cache_id']
    assert len(calls) == 2 and client.input_tokens == 600
    assert first['cost_usd'] == pytest.approx(.0000126)
    assert second['cost_usd'] == 0
    assert first['model'] == MODEL + '-20260917'
    assert first['requested_model'] == MODEL
    assert client.estimated_cost_usd == pytest.approx(.0000252)
    assert 'test-secret' not in json.dumps(first)


@pytest.mark.parametrize('kind', ['missing', 'nan', 'model', 'distribution', 'http', 'timeout'])
def test_malformed_and_unavailable_results_fail_closed(kind):
    def handler(request):
        if kind == 'timeout':
            raise httpx.ReadTimeout('private diagnostic must not escape')
        body = response(json.loads(request.content)['questions'])
        if kind == 'missing':
            body['answers'] = {}
        elif kind == 'nan':
            body['answers']['n']['noul'] = float('nan')
        elif kind == 'model':
            body['model'] = 'unexpected'
        elif kind == 'distribution':
            body['answers']['c']['probabilities']['yes'] = 2
        return httpx.Response(503 if kind == 'http' else 200, content=json.dumps(body))
    client = JevService('secret', transport=httpx.MockTransport(handler))
    result = asyncio.run(client.evaluate({}, {'n': noul('Q?', 'Yes', 'No'), 'c': choice('Q?', {'yes': 'Yes', 'no': 'No'})}))
    assert result['status'] == 'unavailable' and result['answers'] == {}
    assert 'private diagnostic' not in json.dumps(result)


def test_budget_and_cancellation():
    async def run():
        client, calls = service()
        client.max_requests = 1
        q = {'n': noul('Q?', 'Yes', 'No')}
        await client.evaluate({'id': 1}, q)
        assert (await client.evaluate({'id': 2}, q))['status'] == 'budget_exhausted'
        assert len(calls) == 1
        started = asyncio.Event()
        async def wait(request):
            started.set()
            await asyncio.Event().wait()
        client = JevService('key', transport=httpx.MockTransport(wait))
        task = asyncio.create_task(client.evaluate({}, q))
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    asyncio.run(run())


@pytest.mark.parametrize('introduction', ['Watch this video.', 'Here is the next part.'])
def test_reaction_survives_pacing_skips_and_time_mapping(introduction):
    transcript = [segment(1000, 2000, introduction), segment(8000, 9000, 'That was unbelievable.')]
    client, _ = service()
    report = asyncio.run(analyze_reactions(transcript, 1000, 9000, client))
    assert report['protected_source'] == [[1000, 9000]]
    protected = window_protection(report, 1000, 8000)
    words = [WindowWord(0, 1000, introduction), WindowWord(7000, 8000, 'reaction')]
    keeps = compute_keep_intervals(words, 8000, None, protected)
    keeps = subtract_intervals(keeps, [(1500, 6500)], protected, 8000)
    assert keeps == [(0, 8000)]
    timeline = TimeMap(keeps, 8000)
    assert timeline.output_ms == 8000 and timeline.to_output(7000) == 7000


def test_boundary_repair_or_explicit_incomplete_flag():
    report = {'protected_source': [[1000, 9000]], 'flags': []}
    assert repair_context_boundaries(1500, 8500, report, 0, 10000, 8000) == (1000, 9000)
    assert 'reaction_boundaries_expanded' in report['flags']
    report['flags'] = []
    assert repair_context_boundaries(1500, 8500, report, 0, 10000, 7000) == (1500, 8500)
    assert 'incomplete_reaction_context' in report['flags']


def test_uncertainty_and_missing_provider_keep_context_but_dead_air_can_cut():
    transcript = [segment(0, 1000, 'The first point.'), segment(5000, 6000, 'Next point.')]
    for client in [service(uncertain=True)[0], JevService('key', max_requests=0)]:
        report = asyncio.run(analyze_reactions(transcript, 0, 6000, client))
        assert report['protected_source'] == [[0, 6000]]
    report = asyncio.run(analyze_reactions(transcript, 0, 6000, service(reaction=False)[0]))
    assert report['protected_source'] == []
    local = [segment(0, 1000, 'Watch this.'), segment(5000, 6000, 'That was wild.')]
    assert asyncio.run(analyze_reactions(local, 0, 6000, JevService()))['protected_source'] == [[0, 6000]]


def test_pause_crossing_layout_transition_uses_all_shots():
    words = [WindowWord(0, 1000, 'before'), WindowWord(2500, 3500, 'after')]
    for next_layout in ['screen_cam', 'screen']:
        plan = ClipLayoutPlan([ShotLayout(0, 1500, 'talking_head'), ShotLayout(1500, 3500, next_layout)], 1920, 1080)
        assert compute_keep_intervals(words, 3500, plan) == [(0, 3500)]


def test_protection_survives_rounding_unsorted_ranges_and_sliver_removal():
    keeps = subtract_intervals([(0, 3000)], [(0, 3000)], [(1001, 1051), (333, 601)], 3000)
    for a, b in [(1001, 1051), (333, 601)]:
        assert any(start <= a and end >= b for start, end in keeps)


def test_reaction_beginning_at_clip_boundary_recovers_the_watched_event():
    transcript = [segment(0, 1000, 'Watch this.'), segment(5000, 7000, 'That was wild.')]
    report = asyncio.run(analyze_reactions(transcript, 5000, 7000, service()[0]))
    assert report['protected_source'] == [[0, 7000]]
    assert repair_context_boundaries(5000, 7000, report, 0, 9000, 8000) == (0, 7000)


def test_meaningful_acknowledgment_and_uncertain_tone_are_protected():
    async def run(client):
        report = {'protected_source': [], 'fillers': [], 'flags': []}
        await protect_acknowledgments(client, [segment(0, 500, 'yes'), segment(700, 1000, 'mhm'), segment(1200, 1600, 'right')], 0, 1600, report)
        return report
    for client in [service()[0], service(uncertain=True)[0], JevService()]:
        report = asyncio.run(run(client))
        assert report['protected_source'] == [[700, 1000]]
    report = asyncio.run(run(service(reaction=False)[0]))
    assert report['protected_source'] == []
    assert report['fillers'][0]['decision'] == 'allow_pacing'


def test_qa_flags_missing_or_visual_only_evidence_and_does_not_filter():
    async def run():
        report = {'candidates': [], 'flags': []}
        await review_retained_clip(service()[0], 'A title', [], report)
        return report
    report = asyncio.run(run())
    assert 'editorial_insufficient_evidence' in report['flags']
    assert 'missing_context' in report['flags']
    assert set(report['qa']['judgment']['answers']) >= {'hook', 'standalone', 'arc', 'quotability', 'ending'}


@pytest.mark.parametrize('probability,flagged', [(.699, True), (.70, False), (.79, False)])
def test_final_title_review_uses_seventy_percent_threshold(probability, flagged):
    async def evaluate(state, questions):
        answers = response(questions)['answers']
        answers['title_supported']['noul'] = probability
        return {'status': 'success', 'answers': answers}
    report = {'candidates': [], 'flags': []}
    client = SimpleNamespace(enabled=True, evaluate=evaluate)
    asyncio.run(review_retained_clip(client, 'A title', [segment(0, 1000, 'A complete statement.')], report))
    assert ('title_needs_review' in report['flags']) == flagged


def test_duplicate_review_is_bounded_and_preserves_distinct_clips():
    async def run():
        client, calls = service()
        segments = [SimpleNamespace(summary='Common takeaway example', start_time_ms=i * 10000, end_time_ms=i * 10000 + 5000,
            editorial={'qa': {'evidence': {'title': 'Common takeaway', 'retained_dialogue': f'Example {i}'}}, 'flags': [], 'duplicates': []}) for i in range(10)]
        await review_duplicate_candidates(client, segments)
        return segments, calls
    segments, calls = asyncio.run(run())
    assert len(segments) == 10 and len(calls) == 12
    assert all('possible_duplicate_takeaway' not in s.editorial['flags'] for s in segments)


def test_visual_escalation_is_bounded_and_only_sends_text_to_jev(monkeypatch, tmp_path):
    from clip_engine.services import editorial_vision as module
    calls = []
    def sample(_video, output, timestamp):
        output.write_bytes(b'fixture-jpeg')
        return True
    async def completion(client, payload):
        calls.append(payload)
        timestamps = [int(item['text'].split()[2]) for item in payload['messages'][0]['content'] if item.get('type') == 'text' and item['text'].startswith('Source timestamp')]
        result = {'observations': [{'timestamp_ms': t, 'description': 'A person beside a shared video.'} for t in timestamps], 'needs_more_evidence': True}
        return {'choices': [{'message': {'content': json.dumps(result)}}]}, {'cost': .001, 'prompt_tokens': 100, 'completion_tokens': 50}
    monkeypatch.setattr(module, '_sample_one', sample)
    monkeypatch.setattr(module, 'chat_completion', completion)
    settings = SimpleNamespace(jev_visual_context=True, openrouter_api_key='fixture', layout_vision_model='fixture/vision')
    observer = module.EditorialVision(settings, 'fixture.mp4', str(tmp_path), 20000)
    async def run():
        record = await observer.observe([1000, 9000])
        cached = await observer.observe([1000, 9000])
        return record, cached
    record, cached = asyncio.run(run())
    assert len(calls) == 2 and cached['cache_hit']
    assert record['status'] == 'insufficient'
    assert len(record['attempts'][0]['sample_times']) == 6
    assert len(record['attempts'][1]['sample_times']) == 12
    assert observer.cost_usd == pytest.approx(.002)
    assert 'fixture-jpeg' not in json.dumps(record) and 'image_url' not in json.dumps(record)


@pytest.mark.parametrize('kind', ['unavailable', 'malformed', 'uncertain'])
def test_optional_reviews_fail_to_flags_without_deleting_clips(kind):
    def handler(request):
        body = response(json.loads(request.content)['questions'], uncertain=kind == 'uncertain')
        if kind == 'malformed':
            body['answers'] = {}
        return httpx.Response(503 if kind == 'unavailable' else 200, json=body)
    async def run():
        client = JevService('fixture', transport=httpx.MockTransport(handler))
        clips = []
        for i in range(2):
            report = {'candidates': [], 'flags': [], 'duplicates': []}
            await review_retained_clip(client, 'Shared topic', [segment(0, 1000, f'Example {i}')], report)
            clips.append(SimpleNamespace(summary='Shared topic', start_time_ms=i * 2000, end_time_ms=i * 2000 + 1000, editorial=report))
        await review_duplicate_candidates(client, clips)
        return clips
    clips = asyncio.run(run())
    assert len(clips) == 2
    for clip in clips:
        assert ('uncertain_missing_context' if kind == 'uncertain' else 'editorial_review_unavailable') in clip.editorial['flags']
        assert 'possible_duplicate_takeaway' not in clip.editorial['flags']
        assert len(clip.editorial['duplicates']) == 1
        assert clip.editorial['duplicates'][0]['evidence']['first']['retained_dialogue'] == 'Example 0'


def test_vision_failure_records_attempt_and_budget_prevents_requests(monkeypatch, tmp_path):
    from clip_engine.services import editorial_vision as module
    def sample(_video, output, timestamp):
        output.write_bytes(b'fixture')
        return True
    async def failure(*args):
        raise httpx.ReadTimeout('private provider message')
    monkeypatch.setattr(module, '_sample_one', sample)
    monkeypatch.setattr(module, 'chat_completion', failure)
    settings = SimpleNamespace(jev_visual_context=True, openrouter_api_key='fixture', layout_vision_model='fixture/vision')
    observer = module.EditorialVision(settings, 'fixture.mp4', str(tmp_path), 20000)
    record = asyncio.run(observer.observe([1000, 9000]))
    assert record['status'] == 'unavailable' and observer.requests == 1
    assert record['attempts'][0]['status'] == 'unavailable'
    assert record['attempts'][0]['cost_usd'] is None
    assert 'private provider' not in json.dumps(record)
    observer.requests = 8
    assert asyncio.run(observer.observe([1100, 9000]))['status'] == 'budget_exhausted'
    settings.jev_visual_context = False
    assert asyncio.run(observer.observe([1200, 9000]))['status'] == 'disabled'



def test_local_render_time_does_not_exhaust_editorial_request_budget(monkeypatch):
    from clip_engine.services import jev_service as module
    now = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    async def run():
        client, calls = service()
        q = {'n': noul('Question?', 'Yes', 'No')}
        assert (await client.evaluate({'stage': 'before rendering'}, q))['status'] == 'success'
        now[0] += 600  # Local FFmpeg work must not consume provider time.
        assert (await client.evaluate({'stage': 'retained QA'}, q))['status'] == 'success'
        client.request_seconds = 120
        assert (await client.evaluate({'stage': 'duplicate review'}, q))['status'] == 'budget_exhausted'
        assert len(calls) == 2
    asyncio.run(run())



def test_jev_uses_only_existing_openrouter_key_and_respects_review_toggle():
    settings = SimpleNamespace(openrouter_api_key='existing-openrouter', jev_enabled=True,
                               typesafe_api_key='obsolete-key')
    assert JevService.from_settings(settings)._api_key == 'existing-openrouter'
    settings.jev_enabled = False
    assert not JevService.from_settings(settings).enabled
    settings.jev_enabled = True
    settings.openrouter_api_key = ''
    assert not JevService.from_settings(settings).enabled


@pytest.mark.parametrize('billed', [None, 0, .00002, -1, 'invalid'])
def test_openrouter_cost_reporting_and_missing_cost_estimate(billed):
    def handler(request):
        body = response(json.loads(request.content)['questions'])
        body['model'] = MODEL
        body['usage']['cost'] = billed
        return httpx.Response(200, json=body)
    client = JevService('fixture', transport=httpx.MockTransport(handler))
    result = asyncio.run(client.evaluate({}, {'n': noul('Question?', 'Yes', 'No')}))
    if billed in [-1, 'invalid']:
        assert result['status'] == 'unavailable'
    else:
        assert result['status'] == 'success' and result['cost_usd'] == billed
        assert client.estimated_cost_usd == pytest.approx(.0000126 if billed is None else billed)


def test_time_between_candidates_does_not_exhaust_visual_review_budget(monkeypatch, tmp_path):
    from clip_engine.services import editorial_vision as module
    now = [100.0]
    monkeypatch.setattr(module.time, 'monotonic', lambda: now[0])
    def sample(_video, output, timestamp):
        output.write_bytes(b'fixture')
        return True
    async def completion(client, payload):
        now[0] += 1
        return {'choices': [{'message': {'content': json.dumps({'observations': [], 'needs_more_evidence': False})}}]}, {'cost': .001}
    monkeypatch.setattr(module, '_sample_one', sample)
    monkeypatch.setattr(module, 'chat_completion', completion)
    settings = SimpleNamespace(jev_visual_context=True, openrouter_api_key='fixture', layout_vision_model='fixture/vision')
    observer = module.EditorialVision(settings, 'fixture.mp4', str(tmp_path), 20000)
    async def run():
        assert (await observer.observe([1000, 9000]))['status'] == 'observed'
        now[0] += 300  # Repairing other candidates is outside the visual-work budget.
        assert (await observer.observe([10000, 18000]))['status'] == 'observed'
        observer.work_seconds = 90
        assert (await observer.observe([11000, 19000]))['status'] == 'budget_exhausted'
    asyncio.run(run())
    assert observer.requests == 2
