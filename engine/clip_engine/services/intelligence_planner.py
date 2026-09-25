"""
Intelligence Planner Service - Uses a frontier LLM via OpenRouter to plan viral clips.

The model, its fallbacks and its reasoning effort come from settings
(PLANNER_MODEL, PLANNER_FALLBACK_MODELS, PLANNER_REASONING_EFFORT) so models
can be swapped per deployment without a code change.
"""

import asyncio
import base64
import copy
import json
import logging
import math
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, Optional

import httpx

from clip_engine.config import DURATION_RANGES, get_settings, is_longform, resolve_clip_duration_bounds
from clip_engine.services.editorial_evidence import parse_moment, overlaps
from clip_engine.services.openrouter import (
    OpenRouterError,
    apply_reasoning,
    chat_completion,
    json_schema_format,
    message_text,
)
from clip_engine.services.transcription_service import (
    TranscriptSegment,
    TranscriptionResult,
    find_sentence_end_boundary,
    find_sentence_start_boundary,
    last_sentence_end_between,
    next_start_at_or_after,
)

logger = logging.getLogger(__name__)


@dataclass
class ClipPlanSegment:
    """A planned clip segment with timing and metadata."""

    start_time_ms: int
    end_time_ms: int
    virality_score: float
    layout_type: str = "center_crop"
    summary: Optional[str] = None
    tags: list[str] = field(default_factory=list)
    # Punch words to highlight in captions, as spoken in the clip.
    emphasis_words: list[str] = field(default_factory=list)
    # Filled in after rendering, like layout_type (see RenderResult.render_fallback).
    render_fallback: Optional[str] = None
    # Longform only (source ms): tangents cut out of the clip, chapter starts
    # as (ms, title), and a description for the upload.
    skip_ranges_ms: list[tuple[int, int]] = field(default_factory=list)
    chapters: list[tuple[int, str]] = field(default_factory=list)
    description: Optional[str] = None
    # Filled in after rendering: chapters as (output ms, title) on the edited
    # timeline, and the SRT sidecar path.
    output_chapters: list[tuple[int, str]] = field(default_factory=list)
    subtitle_path: Optional[str] = None
    editorial: Optional[dict] = None
    moment: Optional[dict] = None


@dataclass
class PlanningApiCosts:
    """Cost tracking for OpenRouter API calls during clip planning."""

    provider: str = "openrouter"
    model: str = ""
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    estimated_cost_usd: float = 0.0
    attempts: int = 0
    cost_incomplete: bool = False


# OpenRouter reports the billed cost of every request in `usage.cost`, which
# is what we record. This per-token table is only used if that field is
# missing, so it only needs to be roughly right.
MODEL_PRICING: dict[str, dict[str, float]] = {
    "anthropic/claude-opus-5.5": {"input": 4.00e-6, "output": 20.0e-6},
    "z-ai/glm-5.3-flash": {"input": 0.075e-6, "output": 0.25e-6},
    "google/gemini-3.8-flash": {"input": 0.75e-6, "output": 3.75e-6},
    "openai/gpt-6-sol": {"input": 2.00e-6, "output": 10.0e-6},
}

# Conservative fallback when model is unknown
DEFAULT_PRICING = {"input": 2.00e-6, "output": 12.0e-6}

# The five rubric dimensions the model scores each clip on (0-10 each).
# virality_score is computed from these rather than trusting model arithmetic.
RUBRIC_DIMENSIONS = ("hook", "standalone", "arc", "quotability", "ending")

MOMENT_SCHEMA = {'type': 'object', 'properties': {
    'topic': {'type': 'string', 'description': 'One specific topic of this moment, not a summary of the whole video.'},
    'topic_start_segment': {'type': 'integer'}, 'topic_end_segment': {'type': 'integer'},
    'setup_segment': {'type': 'integer', 'description': 'The source line introducing essential context.'},
    'payoff_segment': {'type': 'integer', 'description': 'The source line completing the idea or reaction.'},
    'requires_visual_context': {'type': 'boolean'}},
    'required': ['topic', 'topic_start_segment', 'topic_end_segment', 'setup_segment', 'payoff_segment', 'requires_visual_context'],
    'additionalProperties': False}

CLIP_PLAN_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "insights": {
            "type": "string",
            "description": "Content type classification plus a brief analysis of the video's themes and why these clips were chosen.",
        },
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "moment": MOMENT_SCHEMA,
                    "start_time": {"type": "number", "description": "Clip start, seconds from the start of the video."},
                    "end_time": {"type": "number", "description": "Clip end, seconds from the start of the video."},
                    "summary": {"type": "string", "description": "2-7 word on-screen title."},
                    "scores": {
                        "type": "object",
                        "properties": {
                            dim: {"type": "number", "description": "0-10"} for dim in RUBRIC_DIMENSIONS
                        },
                        "required": list(RUBRIC_DIMENSIONS),
                        "additionalProperties": False,
                    },
                    "tags": {"type": "array", "items": {"type": "string"}},
                    "emphasis": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "2-5 single punch words spoken in the clip, highlighted in captions.",
                    },
                },
                "required": ["moment", "start_time", "end_time", "summary", "scores", "tags", "emphasis"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["insights", "clips"],
    "additionalProperties": False,
}

_TIME_RANGE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "start_time": {"type": "number", "description": "Seconds from the start of the video."},
        "end_time": {"type": "number", "description": "Seconds from the start of the video."},
    },
    "required": ["start_time", "end_time"],
    "additionalProperties": False,
}

_CHAPTER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "time": {"type": "number", "description": "Chapter start, seconds from the start of the video."},
        "title": {"type": "string", "description": "2-6 word chapter title."},
    },
    "required": ["time", "title"],
    "additionalProperties": False,
}


def clip_plan_schema(longform: bool) -> dict[str, Any]:
    """Planner output schema; longform clips also carry skips, chapters and a description."""
    if not longform:
        return CLIP_PLAN_SCHEMA
    schema = copy.deepcopy(CLIP_PLAN_SCHEMA)
    item = schema["properties"]["clips"]["items"]
    item["properties"].update({
        "skip": {
            "type": "array",
            "items": _TIME_RANGE_SCHEMA,
            "description": "Tangents or dead stretches inside the clip to cut out (may be empty).",
        },
        "chapters": {
            "type": "array",
            "items": _CHAPTER_SCHEMA,
            "description": "Chapter starts inside the clip, the first at the clip start.",
        },
        "description": {"type": "string", "description": "2-4 sentence upload description."},
    })
    item["required"] = [*item["required"], "skip", "chapters", "description"]
    return schema


# Two clips may share at most this much footage before the weaker one is dropped.
MAX_CLIP_OVERLAP_MS = 5000

