"""Reaction protection in source time. Models judge meaning; code owns all cuts.

Provider results are advisory. Unknown/uncertain candidates are retained rather
than destructively classified as dead air. No media is sent to TypeSafe.
"""
import re
import copy

from clip_engine.services.jev_service import JevService, choice, noul

INTRO = re.compile(r'\b(watch (this|that|it)|look at (this|that)|take a look|let.s (watch|see)|play (this|that|the)|here.s (a|the|what)|check (this|that) out)\b', re.I)
REFERENCE = re.compile(r'\b(did you (see|hear)|that was|what (was|did) that|look at (that|what)|react|unbelievable|ridiculous|wow|see what|that.s (why|what|how))\b', re.I)
AMBIGUOUS_FILLERS = {'hmm', 'hm', 'mm', 'mhm'}
MAX_CANDIDATES = 24

REACTION_QUESTIONS = {
    'introduces_event': noul('Does `dialogue_before` introduce something the viewer is about to watch in `candidate`?',
                            'An invitation or setup for an intervening demonstration or watched event.',
                            'Ordinary speech or a pause with no such introduction.'),
    'refers_back': noul('Does `dialogue_after` refer or react to the intervening content in `candidate`, including an implicit reaction without an introduction?',
                       'The following dialogue depends on what just happened in the interval.',
                       'It begins an unrelated topic or simply continues a sentence.'),
    'necessary_event': noul('Is retaining `candidate` necessary for a viewer to understand the following reaction, using only the supplied dialogue and observations?',
                           'Removing the watched event loses the referent, setup, demonstration or payoff.',
                           'The interval contains only dispensable waiting; the following dialogue is understandable without it.'),
    'evidence': choice('Can the supplied text establish whether cutting `candidate` preserves the meaning of the reaction? Do not imagine unseen actions. Visual observations are model inferences about sampled frames, not exhaustive video evidence.',
                       {'sufficient': 'The supplied dialogue and observations directly establish the relevant relationship.',
                        'insufficient': 'Unseen visuals, timing or missing dialogue could change the judgment.'}),
}


def _dialogue(segments, start, end):
    result = []
    for s in segments:
        words = [w.word for w in s.words if w.start_time_ms < end and w.end_time_ms > start]
        text = ' '.join(words) if s.words else s.text
        if text:
            result.append({'start_ms': max(start, s.start_time_ms), 'end_ms': min(end, s.end_time_ms), 'text': text[:1600]})
    return result


def reaction_candidates(segments, start_ms, end_ms):
    """Word/segment gaps touching the proposed clip, including crossing edges."""
    ordered = sorted(segments, key=lambda s: s.start_time_ms)
    spans = sorted([(w.start_time_ms, w.end_time_ms) for s in ordered for w in s.words]
                   or [(s.start_time_ms, s.end_time_ms) for s in ordered])
    gaps = []
    previous_end = None
    for a, b in spans:
        if previous_end is not None and a - previous_end >= 700 and previous_end < end_ms + 20000 and a > start_ms - 20000:
            before = [s for s in ordered if s.start_time_ms < previous_end and s.end_time_ms >= previous_end - 20000][-3:]
            after = [s for s in ordered if s.end_time_ms > a and s.start_time_ms <= a + 20000][:3]
            if before and after and before[-1].start_time_ms < end_ms and after[0].end_time_ms > start_ms:
                # Look beyond the first utterance: the actual reaction can be
                # the second sentence after playback resumes.
                reaction = next((s for s in after if REFERENCE.search(s.text)), after[0])
                setup = next((s for s in reversed(before) if INTRO.search(s.text)), before[-1])
                gaps.append({'interval': [previous_end, a],
                             'sequence': [min(setup.start_time_ms, previous_end), max(reaction.end_time_ms, a)],
                             'dialogue_before': _dialogue(before, max(0, previous_end - 20000), previous_end),
                             'dialogue_after': _dialogue(after, a, a + 20000)})
        previous_end = max(previous_end or 0, b)
    return gaps


def _hint(candidate):
    return bool(INTRO.search(' '.join(s['text'] for s in candidate['dialogue_before']))
                or REFERENCE.search(' '.join(s['text'] for s in candidate['dialogue_after'])))


def _protect(record):
    if record['status'] != 'success':
        return True, 'provider_unavailable'
    answers = record['answers']
    sufficient = answers['evidence']['probabilities']['sufficient'] >= .8
    probabilities = [answers[k]['noul'] for k in ('introduces_event', 'refers_back', 'necessary_event')]
    if sufficient and max(probabilities) < .2:
        return False, 'context_not_required'
    if answers['necessary_event']['noul'] >= .8 or answers['refers_back']['noul'] >= .8:
        return True, 'reaction_context'
    return True, 'uncertain_context'


