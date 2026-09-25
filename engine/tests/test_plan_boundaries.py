"""
Offline tests for clip boundaries: duration bounds shared by router, prompt
and parser, sentence snapping under 0.1 s display rounding, backward snapping
of over-long clips, time-range clamping after snapping, and empty plans.
No network calls.
"""

import asyncio
import json
from types import SimpleNamespace

import pytest

from clip_engine.config import Settings, resolve_clip_duration_bounds
from clip_engine.services import ai_clipping_pipeline as pipeline_module
from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, ClippingJobRequest, JobStatus
from clip_engine.services.intelligence_planner import IntelligencePlannerService
from clip_engine.services.rendering_service import RenderingService
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptWord,
    TranscriptionResult,
    find_sentence_end_boundary,
    last_sentence_end_between,
)


def make_transcript(n_sentences=120, words_per=12, word_ms=300, gap_ms=80, pause_ms=400):
    """Sentences of `words_per` words with odd-ms timings; each ends with '.'."""
    segments = []
    t = 1000
    for s in range(n_sentences):
        words = []
        for w in range(words_per):
            text = f"w{s}_{w}" + ("." if w == words_per - 1 else "")
            words.append(TranscriptWord(text, t, t + word_ms))
            t += word_ms + gap_ms
        t += pause_ms
        segments.append(TranscriptSegment(
            words[0].start_time_ms, words[-1].end_time_ms,
            " ".join(x.word for x in words), "S1", words,
        ))
    return segments


def completion(clips):
    content = json.dumps({"insights": "x", "clips": clips})
    return {"choices": [{"message": {"content": content}, "finish_reason": "stop"}]}


def clip(start, end):
    return {
        "start_time": start, "end_time": end, "summary": "Title", "tags": [], "emphasis": [],
        "scores": {k: 5 for k in ("hook", "standalone", "arc", "quotability", "ending")},
    }


def make_planner(transcript, min_d=None, max_d=None, ranges=None, start_limit=None, end_limit=None):
    planner = IntelligencePlannerService()
    planner.settings = Settings(_env_file=None, openrouter_api_key="test")
    planner._current_min_duration = min_d
    planner._current_max_duration = max_d
    planner._current_duration_ranges = ranges
    planner._current_transcript = transcript
    planner._start_time_seconds = start_limit
    planner._end_time_seconds = end_limit
    planner._current_target_platform = "tiktok"
    return planner


def shown(ms):
    """A time as the planner sees it in the transcript (0.1 s precision)."""
    return round(ms / 1000, 1)


def sentence_ends(transcript):
    return {s.words[-1].end_time_ms for s in transcript}


class TestDurationBounds:
    def test_ranges_win_over_explicit_bounds(self):
        # BridgeClip used to leave the 15/90 defaults next to its ranges.
        assert resolve_clip_duration_bounds(["long"], 15, 90) == (120, 300)

    def test_multiple_ranges_span_their_union(self):
        assert resolve_clip_duration_bounds(["short", "long"]) == (30, 300)

    def test_explicit_then_default(self):
        assert resolve_clip_duration_bounds(None, 20, 45) == (20, 45)
        assert resolve_clip_duration_bounds(["bogus"]) == (15, 90)
        assert resolve_clip_duration_bounds() == (15, 90)

    def test_min_alone_leaves_room_above_it(self):
        # Used to give (100, 100): every clip forced to exactly 100 s, mid-sentence.
        assert resolve_clip_duration_bounds(None, 100, None) == (100, 200)
        assert resolve_clip_duration_bounds(None, 20, None) == (20, 90)

    def test_prompt_has_no_contradictory_bounds(self):
        planner = make_planner([])
        prompt = planner._build_system_prompt(5, 15, 90, ["long"])
        assert "Preferred length: 120–300 seconds" in prompt
        assert "Never pad, hard-truncate" in prompt
        assert "Return exactly" not in prompt


