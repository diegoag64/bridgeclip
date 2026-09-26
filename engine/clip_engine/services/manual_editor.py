"""Review-first projects: suggestions and Jev advice, then exact human-directed exports."""
import asyncio
import json
import math
import os
import shutil
import tempfile
from datetime import datetime, timezone
from dataclasses import replace
from pathlib import Path

from clip_engine.services.coherence_review import CLIP_QUESTIONS, CUT_QUESTIONS, CUT_PASS, CoherenceReviewer, check_threshold, dialogue
from clip_engine.services.jev_service import JevService
from clip_engine.services.layout_analyzer import ClipLayoutPlan, ShotLayout, LayoutType
from clip_engine.services.layout_renderer import shot_views
from clip_engine.services.rendering_service import RenderRequest, RenderingService
from clip_engine.services.transcription_service import TranscriptSegment, TranscriptWord


def signature(c):
    # Canonical comparison is parsed JSON in the UI (Python keeps .0 floats).
    return json.dumps([c['title'], c['ranges'], [[s['at_ms'], s['layout'], s['crops']] +
        ([s['transition_ms']] if s.get('transition_ms') else []) for s in c['scenes']]], separators=(',', ':'), ensure_ascii=False)


def questions(schema, judgments, threshold=None):
    result = []
    for name, question in schema.items():
        judgment = next((j for j in judgments if j and name in j.get('questions', {})), None) or {}
        answer = judgment.get('answers', {}).get(name, {})
        probability = answer.get('noul') if question['type'] == 'noul' else answer.get('probabilities', {}).get('sufficient')
        criteria = question['criteria']
        result.append({'id': name, 'prompt': question['instructions'], 'yes': criteria.get('true', criteria.get('sufficient', '')),
            'no': criteria.get('false', criteria.get('insufficient', '')), 'probability': probability,
            'threshold': check_threshold(name, threshold or .75), 'status': judgment.get('status', 'unavailable')})
    return result


async def review_candidate(c, reviewer):
    report = {'moment': {'requires_visual_context': c.get('requires_visual_context', False)}}
    accepted = await reviewer.judge(c['title'], c['ranges'], report, 'candidate')
    attempt = report['coherence']['attempts'][-1]
    cuts = []
    for (_, a), (b, _) in zip(c['ranges'], c['ranges'][1:]):
        if a == b:
            continue
        state = {'title': c['title'], 'interval': [a, b], 'removed_text': dialogue(reviewer.segments, [(a, b)]),
            'before': dialogue(reviewer.segments, [(max(0, a - 15000), a)]),
            'after': dialogue(reviewer.segments, [(b, min(reviewer.duration_ms, b + 15000))]),
            'source_context': reviewer.source_context}
        judgment = await reviewer.service.evaluate(state, CUT_QUESTIONS)
        cuts.append({'interval': [a, b], 'questions': questions(CUT_QUESTIONS, [judgment], CUT_PASS)})
    accepted = accepted and all(q['probability'] is not None and q['probability'] >= q['threshold'] for cut in cuts for q in cut['questions'])
    c['review'] = {'signature': signature(c), 'reviewed_at': datetime.now(timezone.utc).isoformat(),
        'decision': 'passes' if accepted else 'needs_attention',
        'questions': questions(CLIP_QUESTIONS, [attempt.get('judgment'), attempt.get('policy_judgment')]), 'cuts': cuts}


def default_crop(w, h, aspect, cx=.5):
    cw, ch = min(1, h * aspect / w), min(1, w / aspect / h)
    return [max(0, min(1 - cw, cx - cw / 2)), (1 - ch) / 2, cw, ch]


