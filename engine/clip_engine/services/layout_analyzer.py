"""
Layout Analyzer - decides how each shot of a clip should be framed for 9:16.

For a clip it:
1. Decodes low-res frames (ANALYSIS_FPS) with FFmpeg.
2. Detects faces per frame (OpenCV YuNet), shot cuts (HSV histogram jumps),
   and sustained changes between corner webcams and full-screen speakers.
3. Tracks faces within each shot and classifies the shot's layout:
     talking_head  one on-camera person          -> face-tracked full-frame crop
     two_shot      two people side by side       -> stacked split, one per panel
     screen_cam    screen content + webcam overlay -> screen panel over webcam panel
     screen        no usable person on camera    -> fit with blurred background
4. Optionally asks a vision LLM, once per distinct setup, to confirm the
   layout and return the real webcam / screen overlay rectangles. Face boxes
   alone underestimate a webcam overlay by 3-4x, which is what made the old
   split-screen renders look over-zoomed.

Every step degrades gracefully: without OpenCV or the face model the clip
falls back to the classic letterbox render; without the vision model the
heuristic classification is used.
"""

import asyncio
import base64
import json
import hashlib
import logging
import math
import os
import threading
from dataclasses import dataclass, field
from statistics import median
from typing import Any, Optional

import httpx

from clip_engine.config import LayoutStyle, get_settings
from clip_engine.services.media_process import media_process, MediaProcessError, validate_video_dimensions
from clip_engine.services.openrouter import (
    OpenRouterError,
    apply_reasoning,
    chat_completion,
    json_schema_format,
    message_text,
)

logger = logging.getLogger(__name__)

try:
    import cv2
    import numpy as np

    # OpenCV 5's DNN graph engine warns about unsupported targets on every
    # detector creation; it's harmless noise in job logs.
    cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_ERROR)
except ImportError:  # pragma: no cover - exercised only without the CV extras
    cv2 = None
    np = None


# ------------------------------------------------------------------
# Tunables
# ------------------------------------------------------------------

ANALYSIS_FPS = 4.0
ANALYSIS_WIDTH = 640
KEYFRAME_WIDTH = 768
KEYFRAME_FPS = 1.0
MAX_ANALYSIS_HEIGHT = 1280
MAX_ANALYSIS_DURATION_MS = 60 * 60 * 1000
MAX_ANALYSIS_FRAMES = int(MAX_ANALYSIS_DURATION_MS / 1000 * ANALYSIS_FPS) + 1
MAX_RETAINED_KEYFRAMES = 256
MAX_KEYFRAME_BYTES = 32 * 1024 * 1024
MAX_FACES_PER_FRAME = 32


def analysis_dimensions(width: int, height: int) -> tuple[int, int]:
    validate_video_dimensions(width, height)
    scale = min(ANALYSIS_WIDTH / width, MAX_ANALYSIS_HEIGHT / height)
    return max(2, round(width * scale / 2) * 2), max(2, round(height * scale / 2) * 2)


FACE_SCORE_THRESHOLD = 0.72
STRONG_FACE_SCORE = 0.90
COMPETING_FACE_SCORE = 0.85
# Bhattacharyya distance between consecutive HSV histograms that counts as a cut.
SHOT_CUT_THRESHOLD = 0.42
MIN_SHOT_MS = 1200
# Require three consecutive observations before changing layout. Missing faces
# need a longer hold: looking away must not be mistaken for a scene change.
LAYOUT_CHANGE_MS = 500
LAYOUT_CHANGE_SAMPLES = 3

# A face track must be visible in this share of a shot's frames to count.
MIN_TRACK_PRESENCE = 0.35
MAX_TRACK_GAP_MS = 1000
# Faces smaller than this (fraction of frame height) sitting in a corner are
# treated as a webcam overlay rather than an on-camera person.
OVERLAY_MAX_FACE_HEIGHT = 0.17
# Faces smaller than this are ignored entirely (crowds, posters, thumbnails).
MIN_FACE_HEIGHT = 0.035
# Share of a webcam overlay's height its face spans (head-and-shoulders framing).
CAM_FACE_SHARE = 0.28

# Face-tracked crop camera: ignore motion inside this share of the crop
# width, and cap how fast the virtual camera pans (crop widths per second).
CAMERA_DEADZONE = 0.12
CAMERA_MAX_SPEED = 0.9
MAX_PATH_KEYFRAMES = 40


class LayoutType:
    TALKING_HEAD = "talking_head"
    TWO_SHOT = "two_shot"
    SCREEN_CAM = "screen_cam"
    SCREEN = "screen"

    ALL = (TALKING_HEAD, TWO_SHOT, SCREEN_CAM, SCREEN)


# ------------------------------------------------------------------
# Data structures (all boxes normalized to 0-1 of the source frame)
# ------------------------------------------------------------------


@dataclass
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def area(self) -> float:
        return self.w * self.h

    def clamp(self) -> "Box":
        w = min(max(self.w, 0.0), 1.0)
        h = min(max(self.h, 0.0), 1.0)
        x = min(max(self.x, 0.0), 1.0 - w)
        y = min(max(self.y, 0.0), 1.0 - h)
        return Box(x, y, w, h)

    def contains(self, px: float, py: float) -> bool:
        return self.x <= px <= self.x + self.w and self.y <= py <= self.y + self.h

    def to_list(self) -> list[float]:
        return [round(self.x, 4), round(self.y, 4), round(self.w, 4), round(self.h, 4)]


@dataclass
class FaceTrack:
    """One person's face across the frames of a shot."""

    samples: list[tuple[int, Box]] = field(default_factory=list)  # (t_ms, box)

    def median_box(self) -> Box:
        return Box(
            median(b.x for _, b in self.samples),
            median(b.y for _, b in self.samples),
            median(b.w for _, b in self.samples),
            median(b.h for _, b in self.samples),
        )


@dataclass
class FrameInfo:
    t_ms: int
    faces: list[Box]
    hist: Any  # np.ndarray
    scores: list[float] = field(default_factory=list)
    content_box: Optional[Box] = None


@dataclass
class ShotLayout:
    """How to frame one shot. Times are ms from the start of the render window."""

    start_ms: int
    end_ms: int
    layout: str
    source: str = "heuristic"  # heuristic | vision | style
    # What the shot actually shows, kept when a style overrides the framing
    # (pacing rules depend on content, not on how it is framed).
    detected_layout: Optional[str] = None
    # talking_head: virtual-camera focus path of (t_ms from shot start, cx, cy)
    focus_path: list[tuple[int, float, float]] = field(default_factory=list)
    # two_shot: the two people, left to right
    people: list[Box] = field(default_factory=list)
    # screen_cam
    screen_box: Optional[Box] = None
    # Where the action is inside the screen (active pane, chat, game view).
    screen_focus: Optional[Box] = None
    cam_box: Optional[Box] = None
    cam_face: Optional[Box] = None
    # A video inset surrounded by padding. Preserve its composition, rather
    # than following faces inside it or carrying an anchor across the cut.
    content_box: Optional[Box] = None
    cam_box_refined: bool = False
    manual_crops: list[tuple[float, float, float, float]] = field(default_factory=list)
    manual_from_crops: list[tuple[float, float, float, float]] = field(default_factory=list)
    manual_transition_start_ms: int = 0
    manual_transition_ms: int = 0

    def summary(self) -> dict:
        return {
            "start_ms": self.start_ms,
            "end_ms": self.end_ms,
            "layout": self.layout,
            "source": self.source,
            "screen_box": self.screen_box.to_list() if self.screen_box else None,
            "screen_focus": self.screen_focus.to_list() if self.screen_focus else None,
            "cam_box": self.cam_box.to_list() if self.cam_box else None,
            "people": [p.to_list() for p in self.people],
            "content_box": self.content_box.to_list() if self.content_box else None,
            "cam_box_refined": self.cam_box_refined,
        }


