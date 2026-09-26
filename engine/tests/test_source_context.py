"""Offline coverage for grounded context, bounded research and safe degradation."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from clip_engine.config import Settings
from clip_engine.services import source_context as module
from clip_engine.services.source_context import SourceContextService, context_for_prompt, transcription_terms


def source(**changes):
    return SimpleNamespace(**dict({'title': 'Dr Rivera reacts to Example AI', 'description': 'A careful review of Example AI claims.',
        'channel': 'Rivera Reviews', 'channel_id': 'UCfixture', 'uploader': 'Rivera Reviews',
        'upload_date': '20250101', 'source_type': 'youtube'}, **changes))


def brief():
    return {'summary': 'Likely commentary on an AI demonstration; verify against the video.',
        'channel_summary': 'Metadata suggests a review channel; broader focus is uncertain.',
        'format': 'Likely reaction/commentary', 'topics': ['Example AI'],
        'perspectives': ['Separate the host reaction from claims in the watched demonstration.'],
        'clip_guidance': ['Keep the demonstration setup and host response together.'],
        'uncertainties': ['The host may disagree with the title.'],
        'vocabulary': ['Dr Rivera', 'Example AI', 'Invented Person'],
        'background': [{'claim': 'Example AI is a demonstration project.', 'url': 'https://example.org/project'}]}


def response(raw=None, citations=True, finish='stop', cost=.003):
    return {'model': 'google/gemini-3.8-flash', 'usage': {'server_tool_use': {'web_search_requests': 1}},
        'choices': [{'finish_reason': finish, 'message': {'content': json.dumps(brief() if raw is None else raw),
            'annotations': [{'type': 'url_citation', 'url_citation': {'url': 'https://example.org/project', 'title': 'Project documentation'}}] if citations else []}}]}, {
            'prompt_tokens': 200, 'completion_tokens': 100, 'total_tokens': 300, 'cost': cost}


def service(**settings):
    return SourceContextService(Settings(_env_file=None, openrouter_api_key='fixture-key', **settings))


def test_every_public_video_uses_gemini_research_with_bounded_tools_and_grounded_terms(monkeypatch):
    calls = []
    async def complete(client, payload):
        calls.append(payload)
        return response()
    monkeypatch.setattr(module, 'chat_completion', complete)
    record = asyncio.run(service().build(source()))
    payload = calls[0]
    assert payload['model'] == 'google/gemini-3.8-flash'
    assert payload['tool_choice'] == 'required'
    assert payload['max_tool_calls'] == 2
    assert payload['tools'][0]['parameters'] == {'engine': 'exa', 'max_uses': 2, 'max_results': 2, 'max_total_results': 4, 'max_characters': 2000}
    assert 'UCfixture' in payload['messages'][1]['content']
    assert 'BEFORE transcription' in payload['messages'][0]['content']
    assert record['research_status'] == 'completed' and record['status'] == 'ready'
    assert record['brief']['vocabulary'] == ['Dr Rivera', 'Example AI']
    assert record['brief']['background'] == brief()['background']
    assert record['cost_usd'] == .003 and not record['cost_incomplete']
    assert record['requests'][0]['search_requests'] == 1
    assert transcription_terms(['example AI', 'Custom'], record) == ['example AI', 'Custom', 'Dr Rivera']
    assert context_for_prompt(record)['brief']['format'] == 'Likely reaction/commentary'
    assert 'not evidence' in context_for_prompt(record)['rule']
    assert 'fixture-key' not in json.dumps(record)


@pytest.mark.parametrize('metadata,settings', [(source(source_type='local'), {}), (source(source_type='direct_url'), {}),
    (source(), {'source_context_web_research': False})])
def test_local_and_disabled_research_never_offer_web_tools(monkeypatch, metadata, settings):
    async def complete(client, payload):
        assert 'tools' not in payload and 'tool_choice' not in payload
        return response(citations=False)
    monkeypatch.setattr(module, 'chat_completion', complete)
    record = asyncio.run(service(**settings).build(metadata))
    assert record['research_status'] in ('disabled', 'not_applicable')
    assert record['brief']['background'] == [] and record['citations'] == []
    assert len(record['requests']) == 1


@pytest.mark.parametrize('failure', ['no_citations', 'invalid_json', 'truncated', 'provider'])
def test_failed_research_gets_one_metadata_only_fallback(monkeypatch, failure):
    calls = []
    async def complete(client, payload):
        calls.append(payload)
        if len(calls) == 1:
            if failure == 'provider':
                raise RuntimeError('secret-provider-response')
            if failure == 'invalid_json':
                return response(raw={'unexpected': 'data'})
            return response(citations=failure != 'no_citations', finish='length' if failure == 'truncated' else 'stop')
        assert 'tools' not in payload
        return response(citations=False)
    monkeypatch.setattr(module, 'chat_completion', complete)
    record = asyncio.run(service().build(source()))
    assert len(calls) == 2 and record['research_status'] == 'unavailable'
    assert record['status'] == 'ready' and record['citations'] == [] and record['brief']['background'] == []
    assert record['cost_usd'] == (.003 if failure == 'provider' else .006)
    assert 'secret-provider-response' not in json.dumps(record)


def test_total_failure_retains_bounded_metadata_and_unknown_cost(monkeypatch):
    monkeypatch.setattr(module, 'chat_completion', AsyncMock(side_effect=TimeoutError()))
    record = asyncio.run(service().build(source(description='x' * 50000)))
    assert record['status'] == 'metadata_only' and record['brief'] is None
    assert record['cost_incomplete'] and len(record['source']['description']) == 12000
    assert len(record['requests']) == 2
    assert len(context_for_prompt(record)['metadata']['description']) == 2000


def test_cancellation_propagates_without_fallback(monkeypatch):
    call = AsyncMock(side_effect=asyncio.CancelledError())
    monkeypatch.setattr(module, 'chat_completion', call)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(service().build(source()))
    assert call.await_count == 1


def test_provider_annotations_are_required_for_facts_and_unsafe_urls_are_dropped():
    body, _ = response()
    body['choices'][0]['message']['annotations'] += [
        {'type': 'url_citation', 'url_citation': {'url': url}} for url in
        ['javascript:alert(1)', 'https://user:secret@example.org', 'https://127.0.0.1/x', 'https://host.local/x']]
    citations = module.citations_from(body)
    assert len(citations) == 1
    raw = brief()
    raw['background'].append({'claim': 'Unsupported source', 'url': 'https://made-up.example/fact'})
    assert len(module.validate_brief(raw, module.metadata_for_context(source()), citations)['background']) == 1


def test_source_context_reaches_planning_repairs_and_cut_review(monkeypatch):
    from clip_engine.services.intelligence_planner import IntelligencePlannerService, ClipPlanSegment
    from tests.test_coherence_review import reviewer, report
    from clip_engine.services.clip_editor import TimeMap
    record = {'status': 'ready', 'source': module.metadata_for_context(source()), 'brief': brief(),
              'research_status': 'completed', 'citations': []}
    context = context_for_prompt(record)
    messages = IntelligencePlannerService()._build_vision_messages('Plan clips', 'Actual spoken words', [], 2, [object()], 60, source_context=context)
    assert 'PRE-TRANSCRIPTION SOURCE CONTEXT' in messages[1]['content'][0]['text']
    assert 'Actual spoken words' in messages[1]['content'][1]['text']
    assert 'confirm or correct' in messages[0]['content']
    gate, calls = reviewer()
    gate.source_context = context
    audit = report()
    asyncio.run(gate.judge('Supported title', [(0, 11000)], audit, 'final_edit'))
    assert all(c['state']['source_context'] == context for c in calls)
    asyncio.run(gate.audit_edit('Title', TimeMap([(0, 2000), (6000, 11000)], 11000), 0, 11000, audit, None))
    cut = next(a for a in audit['coherence']['attempts'] if a['stage'] == 'cut')
    assert cut['evidence']['source_context'] == context
    async def completion(client, payload):
        assert json.loads(payload['messages'][1]['content'])['source_context'] == context
        raise RuntimeError('offline fixture')
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    asyncio.run(gate.repair(ClipPlanSegment(0, 11000, .9, summary='Title'), audit, 0))
    assert audit['coherence']['repairs'][0]['evidence']['source_context'] == context


def test_invalid_usage_cannot_corrupt_the_saved_context(monkeypatch):
    async def complete(client, payload):
        body, usage = response()
        usage.update(cost=float('nan'), prompt_tokens='provider-secret', completion_tokens=-1, total_tokens=True)
        return body, usage
    monkeypatch.setattr(module, 'chat_completion', complete)
    record = asyncio.run(service().build(source()))
    assert record['status'] == 'ready' and record['cost_incomplete']
    assert all(v is None for v in record['requests'][0]['usage'].values())
    assert 'provider-secret' not in json.dumps(record, allow_nan=False)


def test_youtube_citations_retain_the_video_id_without_tracking_or_credentials():
    assert module.public_url('https://www.youtube.com/watch?v=abcdefghijk&utm_source=tracking&token=secret') == 'https://www.youtube.com/watch?v=abcdefghijk'