async def analyze_reactions(segments, start_ms, end_ms, service: JevService, visual_observer=None):
    """Return source intervals and audit records; never change timing here."""
    candidates = reaction_candidates(segments, start_ms, end_ms)
    records, protected, flags = [], [], []
    if len(candidates) > MAX_CANDIDATES:
        # Bound state/calls without silently cutting unexamined context.
        protected.append([start_ms, end_ms])
        flags.append('reaction_candidate_limit')
    for candidate in candidates[:MAX_CANDIDATES]:
        state = {'candidate': candidate['interval'], 'dialogue_before': candidate['dialogue_before'],
                 'dialogue_after': candidate['dialogue_after'],
                 'observed_facts': {'transcript_speech_gap': True}, 'visual_observations': []}
        record = await service.evaluate(state, REACTION_QUESTIONS)
        history = [record]
        evidence_history = [copy.deepcopy(state)]
        visual = None
        if service.enabled and visual_observer and record['status'] == 'success' and record['answers']['evidence']['probabilities']['insufficient'] > .2:
            visual = await visual_observer(candidate['interval'])
            state['visual_observations'] = visual.get('observations', [])
            state['observed_facts']['visual_coverage'] = visual['status']
            if state['visual_observations']:
                record = await service.evaluate(state, REACTION_QUESTIONS)
                history.append(record)
                evidence_history.append(copy.deepcopy(state))
        preserve, reason = _protect(record)
        if visual and visual['status'] != 'observed':
            preserve, reason = True, 'insufficient_visual_evidence'
        if not service.enabled:
            preserve, reason = _hint(candidate), 'local_context_cue' if _hint(candidate) else 'rules_only'
        if preserve:
            protected.append(candidate['sequence'])
        records.append({**candidate, 'evidence': state, 'evidence_history': evidence_history, 'judgment': record, 'judgment_history': history, 'visual': visual,
                        'decision': 'protect' if preserve else 'allow_pacing', 'reason': reason})
    return {'version': 1, 'candidates': records, 'protected_source': protected, 'flags': flags,
            'qa': None, 'duplicates': [], 'fillers': []}


def repair_context_boundaries(start_ms, end_ms, report, allowed_start, allowed_end, max_duration_ms):
    """Expand only within explicit constraints, otherwise flag the incomplete edit."""
    protected = report['protected_source']
    a = min([start_ms] + [p[0] for p in protected])
    b = max([end_ms] + [p[1] for p in protected])
    if a >= allowed_start and b <= allowed_end and b - a <= max_duration_ms:
        if (a, b) != (start_ms, end_ms):
            report['flags'].append('reaction_boundaries_expanded')
        return a, b
    report['flags'].append('incomplete_reaction_context')
    return start_ms, end_ms


def window_protection(report, window_start, window_ms):
    return [(max(0, a - window_start), min(window_ms, b - window_start))
            for a, b in report.get('protected_source', [])
            if b > window_start and a < window_start + window_ms]


def record_prevented_cuts(report, baseline_keeps, planner_skips, protected, window_start, window_ms, plan):
    cuts, cursor = [], 0
    for a, b in baseline_keeps:
        if a > cursor:
            cuts.append((cursor, a))
        cursor = b
    if cursor < window_ms:
        cuts.append((cursor, window_ms))
    from clip_engine.services.clip_editor import preserve_intervals
    protections = preserve_intervals([], protected, window_ms)
    prevented = []
    for kind, intervals in [('pacing', cuts), ('planner_skip', planner_skips)]:
        i = 0
        for a, b in sorted(intervals):
            while i < len(protections) and protections[i][1] <= a:
                i += 1
            j = i
            while j < len(protections) and protections[j][0] < b:
                p, q = protections[j]
                if min(b, q) > max(a, p):
                    prevented.append({'interval': [window_start + max(a, p), window_start + min(b, q)], 'kind': kind})
                j += 1
    report['prevented_cuts'] = prevented
    for candidate in report['candidates']:
        a, b = candidate['interval']
        candidate['layout_segments'] = [
            {'start_ms': window_start + s.start_ms, 'end_ms': window_start + s.end_ms,
             'layout': s.detected_layout or s.layout}
            for s in (plan.shots if plan else []) if window_start + s.start_ms < b and window_start + s.end_ms > a]