async def prepare_project(request, segments, transcript, download, renderer, reviewer, output_dir, progress):
    if not segments:
        raise ValueError('No clip-worthy moments')
    w, h = await renderer._get_video_dimensions(download.video_path)
    duration = round(download.metadata.duration_seconds * 1000)
    aspect = 9 / 16 if request.aspect_ratio == '9:16' else 16 / 9
    project = {'version': 1, 'revision': 0, 'title': download.metadata.title, 'width': w, 'height': h,
        'duration_ms': duration, 'aspect_ratio': request.aspect_ratio, 'candidates': [],
        'transcript': [{'start_ms': max(0, min(duration, s.start_time_ms)), 'end_ms': max(0, min(duration, s.end_time_ms)), 'text': s.text} for s in transcript]}
    for i, segment in enumerate(segments[:100]):
        progress(f'Reviewing candidate {i + 1} of {min(100, len(segments))} with Jev…')
        a, b = max(0, segment.start_time_ms), min(duration, segment.end_time_ms)
        if b - a < 100:
            continue
        scenes = [{'at_ms': 0, 'layout': 'fit' if request.layout_style == 'fit' else 'fill', 'crops': [default_crop(w, h, aspect)]}]
        # Suggested shot layouts stay editable; no pacing cuts or captions are baked.
        if request.aspect_ratio == '9:16' and request.layout_style != 'fit':
            try:
                plan = await renderer.layout_analyzer.analyze(download.video_path, a, b - a, w, h, request.layout_style)
                scenes = []
                for j, shot in enumerate(plan.shots[:60]):
                    views = shot_views(shot, (shot.start_ms + shot.end_ms) // 2, w, h, 1080, 1920)
                    normalized = []
                    for ((x, y, cw, ch), _) in views[:2]:
                        target = aspect * len(views)
                        zoom = max(1, min(4, min(1, h * target / w) / max(.01, cw / w)))
                        base_w, base_h = min(1, h * target / w) / zoom, min(1, w / target / h) / zoom
                        normalized.append([max(0, min(1 - base_w, (x + cw / 2) / w - base_w / 2)), max(0, min(1 - base_h, (y + ch / 2) / h - base_h / 2)), base_w, base_h])
                    scenes.append({'at_ms': 0 if j == 0 else a + shot.start_ms,
                        'layout': 'split' if len(views) == 2 else 'fit' if shot.layout == LayoutType.SCREEN else 'fill',
                        'crops': normalized})
                if not scenes:
                    scenes = [{'at_ms': 0, 'layout': 'fill', 'crops': [default_crop(w, h, aspect)]}]
            except asyncio.CancelledError:
                raise
            except Exception:
                pass  # Centered framing is editable if detection isn't available.
        c = {'id': f'candidate-{i + 1}', 'title': (segment.summary or f'Clip {i + 1}')[:200],
            'ranges': [[a, b]], 'scenes': scenes, 'score': max(0, min(100, segment.virality_score)),
            'requires_visual_context': bool((getattr(segment, 'moment', None) or {}).get('requires_visual_context')),
            'reason': (getattr(segment, 'reasoning', '') or '')[:4000], 'captions': request.include_captions,
            'caption_preset': request.caption_preset, 'video_speed': request.video_speed, 'exports': [], 'review': None,
            'status': 'refining', 'caption_edits': []}
        await review_candidate(c, reviewer)
        project['candidates'].append(c)
    if not project['candidates']:
        raise ValueError('No clip-worthy moments')
    progress('Saving source video and editor preview…')
    destination = os.path.join(output_dir, 'editor-source.mp4')
    # A real copy also isolates local inputs from later changes to the original file.
    await asyncio.to_thread(shutil.copyfile, download.video_path, destination)
    os.chmod(destination, 0o600)
    await renderer.capture_framing_source(destination, os.path.join(output_dir, 'editor-preview.mp4'))
    atomic_json(Path(output_dir) / 'editor-project.json', project)
    return project


def atomic_json(path, value):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf8', dir=path.parent, prefix='.editor-', suffix='.tmp', delete=False) as f:
            temp = f.name
            json.dump(value, f, ensure_ascii=False, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp, path)
    finally:
        if temp and os.path.exists(temp):
            os.unlink(temp)


def local_file(run, name):
    path = run / name
    if path.is_symlink() or not path.is_file() or path.resolve().parent != run:
        raise ValueError('Editor file is unavailable')
    return path


def read_json(run, name, limit=32 * 1024 * 1024):
    path = local_file(run, name)
    with path.open('rb') as f:
        data = f.read(limit + 1)
    if len(data) > limit:
        raise ValueError('Editor file is too large')
    return json.loads(data)


def validate_candidate(c, duration, transcript_count=100000):
    def number(n, lo, hi):
        return type(n) in (float, int) and math.isfinite(n) and lo <= n <= hi
    if not isinstance(c.get('title'), str) or not 1 <= len(c['title']) <= 200:
        raise ValueError('Invalid title')
    ranges = c['ranges']
    if not 1 <= len(ranges) <= 24:
        raise ValueError('Invalid cuts')
    previous = 0
    for a, b in ranges:
        if not number(a, previous, duration) or not number(b, a + 100, duration):
            raise ValueError('Invalid cut interval')
        previous = b
    if not 1 <= len(c['scenes']) <= 60 or c['scenes'][0]['at_ms'] != 0:
        raise ValueError('Invalid layouts')
    previous = -1
    for i, s in enumerate(c['scenes']):
        if not number(s['at_ms'], previous + .001, duration) or s['layout'] not in ('fill', 'split', 'fit'):
            raise ValueError('Invalid layout')
        previous = s['at_ms']
        transition = s.get('transition_ms', 0)
        if not number(transition, 0, 5000) or (transition and (transition < 100 or transition != int(transition)
                or i == 0 or s['layout'] == 'fit' or c['scenes'][i - 1]['layout'] != s['layout'])):
            raise ValueError('Invalid layout movement')
        if len(s['crops']) != (2 if s['layout'] == 'split' else 1):
            raise ValueError('Invalid crops')
        for x, y, w, h in s['crops']:
            if not all(number(n, 0, 1) for n in (x, y, w, h)) or min(w, h) < .01 or x + w > 1.000001 or y + h > 1.000001:
                raise ValueError('Invalid crop')
    if not number(c['video_speed'], 1, 2) or type(c['captions']) is not bool:
        raise ValueError('Invalid export settings')
    if c.get('status', 'refining') not in ('refining', 'ready', 'baked', 'discarded'):
        raise ValueError('Invalid clip status')
    edits = c.get('caption_edits', [])
    if not isinstance(edits, list) or len(edits) > 2000:
        raise ValueError('Invalid caption edits')
    seen = set()
    for edit in edits:
        if not isinstance(edit, dict):
            raise ValueError('Invalid caption edit')
        index, text = edit.get('segment'), edit.get('text')
        if type(index) is not int or not 0 <= index < transcript_count or index in seen or not isinstance(text, str) or len(text) > 2000:
            raise ValueError('Invalid caption edit')
        if any(ord(char) < 32 and char not in '\t\n\r' for char in text):
            raise ValueError('Invalid caption text')
        seen.add(index)


def caption_transcript(transcript, edits):
    """A per-clip copy for rendering; original evidence and word timing stay intact.

    Corrections with the same word count retain the original word timestamps.
    Added/removed words are spread over the original line's spoken interval.
    """
    overrides = {edit['segment']: edit['text'] for edit in edits}
    result = []
    for index, segment in enumerate(transcript):
        if index not in overrides:
            result.append(replace(segment, words=[replace(w) for w in segment.words]))
            continue
        text = ' '.join(overrides[index].split())
        tokens = text.split()
        if not tokens:
            continue  # An empty correction hides this caption without cutting audio.
        if segment.words and len(tokens) == len(segment.words):
            words = [replace(word, word=text) for word, text in zip(segment.words, tokens)]
        else:
            start = segment.words[0].start_time_ms if segment.words else segment.start_time_ms
            end = segment.words[-1].end_time_ms if segment.words else segment.end_time_ms
            span = max(1, end - start)
            words = [TranscriptWord(word, round(start + i * span / len(tokens)), round(start + (i + 1) * span / len(tokens))) for i, word in enumerate(tokens)]
        result.append(replace(segment, text=text, words=words))
    return result


def scene_motion(c):
    """Resolve incoming crops before trimming the source window or skipping cuts."""
    previous = None
    origin = None
    for scene in c['scenes']:
        duration = scene.get('transition_ms', 0)
        if duration and previous and previous['layout'] == scene['layout'] and scene['layout'] != 'fit':
            p = min(1, (scene['at_ms'] - previous['at_ms']) / previous['transition_ms']) if previous.get('transition_ms') else 1
            ease = p * p * (3 - 2 * p)
            origin = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(origin, previous['crops'])]
        else:
            origin = scene['crops']
        yield scene, origin
        previous = scene