@dataclass
class ClipLayoutPlan:
    shots: list[ShotLayout]
    source_width: int
    source_height: int
    vision_cost_usd: float = 0.0
    # Every analyzed frame's faces as (t_ms in window time, boxes), including
    # frames without any. Captions use them to stay off faces.
    face_samples: list[tuple[int, list[Box]]] = field(default_factory=list)
    trace: Optional[dict] = None

    @property
    def dominant_layout(self) -> str:
        if not self.shots:
            return LayoutType.SCREEN
        totals: dict[str, int] = {}
        for s in self.shots:
            totals[s.layout] = totals.get(s.layout, 0) + (s.end_ms - s.start_ms)
        return max(totals, key=totals.get)

    @property
    def is_letterbox_only(self) -> bool:
        return all(s.layout == LayoutType.SCREEN and s.content_box is None for s in self.shots)


# ------------------------------------------------------------------
# Pure helpers (unit tested)
# ------------------------------------------------------------------


def framing_faces(frame: FrameInfo) -> list[Box]:
    """Weak competing detections must not displace a confident real face.

    Keep the original observations in diagnostics. Unknown scores (older
    records / fixtures) retain the existing behavior.
    """
    reliable = any(score >= STRONG_FACE_SCORE for score in frame.scores)
    return [box for i, box in enumerate(frame.faces)
            if not reliable or i >= len(frame.scores) or frame.scores[i] >= COMPETING_FACE_SCORE]


def detect_content_box(image) -> Optional[Box]:
    """Conservative rectangular inset detection, including textured padding.

    Require matching, mostly uniform side margins and sustained straight
    content edges. A wall behind a person alone is not a rectangular inset.
    Work only on the already-decoded analysis image; no extra provider call.
    """
    h, w = image.shape[:2]
    if w < 80 or h < 60:
        return None
    small = cv2.GaussianBlur(image, (5, 5), 0).astype(np.float32)
    margin = max(2, round(w * .06))
    sides = np.concatenate((small[:, :margin].reshape(-1, 3), small[:, -margin:].reshape(-1, 3)))
    background = np.median(sides, axis=0)
    if np.quantile(np.max(np.abs(sides - background), axis=1), .9) > 16:
        return None
    mask = np.max(np.abs(small - background), axis=2) > 25
    columns = np.flatnonzero(mask.mean(axis=0) > .45)
    if not len(columns):
        return None
    left, right = int(columns[0]), int(columns[-1]) + 1
    if left < w * .08 or right > w * .92 or not .18 <= (right - left) / w <= .84:
        return None
    rows = np.flatnonzero(mask[:, left:right].mean(axis=1) > .55)
    if not len(rows):
        return None
    top, bottom = int(rows[0]), int(rows[-1]) + 1
    if bottom - top < .5 * h:
        return None
    # Exclude shadows and rounded corners when assessing the vertical edges.
    middle = mask[top + int((bottom - top) * .08):bottom - int((bottom - top) * .08)]
    first = middle.argmax(axis=1)
    last = w - 1 - middle[:, ::-1].argmax(axis=1)
    straight = (np.abs(first - left) <= w * .015) & (np.abs(last + 1 - right) <= w * .015)
    if straight.mean() < .8 or mask[top:bottom, left:right].mean() < .7:
        return None
    return Box(left / w, top / h, (right - left) / w, (bottom - top) / h)


def same_content(a: Optional[Box], b: Optional[Box]) -> bool:
    if a is None or b is None:
        return a is b
    return max(abs(x - y) for x, y in zip(a.to_list(), b.to_list())) < .035


def content_boundaries(frames: list[FrameInfo]) -> list[int]:
    """Confirm an inset entering, leaving or moving over three observations."""
    if not frames:
        return []
    current = frames[0].content_box
    pending: list[FrameInfo] = []
    cuts = []
    for frame in frames[1:]:
        if same_content(frame.content_box, current):
            pending = []
            continue
        if pending and not same_content(frame.content_box, pending[0].content_box):
            pending = []
        pending.append(frame)
        if len(pending) >= LAYOUT_CHANGE_SAMPLES and frame.t_ms - pending[0].t_ms >= LAYOUT_CHANGE_MS:
            cuts.append(pending[0].t_ms)
            current, pending = frame.content_box, []
    return cuts