class TestParseBoundaries:
    def test_short_complete_candidate_is_not_padded(self):
        tr = make_transcript(5)
        segment = make_planner(tr, 30, 60)._parse_clip_plan_response(completion([clip(shown(tr[0].start_time_ms), shown(tr[0].end_time_ms))])).segments[0]
        assert segment.end_time_ms == tr[0].end_time_ms

    def test_overlong_candidate_is_not_truncated(self):
        tr = make_transcript()
        segment = make_planner(tr, 15, 60)._parse_clip_plan_response(completion([clip(shown(tr[0].start_time_ms), shown(tr[30].end_time_ms))])).segments[0]
        assert segment.end_time_ms == tr[30].end_time_ms

    def test_rounding_is_resolved_to_the_original_sentence_edges(self):
        tr = make_transcript()
        planner = make_planner(tr, 15, 90)
        for i in range(20, 60):
            segment = planner._parse_clip_plan_response(completion([clip(shown(tr[i-5].start_time_ms), shown(tr[i].end_time_ms))])).segments[0]
            assert segment.start_time_ms == tr[i-5].start_time_ms
            assert segment.end_time_ms == tr[i].end_time_ms

    def test_preferred_range_does_not_remove_setup_or_payoff(self):
        tr = make_transcript()
        a, b = tr[10].start_time_ms, tr[30].end_time_ms
        segment = make_planner(tr, 15, 60, start_limit=a/1000 + 10, end_limit=b/1000 - 10)._parse_clip_plan_response(completion([clip(a/1000, b/1000)])).segments[0]
        assert (segment.start_time_ms, segment.end_time_ms) == (a, b)

    def test_partial_sentence_expands_outward(self):
        tr = make_transcript()
        segment = make_planner(tr)._parse_clip_plan_response(completion([clip(tr[10].start_time_ms/1000 + 1, tr[15].end_time_ms/1000 - 1)])).segments[0]
        assert (segment.start_time_ms, segment.end_time_ms) == (tr[10].start_time_ms, tr[15].end_time_ms)

    def test_source_bounds_and_malformed_timestamps_are_rejected(self):
        planner = make_planner(make_transcript(10))
        planner._current_video_duration = 50
        assert planner._parse_clip_plan_response(completion([clip(-1, 10), clip(1, 60), clip(float('nan'), 20), clip(True, 20)])).segments == []

    def test_empty_clip_list_is_preserved(self):
        assert make_planner(make_transcript())._parse_clip_plan_response(completion([])).segments == []


class TestSentenceHelpers:
    def test_nearest_end_within_tolerance_wins(self):
        tr = make_transcript(5)
        end = tr[1].end_time_ms
        assert find_sentence_end_boundary(tr, end + 40) == end   # rounded up
        assert find_sentence_end_boundary(tr, end - 40) == end   # rounded down

    def test_last_sentence_end_between(self):
        tr = make_transcript(5)
        ends = sorted(sentence_ends(tr))
        assert last_sentence_end_between(tr, ends[0], ends[2] + 100) == ends[2]
        assert last_sentence_end_between(tr, ends[2] + 1, ends[3] - 1) is None


class TestEmptyPlan:
    def test_no_speech_fails_with_clear_message(self, monkeypatch, tmp_path):
        monkeypatch.setattr(RenderingService, "_verify_ffmpeg", lambda self: None)
        settings = pipeline_module.get_settings()
        monkeypatch.setattr(settings, "local_mode", True)
        monkeypatch.setattr(settings, "local_output_dir", str(tmp_path / "out"))
        monkeypatch.setattr(type(settings), "temp_directory", property(lambda self: str(tmp_path / "work")))
        pipeline = AIClippingPipeline()
        pipeline.local_mode = True

        async def download(url, output_dir):
            meta = SimpleNamespace(title="T", duration_seconds=300.0, width=1920, height=1080)
            return SimpleNamespace(video_path="x.mp4", metadata=meta, file_size_bytes=1)

        async def transcribe(video_path, work_dir, keyterms=None, **_range):
            return TranscriptionResult(segments=[], full_text="")  # silent demo / music-only

        monkeypatch.setattr(pipeline.video_downloader, "download_video", download)
        monkeypatch.setattr(pipeline.transcription_service, "transcribe", transcribe)
        result = asyncio.run(pipeline.process_video(ClippingJobRequest(video_url="x", job_id="j1")))
        assert result.status == JobStatus.FAILED
        assert "No clips passed the coherence review" in result.error

    def test_short_preference_keeps_full_transcript_and_can_extend(self, monkeypatch):
        tr = make_transcript(10)
        planner = make_planner(tr)
        async def complete(**kwargs):
            text = str(kwargs['messages'])
            assert tr[0].text in text and tr[-1].text in text
            assert 'Preferred discovery range' in text
            return completion([clip(tr[0].start_time_ms/1000, tr[-1].end_time_ms/1000)]), {'prompt_tokens': 1, 'completion_tokens': 1, 'total_tokens': 2, 'cost': 0}
        monkeypatch.setattr(planner, '_call_openrouter', complete)
        result = asyncio.run(planner.plan_clips(TranscriptionResult(segments=tr, full_text=''), duration_ranges=['short'],
            start_time_seconds=10, end_time_seconds=15))
        assert len(result.segments) == 1
        assert result.segments[0].start_time_ms < 10000 and result.segments[0].end_time_ms > 15000