def manual_plan(project, c):
    a, b = c['ranges'][0][0], c['ranges'][-1][1]
    shots = []
    for i, (scene, origin) in enumerate(scene_motion(c)):
        start, end = max(a, scene['at_ms']), min(b, c['scenes'][i + 1]['at_ms'] if i + 1 < len(c['scenes']) else b)
        if start >= end:
            continue
        layout = {'split': LayoutType.TWO_SHOT, 'fit': LayoutType.SCREEN, 'fill': LayoutType.TALKING_HEAD}[scene['layout']]
        crops = [] if scene['layout'] == 'fit' else scene['crops']
        duration = scene.get('transition_ms', 0)
        motion_end = min(end, scene['at_ms'] + duration)
        if duration and start < motion_end:
            shots.append(ShotLayout(start - a, motion_end - a, layout, source='manual', manual_crops=crops,
                manual_from_crops=origin, manual_transition_start_ms=scene['at_ms'] - a, manual_transition_ms=duration))
            start = motion_end
        if start < end:
            shots.append(ShotLayout(start - a, end - a, layout, source='manual', manual_crops=crops))
    return ClipLayoutPlan(shots, project['width'], project['height'])


async def run_editor(config):
    from clip_engine.config import get_settings, get_caption_preset
    from clip_engine.services.editorial_vision import EditorialVision
    settings = get_settings()
    raw_run = Path(config['run'])
    run = raw_run.resolve(strict=True)
    if raw_run.is_symlink() or ('library' in config and run.parent != Path(config['library']).resolve(strict=True)):
        raise ValueError('Editor project is outside the library')
    project = read_json(run, 'editor-project.json')
    if project['version'] != 1 or project['revision'] != config['revision']:
        raise ValueError('The editor project changed. Reopen it and retry.')
    c = next(c for c in project['candidates'] if c['id'] == config['candidate_id'])
    validate_candidate(c, project['duration_ms'], len(project['transcript']))
    source = str(local_file(run, 'editor-source.mp4'))
    rows = read_json(run, 'transcript.json')['segments']
    def timing(item):
        return {**item, 'start_time_ms': round(item['start_time_ms']), 'end_time_ms': round(item['end_time_ms'])}
    transcript = [TranscriptSegment(**{**timing(s), 'words': [TranscriptWord(**timing(w)) for w in s.get('words', [])]}) for s in rows]
    action = config['action']
    if action == 'review':
        reviewer = CoherenceReviewer(JevService.from_settings(settings), settings, transcript, project['duration_ms'])
        context = run / 'source_context.json'
        if context.exists():
            from clip_engine.services.source_context import context_for_prompt
            # Read the same bounded brief used in discovery; no new web research.
            reviewer.source_context = context_for_prompt(read_json(run, 'source_context.json'))
        with tempfile.TemporaryDirectory(prefix='.editor-review-', dir=run) as work:
            vision = EditorialVision(settings, source, work, project['duration_ms'])
            reviewer.visual_observer = vision.observe if settings.jev_visual_context else None
            await review_candidate(c, reviewer)
    elif action == 'export':
        if c.get('status', 'refining') != 'ready':
            raise ValueError('Mark this clip ready before baking it')
        if any(edit['segment'] >= len(transcript) for edit in c.get('caption_edits', [])):
            raise ValueError('Caption source changed')
        render_transcript = caption_transcript(transcript, c.get('caption_edits', []))
        output = read_json(run, 'job_output.json')
        index = max((x['clip_index'] for x in output['clips']), default=-1) + 1
        while (run / f'clip_{index:02d}.mp4').exists() or (run / f'clip_{index:02d}.mp4').is_symlink():
            index += 1
        if index > 999:
            raise ValueError('Too many exports in this project')
        renderer = RenderingService()
        a, b = c['ranges'][0][0], c['ranges'][-1][1]
        path = run / f'clip_{index:02d}.mp4'
        if path.exists() or path.is_symlink():
            raise ValueError('Export file already exists')
        # Commit complete renders only; failed/cancelled exports do not change the library.
        with tempfile.TemporaryDirectory(prefix='.editor-export-', dir=run) as work:
            result = await renderer.render_clip(RenderRequest(video_path=source, output_path=str(Path(work) / 'clip.mp4'),
                start_time_ms=a, end_time_ms=b, source_width=project['width'], source_height=project['height'],
                transcript_segments=render_transcript, include_captions=c['captions'], caption_style=get_caption_preset(c['caption_preset']),
                apply_padding=False, aspect_ratio=project['aspect_ratio'], pacing='natural', video_speed=c['video_speed'],
                manual_ranges_ms=[tuple(interval) for interval in c['ranges']], manual_plan=manual_plan(project, c)))
            os.replace(result.output_path, path)
        output['clips'].append({'clip_index': index, 's3_url': str(path), 'duration_ms': result.duration_ms,
            'start_time_ms': a, 'end_time_ms': b, 'virality_score': c['score'], 'layout_type': result.layout_type,
            'summary': c['title'], 'tags': [], 'render_fallback': None})
        output['total_clips'] = len(output['clips'])
        atomic_json(run / 'job_output.json', output)
        c['exports'].append(index)
        c['status'] = 'baked'
    else:
        raise ValueError('Unknown editor action')
    project['revision'] += 1
    atomic_json(run / 'editor-project.json', project)