def segment_shots(frames: list[FrameInfo], duration_ms: int) -> list[tuple[int, int]]:
    """Split the timeline into shots at histogram cuts; merge shots < MIN_SHOT_MS."""
    if not frames:
        return [(0, duration_ms)]
    cuts = [0]
    for prev, cur in zip(frames, frames[1:]):
        dist = cv2.compareHist(prev.hist, cur.hist, cv2.HISTCMP_BHATTACHARYYA)
        if dist > SHOT_CUT_THRESHOLD:
            # The cut happened somewhere between the two samples.
            cuts.append((prev.t_ms + cur.t_ms) // 2)
    cuts.append(duration_ms)

    shots = [(a, b) for a, b in zip(cuts, cuts[1:]) if b > a]
    merged: list[tuple[int, int]] = []
    for start, end in shots:
        if merged and (end - start < MIN_SHOT_MS or merged[-1][1] - merged[-1][0] < MIN_SHOT_MS):
            merged[-1] = (merged[-1][0], end)
        else:
            merged.append((start, end))
    return merged


def track_faces(frames: list[FrameInfo]) -> list[FaceTrack]:
    """Associate nearby faces, retaining an unambiguous subject through jumps.

    A sole visible face can move farther than the normal association radius
    between samples. Keep that track while its size/layout remain compatible;
    never use this shortcut after a multi-person frame or a long dropout.
    """
    tracks: list[FaceTrack] = []
    sole_track: Optional[int] = None
    for frame in frames:
        faces = framing_faces(frame)
        used: set[int] = set()
        for face in sorted(faces, key=lambda b: -b.area):
            best, best_dist = None, 0.12
            if len(faces) == 1 and sole_track is not None:
                last_t, last = tracks[sole_track].samples[-1]
                # A zoom cut can exceed the usual 2x size gate. Webcam moves
                # still need separate tracks for overlay-region classification.
                if (frame.t_ms - last_t <= MAX_TRACK_GAP_MS
                        and 0.25 < face.h / max(last.h, 1e-6) < 4.0
                        and not is_corner_overlay(face) and not is_corner_overlay(last)):
                    best = sole_track
            if best is None:
                for i, track in enumerate(tracks):
                    if i in used or frame.t_ms - track.samples[-1][0] > MAX_TRACK_GAP_MS:
                        continue
                    last = track.samples[-1][1]
                    dist = ((last.cx - face.cx) ** 2 + (last.cy - face.cy) ** 2) ** 0.5
                    size_ratio = face.h / max(last.h, 1e-6)
                    if dist < best_dist and 0.5 < size_ratio < 2.0:
                        best, best_dist = i, dist
            if best is None:
                tracks.append(FaceTrack(samples=[(frame.t_ms, face)]))
                used.add(len(tracks) - 1)
            else:
                tracks[best].samples.append((frame.t_ms, face))
                used.add(best)
        if len(faces) == 1:
            sole_track = next(iter(used))
        elif faces:
            sole_track = None
    return tracks


def is_corner_overlay(face: Box) -> bool:
    """Small face in a frame corner: almost always a webcam overlay."""
    if face.h > OVERLAY_MAX_FACE_HEIGHT:
        return False
    return (face.cx < 0.3 or face.cx > 0.7) and (face.cy < 0.4 or face.cy > 0.6)


def frame_layout_evidence(frame: FrameInfo) -> Optional[str]:
    """Conservative temporal evidence, not a replacement for shot classification.

    A visible corner webcam wins over faces inside a game or shared screen.
    Small central faces and groups are ambiguous. A large central face with no
    corner webcam is positive evidence of a speaker, unlike a detector dropout.
    """
    faces = [f for f in framing_faces(frame) if f.h >= MIN_FACE_HEIGHT]
    if not faces:
        return LayoutType.SCREEN
    if any(is_corner_overlay(f) for f in faces):
        return LayoutType.SCREEN_CAM
    if len(faces) == 1:
        face = faces[0]
        in_corner = (face.cx < 0.3 or face.cx > 0.7) and (face.cy < 0.4 or face.cy > 0.6)
        if face.h > OVERLAY_MAX_FACE_HEIGHT * 1.3 and not in_corner:
            return LayoutType.TALKING_HEAD
    return None


def split_layout_segments(
    frames: list[FrameInfo], start_ms: int, end_ms: int,
    boundaries: Optional[list[dict]] = None,
) -> list[tuple[int, int]]:
    """Refine a color-based shot using sustained face-layout evidence.

    Backdate a confirmed transition to its first observation. Ambiguous frames
    and brief dropouts do not change the established layout; persistent missing
    faces get their own segment so vision can distinguish a hidden face from a
    removed webcam. Unlike histogram blips, confirmed layout changes are not
    absorbed by the 1.2-second shot-merging rule.
    """
    cuts = [start_ms]
    current: Optional[str] = None
    pending: Optional[str] = None
    pending_start = start_ms
    count = 0
    for frame in frames:
        evidence = frame_layout_evidence(frame)
        if evidence is None or evidence == current:
            pending, count = None, 0
            continue
        if evidence != pending:
            pending, pending_start, count = evidence, frame.t_ms, 0
        count += 1
        hold_ms = MIN_SHOT_MS if evidence == LayoutType.SCREEN else LAYOUT_CHANGE_MS
        if count >= LAYOUT_CHANGE_SAMPLES and frame.t_ms - pending_start >= hold_ms:
            if current is not None and pending_start > cuts[-1]:
                cuts.append(pending_start)
                if boundaries is not None:
                    boundaries.append({"t_ms": pending_start, "kind": "layout", "accepted": True,
                                       "from_layout": current, "to_layout": evidence,
                                       "hold_ms": frame.t_ms - pending_start, "samples": count})
            current, pending, count = evidence, None, 0
    return list(zip(cuts, cuts[1:] + [end_ms]))


def segment_content_box(frames: list[FrameInfo]) -> Optional[Box]:
    """Stable median geometry, tolerating isolated misses and outliers."""
    content = [f.content_box for f in frames if f.content_box is not None]
    if len(content) >= max(LAYOUT_CHANGE_SAMPLES, len(frames) * .6):
        box = Box(*(median(getattr(b, axis) for b in content) for axis in ('x', 'y', 'w', 'h')))
        if sum(same_content(box, b) for b in content) >= .8 * len(content):
            return box.clamp()
    return None


def heuristic_layout(
    frames: list[FrameInfo], start_ms: int, end_ms: int, src_w: int, src_h: int,
    diagnostic: Optional[dict] = None,
) -> ShotLayout:
    """Classify and track only the faces belonging to this layout segment."""
    content = segment_content_box(frames)
    if content is not None:
        return ShotLayout(start_ms, end_ms, LayoutType.SCREEN, content_box=content)
    tracks = track_faces(frames)
    shot, main_track = classify_shot(tracks, len(frames), src_w, src_h)
    if diagnostic is not None:
        lookup = {(f.t_ms, id(box)): i for f in frames for i, box in enumerate(f.faces)}
        diagnostic["tracks"] = [{"id": i, "selected": track is main_track,
                                 "samples": [[t, lookup[(t, id(box))]] for t, box in track.samples]}
                                for i, track in enumerate(tracks)]
    shot.start_ms, shot.end_ms = start_ms, end_ms
    if main_track is not None:
        samples = [(t - start_ms, box) for t, box in main_track.samples]
        crop_w_frac = min(1.0, (src_h * 9 / 16) / src_w)
        shot.focus_path = smooth_focus_path(samples, end_ms - start_ms, crop_w_frac)
    return shot


def estimate_cam_box(face: Box, src_w: int, src_h: int) -> Box:
    """Estimate the webcam overlay rectangle around a face.

    Used when the vision model is unavailable. A streaming webcam frames head
    and shoulders with the face spanning ~28% of its height (the old 50%
    guess gave a box a quarter of the overlay's area, and a 5x-upscaled
    crop). The box stays in the face's corner so it never reaches across the
    middle of the frame into screen content.
    """
    cam_h = min(face.h / CAM_FACE_SHARE, 0.45)
    cam_w = min(cam_h * (16 / 9) * (src_h / src_w), 0.4)
    box = Box(face.cx - cam_w / 2, face.cy - cam_h * 0.40, cam_w, cam_h).clamp()
    x0, x1 = (0.5, 1.0) if face.cx >= 0.5 else (0.0, 0.5)
    y0, y1 = (0.5, 1.0) if face.cy >= 0.5 else (0.0, 0.5)
    # Never cut into the face itself, whatever the corner bounds say.
    x0, x1 = min(x0, face.x), max(x1, face.x + face.w)
    y0, y1 = min(y0, face.y), max(y1, face.y + face.h)
    left, top = max(box.x, x0), max(box.y, y0)
    right, bottom = min(box.x + box.w, x1), min(box.y + box.h, y1)
    return Box(left, top, right - left, bottom - top)


def refine_cam_box(image, cam: Box, face: Optional[Box] = None) -> Optional[Box]:
    """Snap approximate webcam bounds to nearby, continuous image edges.

    Require two independently supported edges. Strong texture everywhere is
    not a boundary; the edge must stand out from neighboring lines. Leave
    uncertain geometry alone and never snap through the detected face.
    """
    h, w = image.shape[:2]
    pixels = cv2.GaussianBlur(image, (3, 3), 0).astype(np.float32)
    box = cam.clamp()
    edges = [box.x * w, box.y * h, (box.x + box.w) * w, (box.y + box.h) * h]
    found = 0
    for side, value in enumerate(edges.copy()):
        vertical = side in (0, 2)
        length = w if vertical else h
        span = box.w * w if vertical else box.h * h
        # Image borders already bound the camera; they are not independent
        # visual evidence of an overlay.
        if value <= 1 or value >= length - 1:
            continue
        radius = max(4, round(min(length * .035, span * .15)))
        lo, hi = (edges[1], edges[3]) if vertical else (edges[0], edges[2])
        inset = (hi - lo) * .12
        a, b = int(lo + inset), int(hi - inset)
        if b - a < 12:
            continue
        scores = []
        for pos in range(max(2, round(value) - radius), min(length - 2, round(value) + radius) + 1):
            if vertical:
                delta = np.max(np.abs(pixels[a:b, pos-2:pos].mean(axis=1) - pixels[a:b, pos:pos+2].mean(axis=1)), axis=1)
            else:
                delta = np.max(np.abs(pixels[pos-2:pos, a:b].mean(axis=0) - pixels[pos:pos+2, a:b].mean(axis=0)), axis=1)
            strength = float(np.median(delta))
            support = float((delta > 18).mean())
            scores.append((pos, strength, support))
        if not scores:
            continue
        baseline = median(score for _, score, _ in scores)
        candidates = [(pos, score * support - abs(pos - value)) for pos, score, support in scores
                      if support >= .65 and score >= max(24, baseline * 1.8 + 8)]
        if not candidates:
            continue
        pos = max(candidates, key=lambda item: item[1])[0]
        # One analysis pixel inside the edge removes compression/border bleed.
        edges[side] = pos + 1 if side < 2 else pos - 1
        found += 1
    left, top, right, bottom = edges
    if found < 2 or right - left < 8 or bottom - top < 8:
        return None
    refined = Box(left / w, top / h, (right - left) / w, (bottom - top) / h).clamp()
    if not .65 <= refined.area / max(box.area, 1e-6) <= 1.4:
        return None
    if face and not (refined.contains(face.x, face.y) and refined.contains(face.x + face.w, face.y + face.h)):
        return None
    return refined


def transfer_cam_box(ref_cam: Box, ref_face: Box, face: Box) -> Box:
    """Move/scale a known webcam box to follow its face.

    Streamers resize and reposition webcam overlays mid-shot; the face inside
    moves and scales with the overlay, so the overlay's geometry relative to
    the face carries over.
    """
    scale = face.h / max(ref_face.h, 1e-6)
    return Box(
        face.cx + (ref_cam.x - ref_face.cx) * scale,
        face.cy + (ref_cam.y - ref_face.cy) * scale,
        ref_cam.w * scale,
        ref_cam.h * scale,
    ).clamp()


def _overlay_moved(face: Box, anchor: Box) -> bool:
    ratio = face.h / max(anchor.h, 1e-6)
    return (
        abs(face.cx - anchor.cx) > 0.6 * anchor.w
        or abs(face.cy - anchor.cy) > 0.6 * anchor.h
        or not 0.8 <= ratio <= 1.25
    )


def split_overlay_segments(
    frames: list[FrameInfo],
    shot_start: int,
    shot_end: int,
    seed: Box,
    region: Optional[Box] = None,
) -> list[tuple[int, int, Optional[Box]]]:
    """Split a screen+webcam shot wherever the webcam overlay moves or resizes.

    1. Observe the webcam face per sample: the small face nearest the last one.
       With a known webcam `region` (vision box), any face inside it counts
       too, however large: a close webcam is still the webcam.
    2. Dropouts lasting MIN_SHOT_MS or more are "no webcam" stretches.
    3. A jump in position/size held for 2+ samples starts a new segment.
    Segments shorter than MIN_SHOT_MS are absorbed by their neighbour.

    Returns contiguous (start_ms, end_ms, median face or None) covering the shot.
    """
    max_face_h = OVERLAY_MAX_FACE_HEIGHT * 1.3
    observations: list[tuple[int, Optional[Box]]] = []
    anchor = seed
    for frame in frames:
        candidates = [
            f for f in framing_faces(frame)
            if MIN_FACE_HEIGHT <= f.h
            and (f.h <= max_face_h or (region is not None and region.contains(f.cx, f.cy) and f.h <= region.h))
        ]
        face = min(
            candidates,
            key=lambda f: (f.cx - anchor.cx) ** 2 + (f.cy - anchor.cy) ** 2,
            default=None,
        )
        observations.append((frame.t_ms, face))
        if face is not None:
            anchor = face

    # Long dropouts -> no-webcam stretches (index ranges).
    in_gap = [False] * len(observations)
    i = 0
    while i < len(observations):
        if observations[i][1] is not None:
            i += 1
            continue
        j = i
        while j < len(observations) and observations[j][1] is None:
            j += 1
        gap_end = observations[j][0] if j < len(observations) else shot_end
        if gap_end - observations[i][0] >= MIN_SHOT_MS:
            for k in range(i, j):
                in_gap[k] = True
        i = j

    segments: list[list] = []  # [start_ms, faces or None]
    current: Optional[list] = None
    reference: Optional[Box] = None
    pending: list[tuple[int, Box]] = []
    for idx, (t_ms, face) in enumerate(observations):
        if in_gap[idx]:
            if current is None or current[1] is not None:
                current = [t_ms, None]
                segments.append(current)
                pending = []
            continue
        if face is None:
            continue  # brief dropout (hand over face, looking away)
        if current is None or current[1] is None:
            current = [t_ms, [face]]
            segments.append(current)
            reference, pending = face, []
            continue
        if _overlay_moved(face, reference):
            pending.append((t_ms, face))
            if len(pending) >= 2:
                current = [pending[0][0], [f for _, f in pending]]
                segments.append(current)
                reference, pending = pending[-1][1], []
            continue
        pending = []
        current[1].append(face)
        reference = Box(
            reference.x * 0.7 + face.x * 0.3, reference.y * 0.7 + face.y * 0.3,
            reference.w * 0.7 + face.w * 0.3, reference.h * 0.7 + face.h * 0.3,
        )

    if not segments:
        return [(shot_start, shot_end, None)]

    result: list[tuple[int, int, Optional[Box]]] = []
    for i, (seg_start, faces) in enumerate(segments):
        seg_start = shot_start if i == 0 else seg_start
        seg_end = segments[i + 1][0] if i + 1 < len(segments) else shot_end
        face = None
        if faces:
            face = Box(
                median(f.x for f in faces), median(f.y for f in faces),
                median(f.w for f in faces), median(f.h for f in faces),
            )
        if result and seg_end - seg_start < MIN_SHOT_MS:
            prev = result[-1]
            result[-1] = (prev[0], seg_end, prev[2])
        else:
            result.append((seg_start, seg_end, face))
    if len(result) > 1 and result[0][1] - result[0][0] < MIN_SHOT_MS:
        first, second = result[0], result[1]
        result[:2] = [(first[0], second[1], second[2] or first[2])]
    return result


def screen_box_excluding_cam(cam: Box) -> Box:
    """Screen region: the full frame, trimmed away from a side-mounted webcam."""
    # Only trim when the cam spans most of a side; corner cams overlap the
    # screen, which is normal for streams.
    if cam.h > 0.8 and cam.x < 0.05:
        return Box(cam.x + cam.w, 0.0, 1.0 - cam.w, 1.0)
    if cam.h > 0.8 and cam.x + cam.w > 0.95:
        return Box(0.0, 0.0, cam.x, 1.0)
    return Box(0.0, 0.0, 1.0, 1.0)


def expanded_webcam_intervals(
    frames: list[FrameInfo], cam: Box, end_ms: int,
) -> list[tuple[int, int]]:
    """Find sustained presenter punch-ins relative to an observed compact webcam.

    A keyed presenter can grow without changing the background histogram, and
    remain on the right/left of the screen. Neither a central-face requirement
    nor searching only inside the old camera box can recognize that edit.
    Require a stable, sole face inside the known camera before using relative
    size/position evidence. This also works when vision sampled the punch-in:
    the compact reference can occur earlier or later in the shot.
    """
    runs: list[list[tuple[int, Box]]] = []
    run: list[tuple[int, Box]] = []
    for frame in frames:
        faces = framing_faces(frame)
        face = faces[0] if len(faces) == 1 else None
        compact = (face is not None and MIN_FACE_HEIGHT <= face.h <= .25
                   and cam.contains(face.cx, face.cy)
                   and (face.cx < .3 or face.cx > .7)
                   and (face.cy < .4 or face.cy > .6))
        if not compact or (run and _overlay_moved(face, run[0][1])):
            if len(run) >= LAYOUT_CHANGE_SAMPLES and run[-1][0] - run[0][0] >= LAYOUT_CHANGE_MS:
                runs.append(run)
            run = []
        if compact:
            run.append((frame.t_ms, face))
    if len(run) >= LAYOUT_CHANGE_SAMPLES and run[-1][0] - run[0][0] >= LAYOUT_CHANGE_MS:
        runs.append(run)
    if not runs:
        return []
    reference = max(runs, key=len)
    anchor = Box(*(median(getattr(f, axis) for _, f in reference) for axis in ('x', 'y', 'w', 'h')))

    intervals = []
    expanded = False
    pending_start, count, start = 0, 0, 0
    for frame in frames:
        faces = framing_faces(frame)
        face = faces[0] if len(faces) == 1 else None
        evidence = (face is not None and face.h >= max(.26, anchor.h * 1.45)
                    and face.w >= anchor.w * 1.3
                    and (abs(face.cx - anchor.cx) > .6 * anchor.w
                         or abs(face.cy - anchor.cy) > .6 * anchor.h))
        if evidence == expanded:
            count = 0
            continue
        if count == 0:
            pending_start = frame.t_ms
        count += 1
        if count >= LAYOUT_CHANGE_SAMPLES and frame.t_ms - pending_start >= LAYOUT_CHANGE_MS:
            if evidence:
                start = pending_start
            else:
                intervals.append((start, pending_start))
            expanded, count = evidence, 0
    if expanded:
        intervals.append((start, end_ms))
    return intervals


def classify_shot(
    tracks: list[FaceTrack], shot_frames: int, src_w: int, src_h: int,
) -> tuple[ShotLayout, Optional[FaceTrack]]:
    """Heuristic layout for one shot from its face tracks.

    Returns the layout (times filled in by the caller) and, for talking-head
    shots, the track the camera should follow.
    """
    present = [
        t for t in tracks
        if len(t.samples) >= max(1, MIN_TRACK_PRESENCE * shot_frames)
        and t.median_box().h >= MIN_FACE_HEIGHT
    ]
    present.sort(key=lambda t: -t.median_box().area)

    overlays = [t for t in present if is_corner_overlay(t.median_box())]
    on_camera = [t for t in present if t not in overlays]

    # A webcam that moves mid-shot splits into several short tracks; judge
    # its presence by all corner-overlay faces together.
    if not overlays:
        corner = [t for t in tracks if t.median_box().h >= MIN_FACE_HEIGHT and is_corner_overlay(t.median_box())]
        if sum(len(t.samples) for t in corner) >= MIN_TRACK_PRESENCE * shot_frames:
            overlays = sorted(corner, key=lambda t: -len(t.samples))

    if len(on_camera) >= 2:
        a, b = on_camera[0].median_box(), on_camera[1].median_box()
        similar = min(a.h, b.h) / max(a.h, b.h) >= 0.5
        separated = abs(a.cx - b.cx) >= 0.22
        if len(on_camera) == 2 and similar and separated:
            people = sorted([a, b], key=lambda box: box.cx)
            return ShotLayout(0, 0, LayoutType.TWO_SHOT, people=people), None
        if len(on_camera) > 2:
            return ShotLayout(0, 0, LayoutType.SCREEN), None
    if on_camera:
        main = on_camera[0]
        return ShotLayout(0, 0, LayoutType.TALKING_HEAD, people=[main.median_box()]), main
    if overlays:
        face = overlays[0].median_box()
        cam = estimate_cam_box(face, src_w, src_h)
        return ShotLayout(
            0, 0, LayoutType.SCREEN_CAM,
            cam_box=cam, cam_face=face, screen_box=screen_box_excluding_cam(cam),
        ), None
    return ShotLayout(0, 0, LayoutType.SCREEN), None


def smooth_focus_path(
    samples: list[tuple[int, Box]],
    duration_ms: int,
    crop_w_frac: float,
    step_ms: int = int(1000 / ANALYSIS_FPS),
) -> list[tuple[int, float, float]]:
    """Turn noisy face centers into a calm virtual-camera path.

    Holds still while the subject stays inside a dead zone, then pans with a
    capped speed. Returns keyframes (t_ms, cx, cy) with times relative to the
    first sample's shot start.
    """
    if not samples:
        return []
    samples = sorted(samples, key=lambda s: s[0])

    # Resample onto a regular grid, holding the nearest detection.
    grid: list[tuple[int, float, float]] = []
    j = 0
    for t in range(0, max(duration_ms, 1), step_ms):
        while j + 1 < len(samples) and abs(samples[j + 1][0] - t) <= abs(samples[j][0] - t):
            j += 1
        grid.append((t, samples[j][1].cx, samples[j][1].cy))

    # Median filter to reject single-frame detector jumps.
    k = 2
    xs = [g[1] for g in grid]
    ys = [g[2] for g in grid]
    fx = [median(xs[max(0, i - k): i + k + 1]) for i in range(len(xs))]
    fy = [median(ys[max(0, i - k): i + k + 1]) for i in range(len(ys))]

    deadzone = CAMERA_DEADZONE * crop_w_frac
    max_step = CAMERA_MAX_SPEED * crop_w_frac * step_ms / 1000
    cam_x, cam_y = median(fx[: max(1, 1000 // step_ms)]), median(fy[: max(1, 1000 // step_ms)])
    path = [(0, cam_x, cam_y)]
    for (t, _, _), x, y in zip(grid[1:], fx[1:], fy[1:]):
        dx = x - cam_x
        if abs(dx) > deadzone:
            # Move toward the subject (not all the way: re-center with ease).
            move = max(-max_step, min(max_step, (dx - deadzone * (1 if dx > 0 else -1)) * 0.5))
            cam_x += move
        cam_y += (y - cam_y) * 0.2
        path.append((t, cam_x, cam_y))

    # Preserve the shape in BOTH axes. Keeping only moving/still transitions
    # erased reversals and vertical motion, sometimes leaving a static crop.
    # Insert the point with the largest interpolation error until the path is
    # accurate to 0.2% of the source or reaches FFmpeg's expression budget.
    keep = sorted({0, len(path) - 1})
    while len(keep) < MAX_PATH_KEYFRAMES:
        worst_error, worst_index = 0.002, None
        for a, b in zip(keep, keep[1:]):
            t0, x0, y0 = path[a]
            t1, x1, y1 = path[b]
            for i in range(a + 1, b):
                t, x, y = path[i]
                fraction = (t - t0) / (t1 - t0)
                error = max(abs(x - (x0 + (x1 - x0) * fraction)),
                            abs(y - (y0 + (y1 - y0) * fraction)))
                if error > worst_error:
                    worst_error, worst_index = error, i
        if worst_index is None:
            break
        keep.append(worst_index)
        keep.sort()
    return [path[i] for i in keep]


def apply_style(shot: ShotLayout, style: str, src_w: int, src_h: int) -> ShotLayout:
    """Adjust a detected layout to the user's chosen framing style."""
    shot.detected_layout = shot.detected_layout or shot.layout
    if shot.content_box is not None:
        return shot
    if style == LayoutStyle.FIT:
        shot.layout = LayoutType.SCREEN
        shot.source = "style"
    elif style == LayoutStyle.FILL:
        if shot.layout in (LayoutType.TWO_SHOT, LayoutType.SCREEN_CAM, LayoutType.SCREEN):
            focus = shot.people[0] if shot.people else None
            if shot.layout == LayoutType.SCREEN_CAM and shot.cam_face:
                focus = None  # a tiny webcam blown up to full frame looks bad
            shot.layout = LayoutType.TALKING_HEAD
            shot.source = "style"
            if focus and not shot.focus_path:
                shot.focus_path = [(0, focus.cx, focus.cy)]
            elif not shot.focus_path:
                shot.focus_path = [(0, 0.5, 0.5)]
    return shot


# ------------------------------------------------------------------
# Vision refinement
# ------------------------------------------------------------------

VISION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "layout": {"type": "string", "enum": list(LayoutType.ALL)},
        "cam_box": {
            "type": "array", "items": {"type": "integer"},
            "description": "Webcam overlay [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "screen_box": {
            "type": "array", "items": {"type": "integer"},
            "description": "Screen/app content region [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "screen_focus": {
            "type": "array", "items": {"type": "integer"},
            "description": "Most important area inside the screen [ymin, xmin, ymax, xmax] 0-1000, or [] if none.",
        },
        "people": {
            "type": "array",
            "items": {"type": "array", "items": {"type": "integer"}},
            "description": "Head-and-shoulders box [ymin, xmin, ymax, xmax] 0-1000 for each on-camera person (not inside the webcam overlay).",
        },
    },
    "required": ["layout", "cam_box", "screen_box", "screen_focus", "people"],
    "additionalProperties": False,
}

VISION_PROMPT = """You are framing a frame from a video for a 9:16 vertical short.

Classify the frame's layout:
- "talking_head": one person on camera fills a meaningful part of the frame (no screen recording).
- "two_shot": two people on camera, e.g. a podcast wide shot.
- "screen_cam": a screen recording, slides, browser, code or gameplay WITH a webcam overlay of the presenter.
- "screen": screen content, graphics or b-roll with NO webcam overlay, or a crowd/group where no single framing works.

Return boxes as [ymin, xmin, ymax, xmax] integers from 0 to 1000 relative to the full frame:
- cam_box: the ENTIRE webcam overlay rectangle (its visible border/edges, including background around the person), not just the face. [] if there is no webcam overlay.
- screen_box: the region holding the screen/app content, excluding black bars and the webcam overlay if it sits outside the screen. [] if there is no screen content.
- screen_focus: inside screen_box, the COMPLETE meaningful content block the viewer needs: an entire paragraph/code example, chart including axes and labels, document pane, chat exchange, or game view. Include the start and end of text lines and necessary headings. Never select just a word, glyph, cursor or unlabeled value. Leave out unrelated toolbars and empty space. This region will be fitted intact into the phone panel, not cropped to fill it. [] if the whole screen matters equally or the relevant block is uncertain.
- people: one head-and-shoulders box per on-camera person, left to right. Exclude people inside the webcam overlay and people shown inside screen content.

Detected faces (normalized x, y, w, h, may be incomplete): {faces}"""


def _box_from_1000(values: list[int]) -> Optional[Box]:
    if not isinstance(values, list) or len(values) != 4:
        return None
    try:
        ymin, xmin, ymax, xmax = (min(1000, max(0, int(v))) / 1000 for v in values)
    except (TypeError, ValueError):
        return None
    if xmax - xmin < 0.02 or ymax - ymin < 0.02:
        return None
    return Box(xmin, ymin, xmax - xmin, ymax - ymin)


def face_from_person_box(person: Box) -> Box:
    """Approximate the face inside a head-and-shoulders box.

    The renderer sizes crops from face boxes, so vision-model person boxes are
    converted to the same convention.
    """
    face_h = person.h * 0.45
    face_w = person.w * 0.5
    return Box(person.cx - face_w / 2, person.y + person.h * 0.08, face_w, face_h).clamp()


def merge_vision_result(heuristic: ShotLayout, result: dict, src_w: int, src_h: int) -> ShotLayout:
    """Combine the vision model's layout with locally detected faces."""
    layout = result.get("layout")
    if layout not in LayoutType.ALL:
        return heuristic

    cam = _box_from_1000(result.get("cam_box", []))
    screen = _box_from_1000(result.get("screen_box", []))
    people = [face_from_person_box(b) for b in (_box_from_1000(p) for p in result.get("people", [])) if b]
    people.sort(key=lambda b: b.cx)

    merged = ShotLayout(0, 0, layout, source="vision")
    if layout == LayoutType.SCREEN_CAM:
        if cam is None or not (0.01 <= cam.area <= 0.5):
            cam = heuristic.cam_box
        if cam is None:
            merged.layout = LayoutType.SCREEN
            return merged
        merged.cam_box = cam
        merged.screen_box = screen or screen_box_excluding_cam(cam)
        merged.screen_focus = _box_from_1000(result.get("screen_focus", []))
        # Prefer the locally detected face inside the cam for centering.
        face = heuristic.cam_face
        if face is None or not cam.contains(face.cx, face.cy):
            face = next((p for p in heuristic.people if cam.contains(p.cx, p.cy)), None)
        merged.cam_face = face
    elif layout == LayoutType.TWO_SHOT:
        local = heuristic.people if heuristic.layout == LayoutType.TWO_SHOT else []
        merged.people = local if len(local) == 2 else people[:2]
        if len(merged.people) < 2:
            merged.layout = LayoutType.TALKING_HEAD if merged.people else LayoutType.SCREEN
    elif layout == LayoutType.TALKING_HEAD:
        merged.people = heuristic.people[:1] if heuristic.people else people[:1]
        merged.focus_path = heuristic.focus_path
    elif layout == LayoutType.SCREEN:
        merged.screen_box = screen
        merged.screen_focus = _box_from_1000(result.get("screen_focus", []))
    return merged


# ------------------------------------------------------------------
# Service
# ------------------------------------------------------------------


class LayoutAnalyzer:
    """Analyzes a clip's shots and picks a 9:16 framing per shot."""

    def __init__(self):
        self.settings = get_settings()
        # One YuNet detector per executor thread: clips render concurrently,
        # and a shared detector's input size/buffers race (OpenCV 5 asserts).
        self._local = threading.local()
        self._http_client: Optional[httpx.AsyncClient] = None
        # Reuse vision answers across clips of the same video: (hist, face signature, result)
        self._vision_cache: list[tuple[Any, tuple, dict, dict]] = []

    @property
    def available(self) -> bool:
        return cv2 is not None and os.path.isfile(self._model_path())

    def _model_path(self) -> str:
        return os.path.abspath(os.path.join(
            os.path.dirname(__file__), "..", "..", "assets", "models",
            "face_detection_yunet_2023mar.onnx",
        ))

    async def analyze(
        self,
        video_path: str,
        start_ms: int,
        duration_ms: int,
        src_w: int,
        src_h: int,
        style: str = LayoutStyle.AUTO,
        vision: bool = True,
        capture: bool = False,
    ) -> Optional[ClipLayoutPlan]:
        """Plan the framing for the render window [start_ms, start_ms + duration_ms).

        `vision=False` skips the paid vision model: heuristics only, used when
        the plan only informs pacing (Classic style, 16:9 output).
        """
        if style == LayoutStyle.FIT:
            return ClipLayoutPlan(
                shots=[ShotLayout(0, duration_ms, LayoutType.SCREEN, source="style")],
                source_width=src_w, source_height=src_h,
            )
        if not self.available:
            logger.warning("Layout analysis unavailable (OpenCV or face model missing); using letterbox")
            return None

        loop = asyncio.get_running_loop()
        frames, keyframes = await loop.run_in_executor(
            None, self._decode_and_detect, video_path, start_ms, duration_ms, src_w, src_h,
        )
        if not frames:
            logger.warning("Layout analysis decoded no frames; using letterbox")
            return None

        shots: list[ShotLayout] = []
        vision_cost = 0.0
        trace = {"samples": [], "boundaries": [], "decisions": []} if capture else None
        color_segments = segment_shots(frames, duration_ms)
        inset_cuts = content_boundaries(frames)
        # Padding boundaries carry geometric evidence even when the color-cut
        # debouncer swallowed a short shot. Prefer their observed timestamps
        # to nearby histogram midpoints to avoid tiny duplicate segments.
        cuts = {0, duration_ms, *inset_cuts}
        cuts.update(a for a, _ in color_segments[1:] if all(abs(a - t) > 250 for t in inset_cuts))
        cuts = sorted(cuts)
        color_segments = list(zip(cuts, cuts[1:]))
        if trace is not None:
            accepted_cuts = {a for a, _ in color_segments[1:]}
            for i, frame in enumerate(frames):
                distance = float(cv2.compareHist(frames[i - 1].hist, frame.hist, cv2.HISTCMP_BHATTACHARYYA)) if i else None
                trace["samples"].append({"t_ms": frame.t_ms,
                    "faces": [{"box": box.to_list(), "score": frame.scores[j] if j < len(frame.scores) else None}
                              for j, box in enumerate(frame.faces)],
                    "content_box": frame.content_box.to_list() if frame.content_box else None,
                    "evidence": frame_layout_evidence(frame), "histogram_distance": distance})
                if distance is not None and distance > SHOT_CUT_THRESHOLD:
                    t = (frames[i - 1].t_ms + frame.t_ms) // 2
                    trace["boundaries"].append({"t_ms": t, "kind": "scene", "accepted": t in accepted_cuts,
                                                "distance": distance})
            trace["boundaries"].extend({"t_ms": t, "kind": "content", "accepted": True} for t in inset_cuts)

        segments = []
        for start, end in color_segments:
            local_frames = [f for f in frames if start <= f.t_ms < end]
            # Faces coming and going inside a stable inset do not change the
            # composition of that inset.
            inset = segment_content_box(local_frames)
            segments.extend([(start, end)] if inset else split_layout_segments(
                local_frames, start, end, trace["boundaries"] if trace is not None else None))

        for shot_start, shot_end in segments:
            shot_frames = [f for f in frames if shot_start <= f.t_ms < shot_end]
            decision = {"start_ms": shot_start, "end_ms": shot_end, "tracks": [],
                        "vision": {"status": "disabled" if not vision or not self._vision_enabled() else "unavailable"}} if capture else None
            shot = heuristic_layout(shot_frames, shot_start, shot_end, src_w, src_h, decision)
            if decision is not None:
                decision["heuristic"] = shot.summary()
            reference_ms = (shot_start + shot_end) // 2

            if shot.content_box is not None and decision is not None:
                decision["vision"] = {"status": "content_region"}
            if vision and self._vision_enabled() and shot.content_box is None:
                keyframe = self._pick_keyframe(keyframes, reference_ms, shot_start, shot_end)
                if decision is not None:
                    decision["vision"] = {"status": "no_image"}
                if keyframe is not None:
                    reference_ms, image = keyframe
                    # Face hints and the cache signature must describe the
                    # image being sent, not faces pooled from other moments.
                    reference_frame = min(shot_frames, key=lambda f: abs(f.t_ms - reference_ms))
                    if decision is not None:
                        decision["vision"] = {"status": "failed", "t_ms": reference_ms,
                                              "source_ms": start_ms + reference_ms}
                        result, cost = await self._vision_classify(image, [reference_frame], shot, decision["vision"])
                    else:
                        result, cost = await self._vision_classify(image, [reference_frame], shot)
                    vision_cost += cost
                    if result:
                        refined = merge_vision_result(shot, result, src_w, src_h)
                        if decision is not None:
                            decision["vision"]["validated"] = refined.summary()
                        if refined.layout == LayoutType.TALKING_HEAD and not refined.focus_path:
                            focus = refined.people[0] if refined.people else None
                            refined.focus_path = [(0, focus.cx, focus.cy)] if focus else [(0, 0.5, 0.5)]
                        shot = refined

            shot.start_ms, shot.end_ms = shot_start, shot_end
            if shot.layout == LayoutType.SCREEN_CAM:
                sub_shots = self._follow_webcam(shot, shot_frames, src_w, src_h, reference_ms)
                self._refine_webcam_regions(sub_shots, keyframes, shot.cam_box)
            else:
                sub_shots = [shot]
            shots.extend(apply_style(sub, style, src_w, src_h) for sub in sub_shots)
            if trace is not None:
                for before, after in zip(sub_shots, sub_shots[1:]):
                    if before.layout != after.layout:
                        trace["boundaries"].append({"t_ms": after.start_ms, "kind": "layout", "accepted": True,
                                                   "from_layout": before.layout, "to_layout": after.layout})
                trace["decisions"].append(decision)

        shots = self._merge_adjacent(shots)
        plan = ClipLayoutPlan(
            shots=shots, source_width=src_w, source_height=src_h, vision_cost_usd=vision_cost,
            face_samples=[(f.t_ms, f.faces) for f in frames],
            trace=trace,
        )
        logger.info(
            "Layout plan: " + ", ".join(
                f"{s.layout}[{s.start_ms / 1000:.1f}-{s.end_ms / 1000:.1f}s,{s.source}]" for s in shots
            ) + (f" (vision ${vision_cost:.4f})" if vision_cost else "")
        )
        return plan

    @staticmethod
    def _refine_webcam_regions(shots: list[ShotLayout], keyframes: list[tuple[int, bytes]], reference: Box):
        """Confirm camera edges locally; face motion alone cannot move them."""
        for shot in shots:
            if shot.layout != LayoutType.SCREEN_CAM or shot.cam_box is None:
                continue
            mid = (shot.start_ms + shot.end_ms) // 2
            images = sorted((k for k in keyframes if shot.start_ms <= k[0] < shot.end_ms),
                            key=lambda k: abs(k[0] - mid))[:3]
            decoded = [cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR) for _, data in images]
            decoded = [image for image in decoded if image is not None]
            if not decoded:
                continue
            # Try the original camera region first. Leaning or turning one's
            # head can otherwise scale/translate a stationary overlay.
            for guess in [reference, shot.cam_box]:
                matches = [box for image in decoded
                           if (box := refine_cam_box(image, guess, shot.cam_face)) is not None]
                if len(matches) < min(2, len(decoded)):
                    continue
                box = Box(*(median(getattr(b, axis) for b in matches) for axis in ('x', 'y', 'w', 'h')))
                if any(max(abs(a - b) for a, b in zip(box.to_list(), candidate.to_list())) > .015
                       for candidate in matches):
                    continue
                shot.cam_box, shot.cam_box_refined = box, True
                break

    @staticmethod
    def _follow_webcam(
        shot: ShotLayout, frames: list[FrameInfo], src_w: int, src_h: int,
        reference_ms: Optional[int] = None,
    ) -> list[ShotLayout]:
        """Split a screen+webcam shot where the overlay moves, resizes or disappears."""
        cam = shot.cam_box
        vision = shot.source == "vision"
        seed = shot.cam_face or Box(cam.cx - cam.w * 0.15, cam.cy - cam.h * 0.25, cam.w * 0.3, cam.h * 0.4)
        segments = split_overlay_segments(
            frames, shot.start_ms, shot.end_ms, seed, region=cam if vision else None,
        )

        # Anchor the webcam box to the segment the vision model actually saw.
        mid = reference_ms if reference_ms is not None else (shot.start_ms + shot.end_ms) // 2
        ref_face = next((f for a, b, f in segments if a <= mid < b and f), None) or shot.cam_face

        # Keep these confirmed edits separate from overlay/dropout smoothing:
        # that code deliberately absorbs short segments and preserves a vision
        # camera during missed detections, which otherwise hides punch-ins.
        expanded = expanded_webcam_intervals(frames, cam, shot.end_ms)
        for start, end, face in segments:
            local_frames = [f for f in frames if start <= f.t_ms < end]
            # Preserve the existing central-speaker evidence over its full
            # interval; a noisy scale threshold must not fragment a known
            # talking-head shot or restore the stale camera at its edges.
            speaker_frames = [f for f in local_frames if frame_layout_evidence(f) == LayoutType.TALKING_HEAD]
            if (face is None and (not vision or not start <= mid < end)
                    and len(speaker_frames) >= LAYOUT_CHANGE_SAMPLES
                    and len(speaker_frames) >= 0.7 * len(local_frames)
                    and speaker_frames[-1].t_ms - speaker_frames[0].t_ms >= LAYOUT_CHANGE_MS):
                expanded.append((start, end))
        merged = []
        for start, end in sorted(expanded):
            if merged and start <= merged[-1][1]:
                merged[-1] = (merged[-1][0], max(end, merged[-1][1]))
            else:
                merged.append((start, end))
        expanded = merged
        cuts = sorted({shot.start_ms, shot.end_ms,
                       *(t for a, b, _ in segments for t in (a, b)
                         if not any(start < t < end for start, end in expanded)),
                       *(t for a, b in expanded for t in (a, b))})
        segments = [(a, b, next(face for start, end, face in segments if start <= a < end))
                    for a, b in zip(cuts, cuts[1:])]

        result = []
        for start, end, face in segments:
            local_frames = [f for f in frames if start <= f.t_ms < end]
            if any(a <= start < b for a, b in expanded):
                result.append(heuristic_layout(local_frames, start, end, src_w, src_h))
                continue
            if face is None and vision:
                # The vision model saw the webcam; YuNet missing its face
                # (profile, lighting, a big close-up) doesn't remove it.
                result.append(ShotLayout(
                    start, end, LayoutType.SCREEN_CAM, source=shot.source,
                    screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                    cam_box=cam, cam_face=shot.cam_face,
                ))
                continue
            if face is None:
                result.append(ShotLayout(
                    start, end, LayoutType.SCREEN, source=shot.source,
                    screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                ))
                continue
            if vision and ref_face is not None:
                cam_box = transfer_cam_box(cam, ref_face, face)
            elif vision and cam.contains(face.cx, face.cy):
                cam_box = cam
            else:
                cam_box = estimate_cam_box(face, src_w, src_h)
            result.append(ShotLayout(
                start, end, LayoutType.SCREEN_CAM, source=shot.source,
                screen_box=shot.screen_box, screen_focus=shot.screen_focus,
                cam_box=cam_box, cam_face=face,
            ))
        return result

    # -- decoding & detection -------------------------------------------------

    def _decode_and_detect(
        self, video_path: str, start_ms: int, duration_ms: int, src_w: int, src_h: int,
    ) -> tuple[list[FrameInfo], list[tuple[int, bytes]]]:
        width, height = analysis_dimensions(src_w, src_h)
        if not 0 < duration_ms <= MAX_ANALYSIS_DURATION_MS or start_ms < 0:
            raise MediaProcessError("Layout analysis window exceeds supported limits")
        frame_limit = min(MAX_ANALYSIS_FRAMES, math.ceil(duration_ms / 1000 * ANALYSIS_FPS) + 1)
        cmd = [
            "ffmpeg", "-nostdin", "-v", "error",
            "-ss", f"{start_ms / 1000:.3f}",
            "-protocol_whitelist", "file,pipe,fd", "-format_whitelist", "mov,matroska,webm,avi,flv,mpegts", "-i", video_path,
            "-t", f"{duration_ms / 1000:.3f}",
            "-vf", f"fps={ANALYSIS_FPS},scale={width}:{height}",
            "-f", "rawvideo", "-pix_fmt", "bgr24", "-",
        ]
        detector = self._get_detector(width, height)
        frame_bytes = width * height * 3
        frames: list[FrameInfo] = []
        keyframes: list[tuple[int, bytes]] = []
        keyframe_every = max(1, int(round(ANALYSIS_FPS / KEYFRAME_FPS)),
                             math.ceil(frame_limit / MAX_RETAINED_KEYFRAMES))
        keyframe_bytes = 0

        with media_process(cmd, timeout=30 * 60) as (proc, _stderr):
            index = 0
            while True:
                raw = proc.stdout.read(frame_bytes)
                if not raw:
                    break
                if len(raw) != frame_bytes:
                    raise MediaProcessError("Incomplete layout analysis frame")
                if index >= frame_limit:
                    raise MediaProcessError("Layout analysis exceeds the frame limit")
                image = np.frombuffer(raw, np.uint8).reshape(height, width, 3)
                t_ms = int(index * 1000 / ANALYSIS_FPS)

                _, faces = detector.detect(image)
                boxes = []
                scores = []
                candidates = sorted(faces, key=lambda row: float(row[14]), reverse=True)[:MAX_FACES_PER_FRAME] if faces is not None else []
                for row in candidates:
                    if float(row[14]) < FACE_SCORE_THRESHOLD:
                        continue
                    x, y, w, h = (float(v) for v in row[:4])
                    boxes.append(Box(x / width, y / height, w / width, h / height).clamp())
                    scores.append(float(row[14]))

                hsv = cv2.cvtColor(cv2.resize(image, (160, 90)), cv2.COLOR_BGR2HSV)
                hist = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
                cv2.normalize(hist, hist)
                frames.append(FrameInfo(t_ms=t_ms, faces=boxes, hist=hist, scores=scores,
                                        content_box=detect_content_box(image)))

                if index % keyframe_every == 0:
                    ok, jpg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
                    if ok:
                        encoded = jpg.tobytes()
                        if len(encoded) > MAX_KEYFRAME_BYTES - keyframe_bytes:
                            raise MediaProcessError("Layout keyframes exceed the size limit")
                        keyframe_bytes += len(encoded)
                        keyframes.append((t_ms, encoded))
                index += 1
        if proc.returncode:
            raise MediaProcessError("Layout decoding failed")
        return frames, keyframes

    def _get_detector(self, width: int, height: int):
        detector = getattr(self._local, "detector", None)
        if detector is None:
            detector = cv2.FaceDetectorYN.create(
                self._model_path(), "", (width, height), FACE_SCORE_THRESHOLD, 0.3, 50,
            )
            self._local.detector = detector
        detector.setInputSize((width, height))
        return detector

    @staticmethod
    def _pick_keyframe(
        keyframes: list[tuple[int, bytes]], t_ms: int, start_ms: int, end_ms: int,
    ) -> Optional[tuple[int, bytes]]:
        # Never borrow an image from the other side of a layout transition.
        candidates = [k for k in keyframes if start_ms <= k[0] < end_ms]
        if not candidates:
            return None
        return min(candidates, key=lambda k: abs(k[0] - t_ms))

    @staticmethod
    def _merge_adjacent(shots: list[ShotLayout]) -> list[ShotLayout]:
        """Join neighbouring shots that ended up with the same static framing."""
        merged: list[ShotLayout] = []
        for shot in shots:
            prev = merged[-1] if merged else None
            same_static = (
                prev is not None
                and prev.layout == shot.layout
                and prev.content_box == shot.content_box
                and prev.cam_box_refined == shot.cam_box_refined
                and (not shot.cam_box_refined or prev.cam_box == shot.cam_box)
                and shot.layout in (LayoutType.SCREEN, LayoutType.SCREEN_CAM)
                and (shot.layout == LayoutType.SCREEN or (
                    prev.cam_box and shot.cam_box
                    and abs(prev.cam_box.cx - shot.cam_box.cx) < 0.05
                    and abs(prev.cam_box.cy - shot.cam_box.cy) < 0.05
                    and 0.85 <= shot.cam_box.h / max(prev.cam_box.h, 1e-6) <= 1.18
                ))
            )
            if same_static:
                prev.end_ms = shot.end_ms
            else:
                merged.append(shot)
        return merged

    # -- vision ---------------------------------------------------------------

    def _vision_enabled(self) -> bool:
        return bool(self.settings.layout_vision_enabled and self.settings.openrouter_api_key)

    async def _vision_classify(
        self, keyframe: bytes, shot_frames: list[FrameInfo], heuristic: ShotLayout,
        diagnostic: Optional[dict] = None,
    ) -> tuple[Optional[dict], float]:
        """Ask the vision model about one keyframe; cached per visual setup."""
        signature = (heuristic.layout, tuple(sorted(
            (round(b.cx, 1), round(b.cy, 1), round(b.w, 1), round(b.h, 1))
            for f in shot_frames for b in framing_faces(f)
        )))
        image = cv2.imdecode(np.frombuffer(keyframe, np.uint8), cv2.IMREAD_COLOR)
        hsv = cv2.cvtColor(cv2.resize(image, (160, 90)), cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [24, 16], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        for cached_hist, cached_sig, cached, provenance in self._vision_cache:
            if cached_sig == signature and cv2.compareHist(hist, cached_hist, cv2.HISTCMP_BHATTACHARYYA) < 0.2:
                if diagnostic is not None:
                    diagnostic.update({**provenance, "status": "success", "cache_hit": True})
                return cached, 0.0

        faces = sorted(
            {tuple(round(v, 3) for v in b.to_list()) for f in shot_frames[:: max(1, len(shot_frames) // 4)] for b in framing_faces(f)}
        )[:6]
        payload: dict[str, Any] = {
            "model": self.settings.layout_vision_model,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": VISION_PROMPT.replace("{faces}", json.dumps(faces) or "[]")},
                    {"type": "image_url", "image_url": {
                        "url": "data:image/jpeg;base64," + base64.b64encode(keyframe).decode(),
                    }},
                ],
            }],
            "max_tokens": 4000,
            "response_format": json_schema_format("frame_layout", VISION_SCHEMA),
            "provider": {"require_parameters": True},
        }
        fallbacks = self.settings.get_layout_vision_fallback_models()
        if fallbacks:
            payload["models"] = fallbacks
        apply_reasoning(payload, self.settings.layout_vision_reasoning_effort, temperature=0.0)

        client = await self._get_client()
        for attempt in range(2):
            try:
                body, usage = await chat_completion(client, payload)
                content, _ = message_text(body)
                result = json.loads(content or "")
                provenance = {"cache_id": hashlib.sha256(keyframe).hexdigest()[:16],
                              "cache_source_ms": diagnostic.get("source_ms") if diagnostic else None,
                              "model": str(body.get("model") or self.settings.layout_vision_model)[:120]}
                self._vision_cache.append((hist, signature, result, provenance))
                if diagnostic is not None:
                    diagnostic.update({**provenance, "status": "success", "cache_hit": False})
                return result, usage.get("cost") or 0.0
            except OpenRouterError as e:
                if not e.retryable or attempt == 1:
                    logger.warning(f"Layout vision failed, using heuristics: {e}")
                    return None, 0.0
                await asyncio.sleep(1.5)
            except (json.JSONDecodeError, TypeError) as e:
                logger.warning(f"Layout vision returned invalid JSON, using heuristics: {e}")
                return None, 0.0
        return None, 0.0

    async def _get_client(self) -> httpx.AsyncClient:
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                base_url=self.settings.openrouter_base_url,
                timeout=httpx.Timeout(120.0, connect=20.0),
                headers={
                    "Authorization": f"Bearer {self.settings.openrouter_api_key}",
                    "HTTP-Referer": "https://github.com/bridge-mind/bridgeclip",
                    "X-Title": "BridgeClip AI Clipping Agent",
                },
            )
        return self._http_client

    async def close(self) -> None:
        if self._http_client:
            await self._http_client.aclose()