# Longform skips: shorter than this is pacing's job, not a content cut.
MIN_SKIP_MS = 8000
# A skip never removes more than this share of the clip's footage.
MAX_SKIP_SHARE = 0.4
# Chapters closer together than this are merged (YouTube needs 10 s minimum).
MIN_CHAPTER_GAP_MS = 20000


@dataclass
class ClipPlanResponse:
    """Response from clip planning."""
    
    segments: list[ClipPlanSegment]  # Renamed from clips to match pipeline expectation
    total_clips: int = 0
    target_platform: str = "tiktok"
    insights: Optional[str] = None
    api_costs: Optional[PlanningApiCosts] = None


@dataclass
class VisionFrame:
    """A video frame for vision analysis."""
    
    timestamp_ms: int
    file_path: str
    width: int
    height: int


class IntelligencePlannerService:
    """
    Service for planning viral clips with a frontier LLM via OpenRouter.

    Features:
    - Reads the full timestamped transcript (with speaker turns and audio
      events) and optional vision frames
    - Strict JSON-schema output with per-dimension rubric scores
    - Automatic model failover through OpenRouter's `models` routing
    - Retries on rate limits, provider outages and malformed output
    - Automatic clip count scaling based on video duration
    """

    def __init__(self):
        self.settings = get_settings()
        self._http_client: Optional[httpx.AsyncClient] = None
        
        if not self.settings.openrouter_api_key:
            logger.warning("OPENROUTER_API_KEY not set, intelligence planning will fail")

    def calculate_optimal_clip_count(
        self,
        video_duration_seconds: float,
        user_max_clips: Optional[int],
        auto_clip_count: bool = True,
        words_per_minute: Optional[float] = None,
    ) -> int:
        """
        Calculate optimal clip count based on video duration.
        
        Uses a scaled approach: longer videos get more clips, but with diminishing
        returns to prevent excessive clips on very long videos.
        
        Args:
            video_duration_seconds: Total video duration in seconds
            user_max_clips: User-requested maximum clips (upper bound). None = use config max_clips_absolute
            auto_clip_count: If True, auto-scale based on duration. If False, use user's max_clips directly.
            
        Returns:
            Optimal number of clips to generate
        """
        # Use config's max_clips_absolute as default when user_max_clips is None
        effective_max = user_max_clips if user_max_clips is not None else self.settings.max_clips_absolute
        
        if not auto_clip_count or not self.settings.clip_scaling_enabled:
            # Auto-scaling disabled by request or config, use user's requested count directly
            final_clips = min(effective_max, self.settings.max_clips_absolute)
            logger.info(
                f"Clip count (auto-scaling OFF): using max {effective_max} -> final: {final_clips}"
            )
            return final_clips
        
        video_duration_minutes = max(0.0, video_duration_seconds / 60.0)

        min_clips = self.settings.min_clips
        max_auto_clips = min(
            self.settings.max_suggested_clips,
            self.settings.max_clips_absolute,
        )
        tau_minutes = self.settings.clip_count_tau_minutes

        # Smooth saturation curve: grows quickly early, flattens for long videos.
        if tau_minutes <= 0:
            base_clips = min_clips
        else:
            growth = 1.0 - math.exp(-video_duration_minutes / tau_minutes)
            base_clips = min_clips + (max_auto_clips - min_clips) * growth

        base_clips = max(min_clips, int(round(base_clips)))

        # Transcript density multiplier (words per minute).
        density_factor = 1.0
        if words_per_minute and words_per_minute > 0:
            target_wpm = self.settings.transcript_density_target_wpm
            raw_factor = words_per_minute / max(1.0, target_wpm)
            density_factor = max(
                self.settings.transcript_density_min_factor,
                min(raw_factor, self.settings.transcript_density_max_factor),
            )

        adjusted_clips = int(round(base_clips * density_factor))
        adjusted_clips = min(adjusted_clips, max_auto_clips)

        # Don't exceed user's requested maximum (if provided)
        final_clips = min(adjusted_clips, effective_max, self.settings.max_clips_absolute)
        final_clips = max(final_clips, min_clips)

        logger.info(
            "Clip count scaling: "
            f"{video_duration_minutes:.1f} min video -> base {base_clips} clips "
            f"(tau: {tau_minutes}, min: {min_clips}, max_auto: {max_auto_clips}), "
            f"density_factor: {density_factor:.2f}, "
            f"effective max: {effective_max}, final: {final_clips}"
        )

        return final_clips

    def _count_transcript_words(self, transcript: list[TranscriptSegment]) -> int:
        """Count words in transcript segments for density calculation."""
        word_count = 0
        for seg in transcript:
            if not seg.text:
                continue
            word_count += len(re.findall(r"\b\w+\b", seg.text))
        return word_count

    def _resolve_effective_duration_seconds(
        self,
        start_time_seconds: Optional[float],
        end_time_seconds: Optional[float],
        video_metadata: Any,
        transcript: list[TranscriptSegment],
    ) -> tuple[float, str]:
        """Determine effective duration for scaling with a source label."""
        if start_time_seconds is not None or end_time_seconds is not None:
            start = max(0.0, start_time_seconds or 0.0)
            end = end_time_seconds
            if end is None:
                metadata_duration = getattr(video_metadata, "duration_seconds", None)
                if metadata_duration is not None and metadata_duration > 0:
                    end = metadata_duration
                elif transcript:
                    end = transcript[-1].end_time_ms / 1000.0
                else:
                    end = start
            return max(0.0, float(end) - start), "time_range"

        metadata_duration = getattr(video_metadata, "duration_seconds", None)
        if metadata_duration is not None and metadata_duration > 0:
            return float(metadata_duration), "metadata"

        if transcript:
            first_segment_start = transcript[0].start_time_ms / 1000.0
            last_segment_end = transcript[-1].end_time_ms / 1000.0
            return max(0.0, last_segment_end - first_segment_start), "transcript"

        return 0.0, "fallback"

    async def _get_client(self) -> httpx.AsyncClient:
        """Get or create HTTP client."""
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                base_url=self.settings.openrouter_base_url,
                # Reasoning over a multi-hour transcript can take minutes.
                timeout=httpx.Timeout(600.0, connect=30.0),
                headers={
                    "Authorization": f"Bearer {self.settings.openrouter_api_key}",
                    "HTTP-Referer": "https://github.com/bridge-mind/bridgeclip",
                    "X-Title": "BridgeClip AI Clipping Agent",
                },
            )
        return self._http_client

    async def plan_clips(
        self,
        transcript_result: TranscriptionResult,
        video_metadata: Any = None,
        max_clips: int = 5,
        auto_clip_count: bool = True,
        min_duration_seconds: Optional[int] = None,
        max_duration_seconds: Optional[int] = None,
        duration_ranges: Optional[list[str]] = None,
        target_platform: str = "tiktok",
        frames: Optional[list[VisionFrame]] = None,
        start_time_seconds: Optional[float] = None,
        end_time_seconds: Optional[float] = None,
        aspect_ratio: str = "9:16",
        discovery_feedback: Optional[dict] = None,
    ) -> ClipPlanResponse:
        """
        Plan viral clips from video content.

        Args:
            transcript_result: TranscriptionResult from transcription service
            video_metadata: Optional video metadata
            max_clips: Maximum number of clips to generate
            auto_clip_count: If True, auto-scale clip count based on video duration
            min_duration_seconds: Minimum clip duration (ignored when duration_ranges is set)
            max_duration_seconds: Maximum clip duration (ignored when duration_ranges is set)
            duration_ranges: Optional list of selected duration ranges ('short', 'medium', 'long')
            target_platform: Target platform (tiktok, youtube_shorts, instagram_reels)
            frames: Optional sampled video frames for vision analysis
            start_time_seconds: Preferred discovery range start; complete clips may extend earlier
            end_time_seconds: Preferred discovery range end; complete clips may extend later
            aspect_ratio: Output aspect ratio; long 16:9 clips are planned as longform edits

        Returns:
            ClipPlanResponse with identified clips
        """
        transcript = transcript_result.segments if transcript_result else []
        frames = frames or []

        if not transcript and not frames:
            logger.warning("No transcript or frames provided for clip planning")
            return ClipPlanResponse(segments=[], total_clips=0, target_platform=target_platform, insights="No content provided for analysis")

        # The preferred range guides discovery, never transcript coverage or cuts.
        self._start_time_seconds = start_time_seconds
        self._end_time_seconds = end_time_seconds
        if discovery_feedback is None:
            self.audit = {'requests': []}
        self._discovery_feedback = discovery_feedback

        if not transcript and len(frames) < 3:
            return ClipPlanResponse(
                segments=[], total_clips=0, target_platform=target_platform,
                insights="Visual-only planning needs at least three sampled frames",
            )

        # Calculate effective duration for clip count scaling
        effective_duration_seconds, duration_source = self._resolve_effective_duration_seconds(
            start_time_seconds,
            end_time_seconds,
            video_metadata,
            transcript,
        )

        word_count = self._count_transcript_words(transcript) if transcript else 0
        words_per_minute = None
        if effective_duration_seconds > 0 and word_count > 0:
            words_per_minute = word_count / (effective_duration_seconds / 60.0)
        
        # Apply clip count scaling algorithm
        user_max_clips = max_clips or self.settings.max_suggested_clips
        clip_count = self.calculate_optimal_clip_count(
            effective_duration_seconds,
            user_max_clips,
            auto_clip_count=auto_clip_count,
            words_per_minute=words_per_minute,
        )

        wpm_label = f"{words_per_minute:.1f}" if words_per_minute is not None else "n/a"
        logger.info(
            f"Planning clips: {len(transcript)} transcript segments, "
            f"{len(frames)} frames, requesting {clip_count} clips (scaled from user max {user_max_clips}), "
            f"duration_source={duration_source}, duration_seconds={effective_duration_seconds:.1f}, "
            f"words_per_minute={wpm_label} "
            f"duration_ranges={duration_ranges}"
        )

        # One set of bounds for the prompt, the parser and the end-snap cap.
        min_duration_seconds, max_duration_seconds = resolve_clip_duration_bounds(
            duration_ranges, min_duration_seconds, max_duration_seconds,
        )
        logger.info(f"Clip duration bounds: {min_duration_seconds}-{max_duration_seconds}s")

        # Clips can't overlap, so the range only fits so many of the minimum
        # length. Asking for more forces the model to pad or overlap.
        if effective_duration_seconds > 0:
            max_fit = max(1, int(effective_duration_seconds // min_duration_seconds))
            if clip_count > max_fit:
                logger.info(
                    f"Clip count capped {clip_count} -> {max_fit}: "
                    f"{effective_duration_seconds:.0f}s fits at most {max_fit} clips of {min_duration_seconds}s+"
                )
                clip_count = max_fit
        if discovery_feedback is not None:
            clip_count = min(clip_count, 8)
        self.discovery_limit = clip_count
        longform = bool(transcript) and is_longform(aspect_ratio, min_duration_seconds)
        self._current_longform = longform
        if longform:
            logger.info("Planning longform edits (16:9, 5+ minute clips)")

        self._current_target_platform = target_platform
        self._current_min_duration = min_duration_seconds
        self._current_max_duration = max_duration_seconds
        self._current_duration_ranges = duration_ranges
        self._current_transcript = transcript
        metadata_duration = getattr(video_metadata, "duration_seconds", None)
        self._current_video_duration = float(metadata_duration) if metadata_duration is not None else None
        
        # Build prompts
        system_prompt = (
            self._build_longform_system_prompt(clip_count, min_duration_seconds, max_duration_seconds)
            if longform else
            self._build_system_prompt(clip_count, min_duration_seconds, max_duration_seconds, duration_ranges)
            if transcript else
            self._build_visual_only_system_prompt(clip_count, min_duration_seconds, max_duration_seconds, duration_ranges)
        )
        system_prompt += (
            f'\nPreferred discovery range: {start_time_seconds if start_time_seconds is not None else "source start"}'
            f' to {end_time_seconds if end_time_seconds is not None else "source end"} seconds. '
            'Prioritize ideas around this range but extend either boundary to preserve meaning. '
            'Length and clip count are preferences, never quotas. Return no clips rather than force one.'
            ' Exclude sponsor reads, paid promotions, affiliate pitches and advertising segments entirely, '
            'even if they teach something useful or their sponsor disclosure is outside the proposed excerpt. '
            'Ordinary independent product discussion is allowed; use the surrounding narrative to distinguish it from advertising.'
        )
        if transcript:
            system_prompt += (
                '\nMOMENT DISCOVERY AND BOUNDARIES: First identify distinct topic episodes in the source. '
                'For each promising moment, populate moment with a concise topic, the topic_start_segment and topic_end_segment IDs, '
                'then the setup_segment and payoff_segment IDs within that topic. These must refer to the numbered transcript lines. '
                'Build the excerpt around both anchors, including qualifications and the host reaction to watched footage. '
                'If an opening refers to an earlier example (such as "the reason I gave you this example is because"), '
                'include the actual example and its setup, not just the later explanation of why it matters. '
                'The payoff must complete this specific idea, not merely be the last available line. '
                'Mark requires_visual_context when the point depends on something shown rather than described. '
                'Speaker labels distinguish voices within a transcription chunk; do not invent identities or merge quoted claims with the host. '
                'Overlapping alternative boundaries are allowed during discovery; selection happens after coherence review. '
                'Return an empty clips array if there is no complete supported moment.')
        if discovery_feedback is not None:
            system_prompt += ('\nSECOND AND FINAL DISCOVERY PASS: Search the listed underexplored intervals for different moments. '
                'The previous candidates have already been reviewed. Do not repeat or overlap them by more than 5 seconds. '
                'Use surrounding transcript only for needed setup/payoff. Never fill a quota. '
                + json.dumps(discovery_feedback))
        transcript_text = self._build_transcript_text(transcript)
        
        logger.info("Transcript text length: %s chars", len(transcript_text))
        
        frames_to_send = frames[:48]
        if self.settings.clipping_mode == "advanced" and not self.settings.planner_supports_images:
            if not transcript:
                raise VisualPlanningUnsupportedError("Selected planner requires a video with speech")
            frames_to_send = []
        frame_images = await self._load_frames_as_base64(frames_to_send)
        if not transcript and len(frame_images) < 3:
            return ClipPlanResponse(
                segments=[], total_clips=0, target_platform=target_platform,
                insights="Visual-only planning could not load enough sampled frames",
            )
        self._current_visual_frame_times = (
            sorted(frame["timestamp_ms"] / 1000 for frame in frame_images)
            if not transcript else []
        )
        if not transcript and not any(
            right - left <= 45
            for left, right in zip(self._current_visual_frame_times, self._current_visual_frame_times[1:])
        ):
            return ClipPlanResponse(
                segments=[], total_clips=0, target_platform=target_platform,
                insights="Sampled visual frames are too far apart to support a short clip",
            )
        
        logger.debug(
            f"Loaded {len(frame_images)} frames as base64 images for vision analysis"
        )
        
        # Build multimodal message
        messages = self._build_vision_messages(
            system_prompt,
            transcript_text,
            frame_images,
            clip_count,
            transcript,
            self._current_video_duration or effective_duration_seconds,
            longform,
        )
        
        model_name = self.settings.planner_model
        fallback_models = self.settings.get_planner_fallback_models()
        logger.info(
            f"Calling planner model {model_name} "
            f"(fallbacks: {fallback_models or 'none'}, "
            f"reasoning: {'model default' if self.settings.clipping_mode == 'advanced' else self.settings.planner_reasoning_effort}) for clip planning..."
        )

        max_attempts = 1 if discovery_feedback is not None else 3
        cumulative_prompt_tokens = 0
        cumulative_completion_tokens = 0
        cumulative_total_tokens = 0
        cumulative_cost = 0.0
        cost_reported = True
        cost_incomplete = False
        attempts_made = 0
        served_by = model_name

        for attempt in range(max_attempts):
            attempts_made += 1
            parameters = self._build_request_payload(model_name, fallback_models, messages)
            record = {'discovery_pass': 2 if discovery_feedback is not None else 1, 'model': model_name, 'requested_model': model_name,
                'request_parameters': json.dumps({k: v for k, v in parameters.items() if k != 'messages'}),
                'status': 'unavailable', 'messages': [
                {'role': m['role'], 'content': m['content'] if isinstance(m['content'], str) else [
                    item for item in m['content'] if item.get('type') == 'text']} for m in messages],
                'response': None, 'usage': None}
            self.audit['requests'].append(record)
            try:
                response, usage_data = await self._call_openrouter(
                    model=model_name,
                    fallback_models=fallback_models,
                    messages=messages,
                )
                served_by = response.get("model") or model_name
                record.update(model=served_by, status='received', response=message_text(response)[0], usage=usage_data)
                cumulative_prompt_tokens += usage_data["prompt_tokens"]
                cumulative_completion_tokens += usage_data["completion_tokens"]
                cumulative_total_tokens += usage_data["total_tokens"]
                if usage_data["cost"] is not None:
                    cumulative_cost += usage_data["cost"]
                else:
                    cost_reported = False
                    pricing = MODEL_PRICING.get(served_by, DEFAULT_PRICING)
                    if self.settings.clipping_mode == "advanced":
                        if self.settings.planner_input_price is not None and self.settings.planner_output_price is not None:
                            pricing = {"input": self.settings.planner_input_price, "output": self.settings.planner_output_price}
                        else:
                            pricing = None
                    if pricing is None:
                        cost_incomplete = True
                    else:
                        # Estimate only this response. Preserve reported charges
                        # from other attempts, including malformed responses.
                        cumulative_cost += (
                            usage_data["prompt_tokens"] * pricing["input"]
                            + usage_data["completion_tokens"] * pricing["output"]
                        )

                result = self._parse_clip_plan_response(response)
                record['status'] = 'parsed'
            except IntelligencePlanningError as e:
                if not e.retryable or attempt == max_attempts - 1:
                    logger.error(f"Clip planning failed after {attempts_made} attempt(s): {e}")
                    raise
                delay = 2 ** attempt
                logger.warning(
                    f"Clip planning attempt {attempts_made} failed ({e}); retrying in {delay}s..."
                )
                await asyncio.sleep(delay)
                continue

            if discovery_feedback is not None:
                result.segments = [c for c in result.segments
                    if any(overlaps([c.start_time_ms, c.end_time_ms], span) for span in discovery_feedback['search_intervals'])
                    and not any(overlaps([c.start_time_ms, c.end_time_ms], old['interval']) for old in discovery_feedback['previous_candidates'])]
            # Keep boundary alternatives until review; deduplicate only exact proposals here.
            result.segments = self._finalize_clips(result.segments, clip_count, allow_alternatives=bool(transcript))
            result.total_clips = len(result.segments)
            result.api_costs = PlanningApiCosts(
                provider="openrouter",
                model=served_by,
                prompt_tokens=cumulative_prompt_tokens,
                completion_tokens=cumulative_completion_tokens,
                total_tokens=cumulative_total_tokens,
                estimated_cost_usd=round(cumulative_cost, 6),
                attempts=attempts_made,
                cost_incomplete=cost_incomplete,
            )
            logger.info(
                f"Planning API cost: ${cumulative_cost:.6f} "
                f"({cumulative_total_tokens} tokens, {attempts_made} attempt(s), "
                f"model={served_by}, source={'openrouter' if cost_reported else 'estimate'})"
            )
            return result

    def _build_system_prompt(
        self,
        clip_count: int,
        min_duration: Optional[int] = None,
        max_duration: Optional[int] = None,
        duration_ranges: Optional[list[str]] = None,
    ) -> str:
        """Build the system prompt for the planner model."""
        min_duration, max_duration = resolve_clip_duration_bounds(duration_ranges, min_duration, max_duration)
        duration_guidance = f"Preferred length: {min_duration}–{max_duration} seconds. Completeness takes priority."

        return f"""## YOUR ROLE

You are a video editor selecting complete, faithful excerpts for short-form content (TikTok, Reels, Shorts). Establish context, a resolved central thought and a supported title before considering engagement scores. Never sacrifice meaning for a hook.

Before selecting clips, classify the video content type:
- Podcast/Interview: Prioritize quotable opinions, debate moments, surprising admissions, hot takes
- Tutorial/How-To: Prioritize "aha moment" reveals, before/after demonstrations, common-mistake warnings
- Vlog/Personal: Prioritize emotional peaks, story climaxes, humor, raw authenticity
- Presentation/Talk: Prioritize key insights, powerful analogies, audience-reaction moments
- Debate/Discussion: Prioritize clashes, counterarguments, concession moments

Include your content type classification in the "insights" field.

## TRANSCRIPT FORMAT

Each transcript line is `[start - end] (speaker) text (audio events)`, with times in seconds.
- Speaker labels (S1, S2, ...) mark who is talking. Back-and-forth exchanges, pushback, and one person reacting to another are strong clip material — but a clip must still make sense without knowing who the speakers are.
- Audio events such as (laughter) or (applause) are real reactions captured in the audio. They are strong evidence that a moment landed; weigh them heavily, and make sure the clip includes the setup that caused the reaction.

## EVALUATION RUBRIC

Score every clip you return on these 5 dimensions (each 0-10) in its "scores" object, using the keys hook, standalone, arc, quotability and ending. Be calibrated: reserve 8-10 for genuinely exceptional moments.

1. HOOK STRENGTH (0-10): Does the clip open with something that stops the scroll within the first 3 seconds? A clip that starts with dead air, "um", or a continuation scores 0-2. A clip that opens with a bold claim, shocking stat, or direct question scores 8-10.

2. STANDALONE CLARITY (0-10): Can a viewer understand this clip with ZERO context from the rest of the video? If the clip references "what I said earlier" or assumes knowledge from a previous segment, it scores 0-3. If it is a fully self-contained idea, it scores 8-10.

3. EMOTIONAL ARC (0-10): Does the clip contain a setup AND payoff within its duration? A build-up to a punchline, a problem to a solution, a question to an answer. A flat monotone segment with no arc scores 0-3. A complete mini-story scores 8-10.

4. QUOTABILITY (0-10): Does the clip contain a memorable, shareable statement — something a viewer would repeat, screenshot, or put in their bio? Generic advice scores 0-3. A punchy one-liner or hot take scores 8-10.

5. ENDING QUALITY (0-10): Does the clip end on a strong beat — a completed thought, a mic-drop moment, or a natural pause? Ending mid-sentence scores 0-2. Ending right after a powerful statement scores 8-10.

## HOOK TYPES TO LOOK FOR

Prioritize clips whose opening matches one of these proven hook patterns:
- Question hook: "Have you ever wondered why...?" / "What if I told you...?"
- Bold claim: "This is the biggest mistake most people make." / "Nobody talks about this."
- Contrarian take: "Everyone says X, but actually..." / "Hot take:"
- Number/stat: "I made $50K in 30 days doing this." / "97% of people get this wrong."
- Story opener: "So last week something crazy happened..." / "Let me tell you about the time..."
- Direct address: "If you're a developer, you need to hear this." / "Stop doing this right now."

## ANTI-PATTERNS — NEVER SELECT CLIPS THAT:

- Start mid-sentence or mid-thought. Always begin at the start of a sentence or idea.
- End mid-sentence without resolution. Always end on a completed thought or natural pause.
- Contain long pauses, "um"s, "uh"s, throat clearing, or stammering as the primary content.
- Require context from earlier in the video to make sense ("as I mentioned earlier", "going back to what we said").
- Are just transitions or filler ("okay so moving on...", "anyway let's talk about...", "so yeah").
- Contain the same core point as another selected clip. Each clip must cover a distinct idea.
- Feature the speaker trailing off, losing their train of thought, or being interrupted without resolution.

## CLIP DIVERSITY RULES

- SPREAD: Distribute clips across the full video timeline. Do not cluster multiple clips from the same section.
- BOUNDARY ALTERNATIVES: Distinct moments or alternative boundaries may overlap during discovery. Approval and final selection resolve overlaps.
- TOPIC VARIETY: If the video covers multiple topics, represent different topics across clips.
- TONE MIX: Prefer a mix of tones across the clip set — not all high-energy or all calm. Include variety.

## TITLE GUIDELINES

The "summary" field is the title displayed on screen. It must be 2-7 words.

Rules:
- State a specific idea actually established inside the retained excerpt.
- Do not invent scandal, causation, regret, certainty or a confession to make a title more exciting. Preserve the speaker's qualifications.
- A title cannot supply context or a conclusion missing from the spoken excerpt.
- NEVER use generic titles: "Great Advice", "Important Point", "Good Tip", "Interesting Thought"
- Each title across all clips must be unique — no repeated words or patterns
- Prefer an accurate plain title over a curiosity gap that overstates the evidence.

## CAPTION EMPHASIS

For each clip, list 2-5 single words, exactly as spoken inside the clip, that carry its punch: numbers and money ("$50K", "97%"), strong verbs, surprising nouns, names. They are highlighted in a contrasting color in the burned-in captions. Never pick articles, pronouns, filler, or words that are not spoken in that clip.

## OUTPUT FORMAT

Return at most {clip_count} clips as JSON; return fewer or none if no complete moments qualify:
{{
  "insights": "<content type classification + brief analysis of the video's key themes and why these clips were selected>",
  "clips": [
    {{
      "start_time": <number in seconds>,
      "end_time": <number in seconds>,
      "summary": "<2-7 word title>",
      "scores": {{"hook": <0-10>, "standalone": <0-10>, "arc": <0-10>, "quotability": <0-10>, "ending": <0-10>}},
      "tags": ["tag1", "tag2"],
      "emphasis": ["word1", "word2"]
    }}
  ]
}}
{duration_guidance}
## ACCEPTANCE RULES

- Duration targets are suggestions. Never pad, hard-truncate, or cut a thought to fit them.
- Return times in SECONDS, taken from complete transcript boundaries.
- Include the necessary setup, qualifications, and payoff in each excerpt.
- Prefer coherent ideas over hook scores. Return an empty clips array when necessary.
- Order candidates best first. Every candidate will undergo independent Jev review."""

    def _build_longform_system_prompt(
        self,
        clip_count: int,
        min_duration: int,
        max_duration: int,
    ) -> str:
        """System prompt for 16:9 longform edits (5+ minute YouTube-style episodes)."""
        return f"""## YOUR ROLE

You are a senior YouTube editor. From the transcript of a long video, cut up to {clip_count} standalone horizontal episodes of {min_duration // 60}-{max_duration // 60} minutes each ({min_duration}-{max_duration} seconds). Each episode is published on its own as a longform YouTube video, so it must hold a viewer from the first second to the last with no knowledge of the rest of the source.

Classify the source first (podcast/interview, tutorial, talk, vlog, debate, stream) and say so in "insights".

## TRANSCRIPT FORMAT

Each transcript line is `[start - end] (speaker) text (audio events)`, with times in seconds. Speaker labels (S1, S2, ...) mark turns. Audio events such as (laughter) or (applause) are real reactions and mark moments that landed.

## WHAT MAKES A GOOD EPISODE

- ONE COHERENT TOPIC OR STORY. Start where the topic is introduced and end where it is resolved. Follow topic boundaries, not arbitrary time slices.
- STRONG OPENING. The first 30 seconds must make the stakes or the question clear (a claim, a question, the start of a story). Never open on small talk, housekeeping, sponsor reads or "as I was saying".
- SUSTAINED INTEREST. Prefer stretches with a clear progression: setup, development, payoff. Several beats of insight or story, not one idea stretched thin.
- CLEAN ENDING. End on a conclusion, a takeaway or a punchline, at the end of a sentence. Never end mid-thought or on "anyway, moving on".
- DISTINCT EPISODES. Each covers a different topic. Episodes never overlap by more than 5 seconds.

## SKIPS (TIGHTENING THE EDIT)

Inside an episode you may list "skip" ranges to cut out: tangents that leave the topic, sponsor reads, technical problems, long off-topic banter, or repeated points. Rules:
- Each skip is at least 8 seconds long and lies strictly inside the episode.
- Start a skip right after a sentence ends and end it right before a sentence starts, so the jump is clean.
- Only skip what a viewer would not miss; the episode must still flow without it. Most episodes need zero to three skips. Never skip the setup of a later payoff.
- Skips together remove at most 40% of the episode.
- RUNTIME: Aim for {min_duration}-{max_duration} seconds; extend or shorten as necessary for a complete idea. Never pad or truncate to reach that target.
Do not list pauses or filler words; those are removed automatically.

## CHAPTERS

List 3-8 chapters per episode for the YouTube chapter list. The first chapter starts exactly at the episode's start_time. Chapters are at least 30 seconds apart, sit at real topic shifts, are not inside skips, and have 2-6 word titles.

## SCORES

Score each episode 0-10 on these keys (be calibrated; reserve 8-10 for exceptional material):
- hook: how well the first 30 seconds earn the next 10 minutes
- standalone: understandable with zero context from the rest of the source
- arc: a complete progression from setup to payoff
- quotability: density of insight, story or memorable moments across the whole runtime (retention)
- ending: how conclusive and satisfying the final beat is

## TITLES, DESCRIPTION, TAGS

- "summary": a 2-7 word YouTube title that promises exactly what the episode delivers. Curiosity is good; clickbait the episode doesn't pay off is not. Match the speaker's tone. Each title unique.
- "description": 2-4 plain sentences describing what the viewer will learn or see, for the upload description.
- "tags": 3-8 topical keywords.
- "emphasis": 2-5 single key words spoken in the episode (names, numbers, key terms).

## OUTPUT

Return JSON with "insights" and "clips" (up to {clip_count}, best first). Times are in SECONDS taken from the transcript timestamps. Start each clip at the beginning of a transcript line and end it at the end of one. Duration is a preference. Independent Jev review will reject incomplete or misleading edits."""

    def _build_visual_only_system_prompt(
        self,
        clip_count: int,
        min_duration: Optional[int],
        max_duration: Optional[int],
        duration_ranges: Optional[list[str]],
    ) -> str:
        """Ask for clips only when sampled video frames show a clear visual event."""
        minimum, maximum = resolve_clip_duration_bounds(duration_ranges, min_duration, max_duration)
        return f"""You are selecting short clips from a video with no usable speech transcript.
Use only the timestamped sample frames. Do not claim to know what was said, what audio played,
or what happened between frames. Select a clip only when visible evidence shows a distinct,
self-contained action, reveal, transformation, demonstration, or scene with a clear payoff.
Static slides, a still image, and visually ambiguous footage do not qualify. If the evidence
is too sparse, return an empty clips array. Never invent a spoken quote or caption words.

Return JSON with "insights" and "clips". Return at most {clip_count} clips. Aim for
{minimum} to {maximum} seconds, allowing complete ideas to run shorter or longer. Stay within the source and ground edits in
the timestamps of the sample frames. Prefer intervals with multiple relevant frames.
Each clip needs start_time and end_time in seconds, a factual 2-7 word summary, tags,
an empty emphasis array, and scores with hook, standalone, arc, quotability, and ending
values from 0 to 10. Treat quotability as shareability of the visible moment, not speech.
Do not overlap clips by more than 5 seconds."""

    def _build_transcript_text(self, transcript: list) -> str:
        """Build formatted transcript text: `[start - end] (speaker) text (events)`."""
        if not transcript:
            return "[No transcript available]"

        lines = []
        for index, seg in enumerate(transcript):
            time_str = f"[{seg.start_time_ms / 1000:.1f} - {seg.end_time_ms / 1000:.1f}]"
            speaker = f"({seg.speaker_label}) " if seg.speaker_label else ""
            events = getattr(seg, "audio_events", None) or []
            event_str = f" {' '.join(events)}" if events else ""
            lines.append(f"[segment {index}] {time_str} {speaker}{seg.text}{event_str}")

        return "\n".join(lines)

    async def _load_frames_as_base64(
        self,
        frames: list[VisionFrame],
    ) -> list[dict]:
        """Load frames as base64-encoded images."""
        results = []
        
        for frame in frames:
            try:
                with open(frame.file_path, "rb") as f:
                    image_data = f.read()
                
                base64_data = base64.b64encode(image_data).decode("utf-8")
                
                # Determine MIME type from extension
                ext = os.path.splitext(frame.file_path)[1].lower()
                mime_type = {
                    ".png": "image/png",
                    ".webp": "image/webp",
                    ".gif": "image/gif",
                }.get(ext, "image/jpeg")
                
                results.append({
                    "base64": base64_data,
                    "mime_type": mime_type,
                    "timestamp_ms": frame.timestamp_ms,
                })
                
            except Exception as e:
                logger.warning(f"Failed to load frame {frame.file_path}: {e}")
        
        return results

    def _build_vision_messages(
        self,
        system_prompt: str,
        transcript_text: str,
        frame_images: list[dict],
        clip_count: int,
        transcript: list[TranscriptSegment],
        video_duration_seconds: float = 0.0,
        longform: bool = False,
    ) -> list[dict]:
        """Build the planner messages (transcript, plus frames when provided)."""
        user_content = []

        video_duration = video_duration_seconds or (
            transcript[-1].end_time_ms / 1000 if transcript else 0
        )

        frames_note = (
            f"\n\nBelow are {len(frame_images)} sample frames from the video at regular "
            "intervals. Use these to understand the visual content and identify compelling moments."
            if frame_images else ""
        )
        source_description = (
            f"Here is the transcript of the video:\n\n{transcript_text}"
            if transcript else
            "No usable speech transcript is available. Judge only the visible sample frames."
        )
        user_content.append({
            "type": "text",
            "text": f"{source_description}\n\nThe video is approximately {video_duration:.0f} seconds long.{frames_note}",
        })

        # Add frames as images with timestamps
        for frame in frame_images:
            user_content.append({
                "type": "text",
                "text": f"Frame at {frame['timestamp_ms'] / 1000:.1f} seconds:",
            })
            user_content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{frame['mime_type']};base64,{frame['base64']}",
                    "detail": "low",  # Use low detail to reduce token count
                },
            })
        
        # Add final instruction
        user_content.append({
            "type": "text",
            "text": (
                f"\nBased on the {'transcript and frames' if frame_images else 'transcript'} above, "
                f"identify up to {clip_count} complete, self-contained longform episodes. "
                "Return fewer rather than pad with weak material. Return your response as JSON."
                if longform else
                f"\nBased on the {'transcript and frames' if frame_images else 'transcript'} above, "
                f"identify up to {clip_count} coherent, self-contained segments. Return fewer or none rather than force a clip. Return JSON."
                if transcript else
                f"\nSelect up to {clip_count} visually compelling segments supported by these frames. "
                "Return an empty clips array if none qualify. Return your response as JSON."
            ),
        })
        
        return [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
        ]

    def _build_request_payload(
        self,
        model: str,
        fallback_models: list[str],
        messages: list[dict],
    ) -> dict:
        """Build the OpenRouter chat payload for a clip-planning request."""
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": self.settings.planner_max_output_tokens,
            "response_format": json_schema_format(
                "clip_plan", clip_plan_schema(getattr(self, "_current_longform", False)),
            ),
            # Repairs near-miss JSON (trailing commas, stray fences) server-side.
            "plugins": [{"id": "response-healing"}],
            # Only route to endpoints that honour every parameter above, so a
            # provider can't silently drop the schema or reasoning settings.
            "provider": {"require_parameters": True},
        }
        if fallback_models:
            payload["models"] = fallback_models

        # Advanced accepts models without configurable reasoning. Let the
        # selected model use its defaults instead of requiring a preset effort.
        if self.settings.clipping_mode != "advanced":
            apply_reasoning(payload, self.settings.planner_reasoning_effort)
        return payload

    async def _call_openrouter(
        self,
        model: str,
        messages: list[dict],
        fallback_models: Optional[list[str]] = None,
    ) -> tuple[dict, dict]:
        """Call OpenRouter chat completions (see clip_engine.services.openrouter).

        Raises:
            IntelligencePlanningError: with `retryable=True` for rate limits,
            provider outages and network failures.
        """
        client = await self._get_client()
        payload = self._build_request_payload(model, fallback_models or [], messages)
        try:
            return await chat_completion(client, payload)
        except OpenRouterError as e:
            raise IntelligencePlanningError(str(e), retryable=e.retryable) from e

    def _parse_clip_plan_response(self, response: dict) -> ClipPlanResponse:
        """Parse OpenRouter response into ClipPlanResponse."""
        try:
            content, finish_reason = message_text(response)
            if not content:
                raise IntelligencePlanningError(
                    f"Planner returned no content (finish_reason={finish_reason})"
                )
            if finish_reason == "length":
                logger.warning(
                    "Planner output hit max_tokens "
                    f"({self.settings.planner_max_output_tokens}); response may be truncated"
                )

            logger.info("Planner response length: %s chars", len(content))

            # Try to parse JSON
            try:
                parsed = json.loads(content)
            except json.JSONDecodeError:
                # Try to extract JSON from text
                json_match = re.search(r'[\[{][\s\S]*[\]}]', content)
                if json_match:
                    parsed = json.loads(json_match.group())
                else:
                    logger.error("Failed to parse JSON from planner response")
                    raise IntelligencePlanningError("Failed to parse JSON from planner response")
            
            logger.info(f"Parsed response structure: {type(parsed).__name__}, keys: {parsed.keys() if isinstance(parsed, dict) else 'N/A'}")
            
            # Handle array response (clips directly)
            if isinstance(parsed, list):
                clips_data = parsed
                insights = None
            else:
                clips_data = parsed.get("clips", [])
                insights = parsed.get("insights")
            
            logger.info(f"Found {len(clips_data)} clips in response before validation")
            
            transcript = getattr(self, '_current_transcript', [])
            video_duration = getattr(self, '_current_video_duration', None)
            source_end = video_duration * 1000 if video_duration else max((s.end_time_ms for s in transcript), default=86400000)
            clips = []
            for clip in clips_data:
                if not isinstance(clip, dict):
                    continue
                start, end = clip.get('start_time'), clip.get('end_time')
                if any(isinstance(t, bool) or not isinstance(t, (int, float)) or not math.isfinite(t) for t in (start, end)):
                    continue
                start_ms, end_ms = round(start * 1000), round(end * 1000)
                for boundary, attr in [('start', 'start_time_ms'), ('end', 'end_time_ms')]:
                    current = start_ms if boundary == 'start' else end_ms
                    nearby = [getattr(t, attr) for t in transcript if abs(getattr(t, attr) - current) <= 100]
                    if nearby:
                        nearest = min(nearby, key=lambda x: abs(x - current))
                        if boundary == 'start': start_ms = nearest
                        else: end_ms = nearest
                if not 0 <= start_ms < end_ms <= source_end:
                    continue
                overlapping = [t for t in transcript if t.start_time_ms < end_ms and t.end_time_ms > start_ms]
                if transcript and not overlapping:
                    continue
                if overlapping:
                    start_ms = max(0, min(start_ms, overlapping[0].start_time_ms))
                    end_ms = min(round(source_end), max(end_ms, overlapping[-1].end_time_ms))
                visual_times = getattr(self, '_current_visual_frame_times', [])
                if not transcript and visual_times:
                    supporting = [t for t in visual_times if start_ms <= t * 1000 <= end_ms]
                    if len(supporting) < 2 or any(b - a > 45 for a, b in zip(supporting, supporting[1:])):
                        continue
                moment = None
                if transcript and 'moment' in clip:
                    try:
                        moment = parse_moment(clip['moment'], transcript)
                    except ValueError:
                        continue
                    # Anchors construct the full moment before the first review.
                    start_ms = min(start_ms, moment['setup']['start_ms'])
                    end_ms = max(end_ms, moment['payoff']['end_ms'])
                    if not (0 <= start_ms < end_ms <= source_end and moment['topic_interval'][0] <= start_ms < end_ms <= moment['topic_interval'][1]):
                        continue
                segment = ClipPlanSegment(start_ms, end_ms, self._score_clip(clip), moment=moment,
                    summary=clip.get('summary'), tags=clip.get('tags', []),
                    emphasis_words=[w for w in clip.get('emphasis', []) if isinstance(w, str)][:5] if transcript else [])
                if getattr(self, '_current_longform', False):
                    segment.skip_ranges_ms = self._clean_skips(clip.get('skip'), start_ms, end_ms, 0, transcript)
                    segment.chapters = self._clean_chapters(clip.get('chapters'), start_ms, end_ms, segment.skip_ranges_ms, segment.summary)
                    description = clip.get('description')
                    if isinstance(description, str) and description.strip():
                        segment.description = description.strip()[:1500]
                clips.append(segment)

            logger.info(f"Parsed {len(clips)} clips from planner response")

            return ClipPlanResponse(
                segments=clips,
                total_clips=len(clips),
                target_platform=getattr(self, '_current_target_platform', 'tiktok'),
                insights=insights,
            )

        except IntelligencePlanningError as e:
            e.retryable = True
            raise
        except Exception as e:
            logger.error(f"Failed to parse clip plan response: {e}")
            raise IntelligencePlanningError(f"Failed to parse clip plan: {e}", retryable=True)

    @staticmethod
    def _clean_skips(
        raw: Any,
        start_ms: int,
        end_ms: int,
        min_runtime_ms: int,
        transcript: list[TranscriptSegment],
    ) -> list[tuple[int, int]]:
        """Validated longform skips in source ms: inside the clip, on sentence
        boundaries, merged, and never cutting the runtime below the minimum."""
        if not isinstance(raw, list):
            return []
        # A skip must leave some of the clip on both sides of it.
        inner_start, inner_end = start_ms + 5000, end_ms - 5000
        skips: list[tuple[int, int]] = []
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                s_ms = int(float(item["start_time"]) * 1000)
                e_ms = int(float(item["end_time"]) * 1000)
            except (KeyError, TypeError, ValueError):
                continue
            if transcript:
                # Jump from the end of a sentence to the start of the next one.
                snapped = last_sentence_end_between(transcript, s_ms - 4000, s_ms + 1500)
                s_ms = snapped if snapped is not None else s_ms
                snapped = next_start_at_or_after(transcript, e_ms - 1500, 4000)
                e_ms = snapped if snapped is not None else e_ms
            s_ms, e_ms = max(s_ms, inner_start), min(e_ms, inner_end)
            if e_ms - s_ms >= MIN_SKIP_MS:
                skips.append((s_ms, e_ms))

        merged: list[tuple[int, int]] = []
        for s_ms, e_ms in sorted(skips):
            if merged and s_ms <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(merged[-1][1], e_ms))
            else:
                merged.append((s_ms, e_ms))

        # Keep the longest skips that fit the share and runtime budgets.
        span = end_ms - start_ms
        budget = min(span * MAX_SKIP_SHARE, span - min_runtime_ms)
        kept: list[tuple[int, int]] = []
        used = 0
        for s_ms, e_ms in sorted(merged, key=lambda r: r[1] - r[0], reverse=True):
            if used + (e_ms - s_ms) <= budget:
                kept.append((s_ms, e_ms))
                used += e_ms - s_ms
        if len(kept) < len(merged):
            logger.info(f"Dropped {len(merged) - len(kept)} skip(s) that would cut the episode too short")
        return sorted(kept)

    @staticmethod
    def _clean_chapters(
        raw: Any,
        start_ms: int,
        end_ms: int,
        skips: list[tuple[int, int]],
        fallback_title: Optional[str],
    ) -> list[tuple[int, str]]:
        """Chapter starts in source ms: inside the clip, out of skips, spaced
        out, and with the first at the clip start."""
        chapters: list[tuple[int, str]] = []
        for item in raw if isinstance(raw, list) else []:
            if not isinstance(item, dict):
                continue
            title = item.get("title")
            try:
                t_ms = int(float(item["time"]) * 1000)
            except (KeyError, TypeError, ValueError):
                continue
            if not isinstance(title, str) or not title.strip():
                continue
            for s_ms, e_ms in skips:
                if s_ms <= t_ms < e_ms:
                    t_ms = e_ms
            if start_ms <= t_ms < end_ms - MIN_CHAPTER_GAP_MS:
                chapters.append((t_ms, " ".join(title.split())[:80]))
        chapters.sort()
        if not chapters:
            return []
        # The first chapter always opens the episode.
        if chapters[0][0] - start_ms < MIN_CHAPTER_GAP_MS:
            chapters[0] = (start_ms, chapters[0][1])
        else:
            chapters.insert(0, (start_ms, (fallback_title or "Intro").strip()[:80] or "Intro"))
        spaced = [chapters[0]]
        for t_ms, title in chapters[1:]:
            if t_ms - spaced[-1][0] >= MIN_CHAPTER_GAP_MS:
                spaced.append((t_ms, title))
        return spaced

    @staticmethod
    def _score_clip(clip: dict) -> float:
        """Virality score in [0, 1]: mean of the rubric scores / 10.

        Falls back to a model-supplied `virality_score`, then 0.5.
        """
        scores = clip.get("scores")
        if isinstance(scores, dict):
            values = []
            for dim in RUBRIC_DIMENSIONS:
                try:
                    values.append(min(10.0, max(0.0, float(scores[dim]))))
                except (KeyError, TypeError, ValueError):
                    continue
            if values:
                return round(sum(values) / len(values) / 10.0, 3)
        try:
            return min(1.0, max(0.0, float(clip.get("virality_score", 0.5))))
        except (TypeError, ValueError):
            return 0.5

    def _finalize_clips(
        self,
        clips: list[ClipPlanSegment],
        clip_count: int,
        allow_alternatives: bool = False,
    ) -> list[ClipPlanSegment]:
        """Bound ranked discovery; retain alternatives until review when requested."""
        ranked = sorted(clips, key=lambda c: c.virality_score, reverse=True)
        kept: list[ClipPlanSegment] = []
        for clip in ranked:
            overlaps = any(
                min(clip.end_time_ms, other.end_time_ms)
                - max(clip.start_time_ms, other.start_time_ms) > MAX_CLIP_OVERLAP_MS
                for other in kept
            )
            if (overlaps and not allow_alternatives) or any((clip.start_time_ms, clip.end_time_ms) == (other.start_time_ms, other.end_time_ms) for other in kept):
                logger.info(
                    f"Dropping overlapping clip {clip.start_time_ms}-{clip.end_time_ms}ms "
                    f"(score {clip.virality_score:.2f})"
                )
                continue
            kept.append(clip)

        if len(kept) > clip_count:
            logger.info(f"Planner returned {len(kept)} clips; keeping top {clip_count}")
            kept = kept[:clip_count]
        return kept

    async def close(self):
        """Close HTTP client."""
        if self._http_client:
            await self._http_client.aclose()


class IntelligencePlanningError(Exception):
    """Exception raised when intelligence planning fails."""

    def __init__(self, message: str, retryable: bool = False):
        super().__init__(message)
        self.retryable = retryable


class VisualPlanningUnsupportedError(IntelligencePlanningError):
    """The selected text-only planner cannot analyze a silent video."""
