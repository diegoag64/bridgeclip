"""Review-only editorial signals; no unvalidated automatic clip filtering."""
import re

from clip_engine.services.jev_service import choice, noul, score
from clip_engine.services.editorial_context import AMBIGUOUS_FILLERS

SCORE_LEVELS = {
    'hook': ['Opening gives no reason to continue', 'Opening identifies an interesting topic', 'Opening immediately establishes a specific compelling question or event'],
    'standalone': ['Essential referents or setup are missing', 'Some context is implied rather than explained', 'The excerpt supplies the context needed to follow it'],
    'arc': ['Setup or outcome is absent', 'A development is present but its payoff is weak', 'A clear setup develops into a payoff'],
    'quotability': ['No clear takeaway is expressed', 'A takeaway is present but needs explanation', 'A concise specific takeaway is clearly expressed'],
    'ending': ['The excerpt ends during an unfinished idea', 'The idea concludes but the ending is diffuse', 'The ending clearly completes the idea or reaction'],
}
QA_QUESTIONS = {
    'missing_context': noul('Does `retained_dialogue` require setup or referents absent from this edited clip?', 'Essential context is missing', 'The clip supplies the necessary context'),
    'unresolved_payoff': noul('Does `retained_dialogue` introduce a setup whose payoff is absent from the edited clip?', 'A setup remains unresolved', 'The setup is resolved or none is introduced'),
    'title_supported': noul('Does the evidence in `retained_dialogue` support `title` without exaggerating or inventing a claim?', 'The evidence supports the title', 'The title is unsupported or contradicts the evidence'),
    'evidence': choice('Can this clip be evaluated from the supplied retained dialogue and visual observations? Treat visual descriptions as model inferences about sampled instants. No audio tone is supplied.',
                       {'sufficient': 'The necessary evidence is supplied', 'insufficient': 'Missing visuals, tone or dialogue could change the assessment'}),
    **{key: score(f'Evaluate the {key} of this edited clip using `retained_dialogue` and the supplied observations only.', levels)
       for key, levels in SCORE_LEVELS.items()},
}


async def review_retained_clip(service, title, retained_segments, report):
    text = ' '.join(s.text for s in retained_segments)
    state = {'title': title or '', 'retained_dialogue': text[:6000], 'dialogue_truncated': len(text) > 6000,
             'visual_observations': [o for c in report['candidates'] for o in c['evidence'].get('visual_observations', [])][:24],
             'known_flags': list(report['flags']), 'audio_tone_available': False}
    judgment = await service.evaluate(state, QA_QUESTIONS)
    report['qa'] = {'evidence': state, 'judgment': judgment}
    if not service.enabled:
        return
    flags = report['flags']
    if judgment['status'] != 'success':
        flags.append('editorial_review_unavailable')
        return
    answers = judgment['answers']
    if not text.strip() or len(text) > 6000 or answers['evidence']['probabilities']['sufficient'] < .8:
        flags.append('editorial_insufficient_evidence')
    for key in ['missing_context', 'unresolved_payoff']:
        if answers[key]['noul'] >= .2:
            flags.append(key if answers[key]['noul'] >= .8 else f'uncertain_{key}')
    if answers['title_supported']['noul'] < .8:
        flags.append('title_needs_review')


async def protect_acknowledgments(service, segments, start_ms, end_ms, report):
    words = sorted([w for s in segments for w in s.words if w.end_time_ms > start_ms and w.start_time_ms < end_ms], key=lambda w: w.start_time_ms)
    candidates = [(i, w) for i, w in enumerate(words) if re.sub('[^a-z]', '', w.word.lower()) in AMBIGUOUS_FILLERS]
    for index, word in candidates[:12]:
        state = {'candidate': word.word, 'before': ' '.join(w.word for w in words[max(0, index - 20):index])[:1000],
                 'after': ' '.join(w.word for w in words[index + 1:index + 21])[:1000], 'audio_tone_available': False}
        questions = {
            'acknowledgment': noul('Does `candidate` function as a meaningful acknowledgment or reaction in this dialogue?', 'It acknowledges, agrees, reacts or answers', 'It is only hesitation'),
            'evidence': choice('Can `candidate` safely be judged dispensable from text alone, without hearing its tone?',
                               {'sufficient': 'Its role is unambiguous from the dialogue', 'insufficient': 'Its tone or role remains ambiguous'}),
        }
        judgment = await service.evaluate(state, questions)
        keep = judgment['status'] != 'success' or judgment['answers']['acknowledgment']['noul'] >= .2 or judgment['answers']['evidence']['probabilities']['sufficient'] < .8
        interval = [word.start_time_ms, word.end_time_ms]
        if keep:
            report['protected_source'].append(interval)
        report['fillers'].append({'interval': interval, 'evidence': state, 'judgment': judgment,
                                  'decision': 'protect' if keep else 'allow_pacing', 'reason': 'acknowledgment_or_uncertain' if keep else 'dispensable_hesitation'})
    if len(candidates) > 12:
        report['protected_source'].extend([[w.start_time_ms, w.end_time_ms] for _, w in candidates[12:]])
        report['flags'].append('filler_review_limit')


async def review_duplicate_candidates(service, segments):
    """Shortlist by lexical similarity; retain every clip until evaluated trials."""
    if not service.enabled:
        return
    pairs = []
    for i, first in enumerate(segments[:100]):
        a = set(re.findall(r'\w{4,}', (first.summary or '').lower()))
        for j in range(i + 1, min(len(segments), 100)):
            second = segments[j]
            if first.start_time_ms < second.end_time_ms and second.start_time_ms < first.end_time_ms:
                continue
            b = set(re.findall(r'\w{4,}', (second.summary or '').lower()))
            similarity = len(a & b) / max(1, len(a | b))
            if similarity >= .2:
                pairs.append((similarity, i, j))
    for _, i, j in sorted(pairs, reverse=True)[:12]:
        first, second = segments[i], segments[j]
        qa_a, qa_b = (s.editorial.get('qa') for s in (first, second))
        if not qa_a or not qa_b:
            continue
        state = {'first': qa_a['evidence'], 'second': qa_b['evidence']}
        judgment = await service.evaluate(state, {'relationship': choice(
            'Do these edited clips deliver the same takeaway? Shared topic alone is not duplication. Keep distinct examples, evidence and viewpoints separate.',
            {'same_takeaway': 'Substantially repeats the same point without a distinct example or viewpoint',
             'distinct': 'Adds a different example, evidence, conclusion or viewpoint',
             'insufficient': 'The supplied evidence cannot establish equivalence'})})
        for own, other in [(i, j), (j, i)]:
            segments[own].editorial['duplicates'].append({'other_clip': other, 'evidence': state, 'judgment': judgment})
            if judgment['status'] == 'success' and judgment['answers']['relationship']['probabilities']['same_takeaway'] >= .8:
                segments[own].editorial['flags'].append('possible_duplicate_takeaway')


def editorial_summary(report):
    if not report:
        return None
    qa = report.get('qa') or {}
    judgment = qa.get('judgment') or {}
    answers = judgment.get('answers', {})
    return {'flags': list(dict.fromkeys(report['flags']))[:32], 'status': judgment.get('status', 'disabled'),
            'scores': {key: answers[key] for key in SCORE_LEVELS if key in answers},
            'qa': {key: answers[key] for key in ('missing_context', 'unresolved_payoff', 'title_supported', 'evidence') if key in answers}}
