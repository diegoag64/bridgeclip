"""Offline policy tests: synthetic transcripts and recorded/mocked provider decisions."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from clip_engine.services.coherence_review import CoherenceReviewer, CoherenceRejected
from clip_engine.services.clip_editor import TimeMap
from clip_engine.services.intelligence_planner import ClipPlanSegment
from clip_engine.services.jev_service import JevService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord
from tests.test_editorial_context import response
from tests.test_render_fallback import service, request_for, render  # noqa: F401


LIVE_CASES = json.loads((Path(__file__).parents[2] / 'tests/fixtures/editorial/coherence-live-decisions.json').read_text())['cases']


@pytest.mark.parametrize('case', LIVE_CASES, ids=lambda case: case['name'])
def test_recorded_live_decisions_accept_complete_excerpts_and_block_broken_contrasts(case):
    from clip_engine.services.coherence_review import CLIP_QUESTIONS, approved
    from clip_engine.services.jev_service import validate_answers
    record = case['judgment']
    # Historical v4 decisions remain historical; do not invent answers for new checks.
    assert record['questions'] == {k: v for k, v in CLIP_QUESTIONS.items() if k not in {'not_sponsored', 'opening_context'}}
    validate_answers(record['answers'], record['questions'])
    assert approved(record, [k for k in record['questions'] if k != 'evidence']) == case['expected_accept']


@pytest.mark.parametrize('safety,evidence,expected', [(.94, 1, False), (1, .499, False), (.95, .5, True)])
def test_cut_safety_stays_strict_with_relaxed_evidence_threshold(safety, evidence, expected):
    from clip_engine.services.coherence_review import CUT_PASS, CUT_QUESTIONS, approved
    record = {'status': 'success', 'answers': response(CUT_QUESTIONS)['answers']}
    record['answers']['removal_safe']['noul'] = safety
    record['answers']['evidence']['probabilities'] = {'sufficient': evidence, 'insufficient': 1 - evidence}
    assert approved(record, ['removal_safe', 'join_logical'], CUT_PASS) == expected


def transcript():
    return [TranscriptSegment(a, b, text, words=[TranscriptWord(text, a, b)]) for a, b, text in [
        (0, 2000, 'Here is the setup.'), (3000, 5000, 'The event happened.'),
        (6000, 8000, 'That explains the result.'), (9000, 11000, 'The qualification matters.')]]


def report():
    return {'version': 1, 'candidates': [], 'protected_source': [], 'flags': [], 'fillers': [], 'duplicates': [], 'qa': None}


def reviewer(decide=lambda state, q: True):
    calls = []
    def handler(request):
        payload = json.loads(request.content)
        if 'not_sponsored' not in payload['questions']:
            calls.append(payload)
        body = response(payload['questions'])
        if not decide(payload['state'], payload['questions']):
            for key, answer in body['answers'].items():
                if answer['type'] == 'noul' and key != 'not_sponsored': answer['noul'] = .5
        return httpx.Response(200, json=body)
    client = JevService('fixture', transport=httpx.MockTransport(handler))
    settings = SimpleNamespace(editorial_repair_model='fixture/cheap', openrouter_api_key='fixture')
    return CoherenceReviewer(client, settings, transcript(), 12000), calls


@pytest.mark.parametrize('failed', ['not_sponsored', 'opening_context', 'self_contained', 'complete_ending', 'logical_flow', 'faithful_to_source', 'title_supported', 'evidence'])
def test_each_failed_check_blocks_even_when_other_checks_are_certain(failed):
    from clip_engine.services.coherence_review import CLIP_QUESTIONS, approved, check_threshold
    answers = response(CLIP_QUESTIONS)['answers']
    for key, answer in answers.items():
        if answer['type'] == 'noul':
            answer['noul'] = check_threshold(key) - .01 if key == failed else 1.0
    if failed == 'evidence':
        answers['evidence']['probabilities'] = {'sufficient': .49, 'insufficient': .51}
    assert not approved({'status': 'success', 'answers': answers}, [k for k in CLIP_QUESTIONS if k != 'evidence'])


@pytest.mark.parametrize('self_contained,evidence,accepted', [
    (.70, .50, True), (.72, .60, True), (.699, .90, False), (.90, .499, False),
])
def test_relaxed_thresholds_apply_to_candidate_and_final_review(self_contained, evidence, accepted):
    r, _ = reviewer()
    async def evaluate(state, questions):
        answers = response(questions)['answers']
        if 'self_contained' in answers:
            answers['self_contained']['noul'] = self_contained
            answers['evidence']['probabilities'] = {'sufficient': evidence, 'insufficient': 1 - evidence}
            answers['evidence']['choice'] = 'sufficient' if evidence >= .5 else 'insufficient'
        return {'status': 'success', 'answers': answers}
    r.service.evaluate = evaluate
    r.repair = AsyncMock(return_value=None)
    r.visual_observer = AsyncMock(return_value={'status': 'unavailable', 'observations': []})
    audit = report()
    clip = ClipPlanSegment(0, 11000, .9, summary='Supported result')
    assert asyncio.run(r.prepare(clip, audit)) == accepted
    assert asyncio.run(r.judge(clip.summary, [(0, 11000)], audit, 'final_edit')) == accepted
    assert audit['coherence']['policy'] == 'coherence-v8'
    assert audit['coherence']['self_contained_threshold'] == .70
    assert audit['coherence']['evidence_threshold'] == .50
    if accepted:
        r.repair.assert_not_called()
        r.visual_observer.assert_not_called()


@pytest.mark.parametrize('check,probability,accepted', [
    ('faithful_to_source', .649, False), ('faithful_to_source', .65, True), ('faithful_to_source', .699, True),
    ('title_supported', .699, False), ('title_supported', .70, True), ('title_supported', .749, True),
    ('not_sponsored', .799, False), ('not_sponsored', .80, True), ('not_sponsored', .899, True),
])
def test_source_title_and_sponsor_thresholds_apply_to_candidates_and_final_edits(check, probability, accepted):
    r, _ = reviewer()
    async def evaluate(state, questions):
        answers = response(questions)['answers']
        if check in answers:
            answers[check]['noul'] = probability
        return {'status': 'success', 'answers': answers}
    r.service.evaluate = evaluate
    r.repair = AsyncMock(return_value=None)
    audit = report()
    clip = ClipPlanSegment(0, 11000, .9, summary='Supported result')
    assert asyncio.run(r.prepare(clip, audit)) == accepted
    assert asyncio.run(r.judge(clip.summary, [(0, 11000)], audit, 'final_edit')) == accepted
    assert audit['coherence']['faithful_to_source_threshold'] == .65
    assert audit['coherence']['sponsor_threshold'] == .80
    assert audit['coherence']['title_supported_threshold'] == .70
    assert audit['coherence']['threshold'] == .75
    if accepted:
        r.repair.assert_not_called()


def test_unavailable_judgment_never_accepts_or_pays_for_repairs(monkeypatch):
    r, _ = reviewer()
    r.service = JevService()
    repair = AsyncMock()
    monkeypatch.setattr(r, 'repair', repair)
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), audit))
    assert audit['coherence']['status'] == 'rejected'
    repair.assert_not_called()


def test_repair_can_cross_both_preferred_edges_but_requires_fresh_jev_pass(monkeypatch):
    r, calls = reviewer(lambda state, q: 'setup' in state['retained_dialogue'] and 'qualification' in state['retained_dialogue'])
    async def completion(_client, payload):
        assert payload['model'] == 'fixture/cheap'
        assert payload['reasoning'] == {'effort': 'low', 'exclude': True}
        assert payload['max_tokens'] == 4096
        assert payload['provider'] == {'require_parameters': True}
        assert 'never pad or truncate' in payload['messages'][0]['content']
        return repair_response(json.dumps({'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'A supported result'})), {'cost': .001}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    segment = ClipPlanSegment(3000, 8000, .9, summary='Result')
    audit = report()
    assert asyncio.run(r.prepare(segment, audit))
    assert (segment.start_time_ms, segment.end_time_ms) == (0, 11000)
    assert len(calls) == 2 and r.repair_requests == 1
    assert [a['decision'] for a in audit['coherence']['attempts']] == ['reject', 'accept']
    assert audit['coherence']['repairs'][0]['request_messages']


@pytest.mark.parametrize('proposal', [
    {'omit': True, 'start_segment': 0, 'end_segment': 3, 'title': 'Title'},
    {'omit': False, 'start_segment': 0, 'end_segment': 99, 'title': 'Title'},
    {'omit': False, 'start_segment': True, 'end_segment': 3, 'title': 'Title'},
])
def test_omitted_or_malformed_repairs_never_force_a_clip(monkeypatch, proposal):
    r, _ = reviewer(lambda state, q: False)
    async def completion(*args):
        return {'choices': [{'message': {'content': json.dumps(proposal)}}]}, {}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), report()))
    assert r.repair_requests == 1


def test_repair_cannot_loop_forever(monkeypatch):
    r, _ = reviewer(lambda state, q: False)
    repair = AsyncMock(side_effect=[(0, 8000, 'First repair'), (0, 11000, 'Second repair')])
    monkeypatch.setattr(r, 'repair', repair)
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), report()))
    assert repair.await_count == 2


def test_uncertain_exact_removal_is_restored_before_whole_edit_acceptance():
    r, calls = reviewer(lambda state, q: 'removal_safe' not in q)
    audit = report()
    result = asyncio.run(r.audit_edit('A result', TimeMap([(0, 2000), (6000, 11000)], 11000), 0, 11000, audit, None))
    assert result.keeps == [(0, 11000)]
    assert calls[0]['state']['removed_text'] == '[source 2000..6000 ms] The event happened.'
    assert audit['prevented_cuts'] == [{'interval': [2000, 6000], 'kind': 'coherence'}]


def test_individually_safe_cuts_cannot_bypass_whole_edit_check():
    r, _ = reviewer(lambda state, q: 'removal_safe' in q or '[EDIT JOIN]' not in state['retained_dialogue'])
    audit = report()
    result = asyncio.run(r.audit_edit('A result', TimeMap([(0, 2000), (6000, 11000)], 11000), 0, 11000, audit, None))
    assert result.keeps == [(0, 11000)]
    assert [a['decision'] for a in audit['coherence']['attempts']] == ['allow_cut', 'reject', 'accept']


def test_cut_through_word_is_restored_without_judgment():
    r, calls = reviewer()
    result = asyncio.run(r.audit_edit('A result', TimeMap([(0, 1000), (1500, 11000)], 11000), 0, 11000, report(), None))
    assert result.keeps == [(0, 11000)]
    assert all('removal_safe' not in c['questions'] for c in calls)


def test_unapproved_final_edit_never_reaches_ffmpeg(service, monkeypatch, tmp_path):
    r, _ = reviewer(lambda state, q: False)
    encode = AsyncMock()
    monkeypatch.setattr(service, '_render_edit', encode)
    request = request_for(tmp_path, apply_padding=False, editorial_context=report(), coherence_reviewer=r)
    with pytest.raises(CoherenceRejected): render(service, request)
    encode.assert_not_called()


def test_fallback_does_not_render_a_new_unapproved_edit(service, monkeypatch, tmp_path):
    from clip_engine.services.rendering_service import RenderingError
    r, _ = reviewer()
    r.judge = AsyncMock(return_value=False)
    r.audit_edit = AsyncMock(return_value=TimeMap([(0, 2000), (6000, 10000)], 10000))
    encode = AsyncMock(side_effect=RenderingError('fixture'))
    monkeypatch.setattr(service, '_render_edit', encode)
    request = request_for(tmp_path, apply_padding=False, editorial_context=report(), coherence_reviewer=r)
    r.trace(request.editorial_context)
    with pytest.raises(CoherenceRejected): render(service, request)
    assert encode.await_count == 2  # Smart and letterbox share the approved edit; natural timing was rejected.


def repair_response(text, finish='stop', reasoning=200):
    if finish == 'stop':
        try:
            value = json.loads(text)
            value.setdefault('diagnosis', {'check': 'self_contained', 'segment_id': 0,
                'quote': 'Here is the setup.', 'explanation': 'Include the setup before the event.'})
            text = json.dumps(value)
        except (TypeError, ValueError):
            pass
    return {'choices': [{'message': {'content': text}, 'finish_reason': finish}],
            'usage': {'completion_tokens_details': {'reasoning_tokens': reasoning}}}


@pytest.mark.parametrize('partial', ['{ "omit": false, "start_segment": ', None,
    '{"omit":false,"start_segment":0,"end_segment":3,"title":"Partial despite valid JSON"}'])
def test_output_limit_retries_once_and_requires_fresh_judgment(monkeypatch, partial):
    r, judgments = reviewer(lambda state, q: 'setup' in state['retained_dialogue'] and 'qualification' in state['retained_dialogue'])
    calls = []
    async def completion(_client, payload):
        calls.append(payload)
        if len(calls) == 1:
            return repair_response(partial, 'length', 767), {'cost': .001, 'completion_tokens': 785}
        return repair_response(json.dumps({'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'Complete result'})), {'cost': .002}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    audit = report()
    segment = ClipPlanSegment(3000, 8000, .9, summary='Result')
    assert asyncio.run(r.prepare(segment, audit))
    assert [p['max_tokens'] for p in calls] == [4096, 8192]
    assert calls[0]['messages'] == calls[1]['messages']
    assert r.repair_requests == 2 and r.repair_cost == pytest.approx(.003)
    assert len(judgments) == 2  # Partial responses never become edit proposals.
    repairs = audit['coherence']['repairs']
    assert [a['status'] for a in repairs] == ['truncated', 'proposed']
    assert [a['repair_round'] for a in repairs] == [1, 1]
    assert repairs[0]['finish_reason'] == 'length' and repairs[0]['reasoning_tokens'] == 767
    assert repairs[0]['proposal'] is None


def test_persistent_truncation_is_bounded_and_not_reported_as_poor_content(monkeypatch):
    from clip_engine.services.coherence_review import no_approved_clips_message
    r, _ = reviewer(lambda state, q: False)
    completion = AsyncMock(return_value=(repair_response('{"omit":', 'length'), {}))
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), audit))
    assert completion.await_count == 2
    assert 'Review could not finish for 1 of 1' in no_approved_clips_message([audit])
    assert 'does not establish' in no_approved_clips_message([audit])


def test_truncation_retry_respects_job_budget(monkeypatch):
    r, _ = reviewer(lambda state, q: False)
    r.repair_requests = 23
    completion = AsyncMock(return_value=(repair_response('', 'length'), {}))
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), audit))
    assert completion.await_count == 1 and r.repair_requests == 24
    assert audit['coherence']['repairs'][-1]['status'] == 'budget_exhausted'


def test_complete_repairs_that_fail_jev_remain_content_rejections(monkeypatch):
    from clip_engine.services.coherence_review import no_approved_clips_message
    r, _ = reviewer(lambda state, q: False)
    completion = AsyncMock(return_value=(repair_response(json.dumps({'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'Result'})), {}))
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), audit))
    assert completion.await_count == 2
    assert no_approved_clips_message([audit]).startswith('No clips passed the coherence review.')


def test_repair_cancellation_is_not_retried(monkeypatch):
    r, _ = reviewer(lambda state, q: False)
    completion = AsyncMock(side_effect=asyncio.CancelledError)
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), report()))
    assert completion.await_count == 1


def test_unchanged_first_repair_gets_wider_context_and_failed_check_feedback(monkeypatch):
    r, _ = reviewer(lambda state, q: 'setup' in state['retained_dialogue'] and 'qualification' in state['retained_dialogue'])
    # The second repair must be able to see context outside the first 60s margin.
    r.segments.append(TranscriptSegment(100000, 102000, 'Later context.'))
    r.duration_ms = 110000
    payloads = []
    async def completion(_client, payload):
        payloads.append(payload)
        state = json.loads(payload['messages'][1]['content'])
        assert {c['name'] for c in state['failed_checks']} == {'opening_context', 'self_contained', 'complete_ending', 'logical_flow', 'faithful_to_source', 'title_supported'}
        assert all(c['probability'] == .5 and c['required_probability'] == {'self_contained': .7, 'faithful_to_source': .65, 'title_supported': .7}.get(c['name'], .75) and c['question'] for c in state['failed_checks'])
        assert all(set(c['criteria']) == {'true', 'false'} for c in state['failed_checks'])
        if len(payloads) == 1:
            assert all(s['id'] != 4 for s in state['source_segments'])
            proposal = {'omit': False, 'start_segment': 1, 'end_segment': 2, 'title': 'Result'}
        else:
            assert any(s['id'] == 4 for s in state['source_segments'])
            assert state['previous_proposals'] == [[3000, 8000, 'Result']]
            proposal = {'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'Complete result'}
        return repair_response(json.dumps(proposal)), {}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    audit = report()
    segment = ClipPlanSegment(3000, 8000, .9, summary='Result')
    assert asyncio.run(r.prepare(segment, audit))
    assert len(payloads) == 2
    assert (segment.start_time_ms, segment.end_time_ms) == (0, 11000)
    assert audit['coherence']['status'] == 'accepted'


def test_review_keeps_speaker_turns_and_excludes_removed_words():
    from clip_engine.services.coherence_review import dialogue
    segments = [TranscriptSegment(0, 2000, 'It works.', speaker_label='C1S1', words=[TranscriptWord('It', 0, 1000), TranscriptWord('works.', 1000, 2000)]),
                TranscriptSegment(2000, 3000, 'That is false.', speaker_label='C1S2')]
    text = dialogue(segments, [(1000, 3000)])
    assert '(C1S1) works.\n(C1S2) That is false.' in text
    assert '(C1S1) It' not in text


def test_visual_review_uses_candidate_interval_without_speech_gaps():
    r, _ = reviewer()
    calls = []
    async def evaluate(state, questions):
        calls.append(state)
        answers = response(questions)['answers']
        if 'evidence' in answers and not state['visual_observations']:
            answers['evidence']['probabilities'] = {'sufficient': .49, 'insufficient': .51}
        return {'status': 'success', 'answers': answers}
    r.service.evaluate = evaluate
    r.visual_observer = AsyncMock(return_value={'status': 'observed', 'observations': [
        {'timestamp_ms': 4000, 'description': 'A labeled result is shown.', 'model': 'fixture', 'provenance': 'vision_inference'}]})
    audit = report()  # No speech gap candidates at all.
    assert asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9, summary='Result'), audit))
    r.visual_observer.assert_awaited_once_with([3000, 8000])
    assert len(calls) == 4
    assert audit['coherence']['visual_reviews'][0]['interval'] == [3000, 8000]
    assert not r.state('Result', [(6000, 8000)], audit)['visual_observations']


def test_evidence_only_failure_does_not_spend_on_boundary_repairs():
    r, _ = reviewer()
    from clip_engine.services.coherence_review import CLIP_QUESTIONS
    answers = response(CLIP_QUESTIONS)['answers']
    answers['evidence']['probabilities'] = {'sufficient': .49, 'insufficient': .51}
    r.service.evaluate = AsyncMock(side_effect=lambda state, questions: {'status': 'success', 'answers': {k: answers[k] for k in questions}})
    r.repair = AsyncMock()
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9), audit))
    r.repair.assert_not_called()
    assert audit['coherence']['reason'] == 'needs_visual_evidence'


@pytest.mark.parametrize('probability', [.01, .5, .799])
def test_sponsored_or_uncertain_segment_is_rejected_without_disguising_it(probability):
    from clip_engine.services.coherence_review import CLIP_QUESTIONS
    r, _ = reviewer()
    r.segments = [TranscriptSegment(0, 2000, 'A quick thank you to the sponsor.'),
                  TranscriptSegment(2000, 7000, 'Enterprise authentication is hard. Try ExampleAuth for free.'),
                  TranscriptSegment(7000, 9000, 'Visit our sponsor using the link below.')]
    answers = response(CLIP_QUESTIONS)['answers']
    answers['not_sponsored']['noul'] = probability
    r.service.evaluate = AsyncMock(side_effect=lambda state, questions: {'status': 'success', 'answers': {k: answers[k] for k in questions}})
    r.repair = AsyncMock()
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(2000, 7000, .9, summary='Enterprise authentication'), audit))
    r.repair.assert_not_called()
    assert 'sponsor' in r.service.evaluate.call_args.args[0]['before']
    assert 'link below' in r.service.evaluate.call_args.args[0]['after']
    assert audit['coherence']['reason'] == 'sponsored_or_uncertain_promotion'
    with pytest.raises(CoherenceRejected):
        asyncio.run(r.audit_edit('Enterprise authentication', TimeMap([(0, 5000)], 5000), 2000, 5000, report(), None))


def test_opening_reference_is_repaired_even_when_general_context_passes(monkeypatch):
    from clip_engine.services.coherence_review import CLIP_QUESTIONS
    r, _ = reviewer()
    r.segments = [TranscriptSegment(0, 3000, 'Here is an example: classify game messages for safety and usefulness.'),
                  TranscriptSegment(3000, 7000, 'And the reason I gave you this example is because I ran a game event.'),
                  TranscriptSegment(7000, 11000, 'Faster decisions could keep that event responsive.')]
    async def evaluate(state, questions):
        answers = response(questions)['answers']
        if 'opening_context' in answers:
            answers['opening_context']['noul'] = .95 if 'Here is an example' in state['retained_dialogue'] else .1
        return {'status': 'success', 'answers': answers}
    r.service.evaluate = evaluate
    async def completion(client, payload):
        state = json.loads(payload['messages'][1]['content'])
        assert [c['name'] for c in state['failed_checks']] == ['opening_context']
        assert 'actual referenced example' in payload['messages'][0]['content']
        return repair_response(json.dumps({'omit': False, 'start_segment': 0, 'end_segment': 2, 'title': 'Fast decisions for games',
            'diagnosis': {'check': 'opening_context', 'segment_id': 0, 'quote': r.segments[0].text, 'explanation': 'Include the missing example.'}})), {}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', completion)
    clip = ClipPlanSegment(3000, 11000, .9, summary='Fast decisions for games')
    audit = report()
    assert asyncio.run(r.prepare(clip, audit))
    assert clip.start_time_ms == 0
    assert [a['decision'] for a in audit['coherence']['attempts']] == ['reject', 'accept']
    assert all(a['judgment']['answers']['self_contained']['noul'] >= .9 for a in audit['coherence']['attempts'])


@pytest.mark.parametrize('policy_available', [True, False])
def test_new_policy_is_an_independent_required_request_with_its_own_trace(policy_available):
    from clip_engine.services.coherence_review import CORE_QUESTIONS, POLICY_QUESTIONS
    r, _ = reviewer()
    requests = []
    async def evaluate(state, questions):
        requests.append(questions)
        if questions == POLICY_QUESTIONS and not policy_available:
            return {'status': 'unavailable', 'answers': {}}
        return {'status': 'success', 'questions': questions, 'answers': response(questions)['answers']}
    r.service.evaluate = evaluate
    r.repair = AsyncMock()
    audit = report()
    assert asyncio.run(r.prepare(ClipPlanSegment(0, 11000, .9, summary='Example'), audit)) == policy_available
    assert requests == [CORE_QUESTIONS, POLICY_QUESTIONS]
    attempt = audit['coherence']['attempts'][0]
    assert attempt['judgment']['questions'] == CORE_QUESTIONS
    assert attempt['policy_judgment']['status'] == ('success' if policy_available else 'unavailable')
    r.repair.assert_not_called()


@pytest.mark.parametrize('bad', [None, {'check': 'self_contained', 'segment_id': 0, 'quote': 'Invented quotation', 'explanation': 'Missing setup'}])
def test_repair_requires_a_real_source_citation(monkeypatch, bad):
    r, _ = reviewer(lambda state, q: False)
    proposal = {'omit': False, 'start_segment': 0, 'end_segment': 3, 'title': 'Result', 'diagnosis': bad}
    monkeypatch.setattr('clip_engine.services.coherence_review.chat_completion', AsyncMock(return_value=(repair_response(json.dumps(proposal)), {})))
    audit = report()
    assert not asyncio.run(r.prepare(ClipPlanSegment(3000, 8000, .9), audit))
    assert audit['coherence']['repairs'][0]['proposal'] is None
