"""Temporal framing regressions; no downloads or paid vision calls.

Face observations are supplied explicitly to isolate the planner from YuNet.
The render check passes the resulting plan through FFmpeg and measures the
subject marker in decoded output, rather than just checking filter strings.
"""

import asyncio
import json
import os
import shutil
import subprocess
from pathlib import Path

import cv2
import numpy as np
import pytest

from clip_engine.services import layout_analyzer as module
from clip_engine.services.layout_analyzer import (
    Box, FrameInfo, LayoutAnalyzer, LayoutType, ShotLayout, split_layout_segments,
)
from clip_engine.services.layout_renderer import build_layout_graph, shot_views


CAM_FACE = Box(0.08, 0.78, 0.05, 0.09)
CAM_BOX = Box(0.01, 0.65, 0.25, 0.33)
HEAD = Box(0.43, 0.20, 0.14, 0.30)
CAM_RESULT = {
    "layout": "screen_cam", "cam_box": [650, 10, 980, 260],
    "screen_box": [0, 0, 1000, 1000], "screen_focus": [], "people": [],
}
HEAD_RESULT = {
    "layout": "talking_head", "cam_box": [], "screen_box": [],
    "screen_focus": [], "people": [[100, 350, 700, 650]],
}


def observations(duration_ms, faces_at):
    # Identical histograms deliberately hide every layout cut from the old
    # color-only shot detector.
    hist = np.zeros((24, 16), np.float32)
    hist[1, 1] = 1
    return [FrameInfo(t, faces_at(t), hist) for t in range(0, duration_ms, 250)]


def analyze(monkeypatch, frames, duration_ms, vision=False, response=None, capture=False):
    analyzer = LayoutAnalyzer()
    keyframes = [(f.t_ms, str(f.t_ms).encode()) for f in frames if f.t_ms % 1000 == 0]
    monkeypatch.setattr(analyzer, "_decode_and_detect", lambda *_: (frames, keyframes))
    monkeypatch.setattr(analyzer, "_vision_enabled", lambda: True)
    calls = []

    async def classify(image, reference_frames, heuristic, diagnostic=None):
        t = int(image)
        assert len(reference_frames) == 1 and reference_frames[0].t_ms == t
        calls.append(t)
        answer = response(t) if response else (
            HEAD_RESULT if reference_frames[0].faces == [HEAD] else CAM_RESULT
        )
        return answer, 0.001

    monkeypatch.setattr(analyzer, "_vision_classify", classify)
    plan = asyncio.run(analyzer.analyze("fixture.mp4", 0, duration_ms, 1920, 1080, vision=vision, capture=capture))
    return plan, calls


def layout_at(plan, t):
    return next(s for s in plan.shots if s.start_ms <= t < s.end_ms)


@pytest.mark.parametrize("vision", [False, True])
@pytest.mark.parametrize("ranges", [
    [(12000, 16000)],                         # full-screen minority
    [(4000, 16000)],                          # full-screen majority
    [(4000, 8000), (12000, 16000)],            # repeated transitions
    [(0, 4000), (8000, 12000), (16000, 20000)], # starts/ends full-screen
])
def test_reclassifies_each_layout_even_without_color_cuts(monkeypatch, vision, ranges):
    def faces_at(t):
        return [HEAD if any(a <= t < b for a, b in ranges) else CAM_FACE]
    frames = observations(20000, faces_at)
    plan, calls = analyze(monkeypatch, frames, 20000, vision)
    assert plan.shots[0].start_ms == 0 and plan.shots[-1].end_ms == 20000
    assert all(a.end_ms == b.start_ms for a, b in zip(plan.shots, plan.shots[1:]))
    for frame in frames:
        shot = layout_at(plan, frame.t_ms)
        expected = LayoutType.TALKING_HEAD if frame.faces == [HEAD] else LayoutType.SCREEN_CAM
        assert shot.layout == expected, (frame.t_ms, shot.layout)
        # At least one source crop must retain the subject's whole face.
        face = frame.faces[0]
        retained = []
        for (x, y, w, h), _ in shot_views(shot, frame.t_ms, 1920, 1080, 1080, 1920):
            overlap_w = max(0, min(x + w, (face.x + face.w) * 1920) - max(x, face.x * 1920))
            overlap_h = max(0, min(y + h, (face.y + face.h) * 1080) - max(y, face.y * 1080))
            retained.append(overlap_w * overlap_h / (face.area * 1920 * 1080))
        assert max(retained) >= 0.95, (frame.t_ms, shot.layout, retained)
    if vision:
        assert len(calls) == len(plan.shots)
        assert all(shot.start_ms <= t < shot.end_ms for shot, t in zip(plan.shots, calls))
        assert plan.vision_cost_usd == pytest.approx(len(calls) * 0.001)
    else:
        assert calls == []


@pytest.mark.parametrize("interruption", [[], [HEAD], [Box(0.08, 0.70, 0.07, 0.18)]])
def test_brief_dropouts_false_detections_and_leaning_do_not_switch_layout(monkeypatch, interruption):
    frames = observations(8000, lambda t: interruption if 4000 <= t < 4500 else [CAM_FACE])
    plan, calls = analyze(monkeypatch, frames, 8000, vision=True, response=lambda _: CAM_RESULT)
    assert all(s.layout == LayoutType.SCREEN_CAM for s in plan.shots)
    assert calls == [4000]


def test_faces_in_screen_content_do_not_displace_visible_corner_webcam(monkeypatch):
    frames = observations(8000, lambda t: [CAM_FACE, HEAD] if t >= 4000 else [CAM_FACE])
    plan, calls = analyze(monkeypatch, frames, 8000, vision=True, response=lambda _: CAM_RESULT)
    assert all(s.layout == LayoutType.SCREEN_CAM for s in plan.shots)
    assert len(calls) == 1


def test_transition_after_a_fade_or_detection_gap(monkeypatch):
    frames = observations(10000, lambda t: [CAM_FACE] if t < 4000 else ([] if t < 4500 else [HEAD]))
    plan, _ = analyze(monkeypatch, frames, 10000)
    assert layout_at(plan, 3750).layout == LayoutType.SCREEN_CAM
    assert layout_at(plan, 4500).layout == LayoutType.TALKING_HEAD


def test_gradual_webcam_expansion_eventually_switches_to_speaker(monkeypatch):
    def faces_at(t):
        fraction = min(1, max(0, (t - 4000) / 2000))
        return [Box(*(a + (b - a) * fraction for a, b in zip(CAM_FACE.to_list(), HEAD.to_list())))]
    frames = observations(10000, faces_at)
    plan, _ = analyze(monkeypatch, frames, 10000)
    assert layout_at(plan, 3000).layout == LayoutType.SCREEN_CAM
    assert layout_at(plan, 6000).layout == LayoutType.TALKING_HEAD
    assert all(layout_at(plan, t).layout == LayoutType.TALKING_HEAD for t in range(6000, 10000, 250))


def test_confirmed_short_layout_is_not_merged_as_histogram_blip(monkeypatch):
    frames = observations(8000, lambda t: [HEAD] if 4000 <= t < 4750 else [CAM_FACE])
    plan, _ = analyze(monkeypatch, frames, 8000)
    assert [(s.start_ms, s.end_ms, s.layout) for s in plan.shots] == [
        (0, 4000, LayoutType.SCREEN_CAM), (4000, 4750, LayoutType.TALKING_HEAD),
        (4750, 8000, LayoutType.SCREEN_CAM),
    ]


def test_persistent_missing_face_gets_fresh_vision_decision(monkeypatch):
    frames = observations(10000, lambda t: [] if 4000 <= t < 7000 else [CAM_FACE])
    screen = {**CAM_RESULT, "layout": "screen", "cam_box": []}
    plan, calls = analyze(monkeypatch, frames, 10000, vision=True,
                          response=lambda t: screen if 4000 <= t < 7000 else CAM_RESULT)
    assert [s.layout for s in plan.shots] == ["screen_cam", "screen", "screen_cam"]
    assert len(calls) == 3


def test_persistent_detector_miss_can_still_be_confirmed_as_webcam(monkeypatch):
    frames = observations(10000, lambda t: [] if 4000 <= t < 7000 else [CAM_FACE])
    plan, calls = analyze(monkeypatch, frames, 10000, vision=True, response=lambda _: CAM_RESULT)
    assert all(s.layout == LayoutType.SCREEN_CAM for s in plan.shots)
    assert len(calls) == 3


def test_no_image_inside_short_segment_uses_heuristics_without_neighbor_vision(monkeypatch):
    frames = observations(8000, lambda t: [HEAD] if 4250 <= t < 5000 else [CAM_FACE])
    plan, calls = analyze(monkeypatch, frames, 8000, vision=True)
    shot = layout_at(plan, 4500)
    assert shot.layout == LayoutType.TALKING_HEAD and shot.source == "heuristic"
    assert all(not 4250 <= t < 5000 for t in calls)


def test_fullscreen_evidence_overrides_stale_webcam_box():
    frames = observations(20000, lambda t: [HEAD] if 12000 <= t < 16000 else [CAM_FACE])
    shot = ShotLayout(0, 20000, LayoutType.SCREEN_CAM, source="vision",
                      cam_box=CAM_BOX, cam_face=CAM_FACE, screen_box=Box(0, 0, 1, 1))
    shots = LayoutAnalyzer._follow_webcam(shot, frames, 1920, 1080)
    assert [(s.start_ms, s.end_ms, s.layout) for s in shots] == [
        (0, 12000, "screen_cam"), (12000, 16000, "talking_head"), (16000, 20000, "screen_cam"),
    ]
    assert shots[1].focus_path[0][1:] == (HEAD.cx, HEAD.cy)


def test_current_vision_can_identify_face_as_shared_content():
    # Vision saw an actual webcam, but YuNet only found a large face in the
    # shared video. A fresh image from this interval can resolve that ambiguity.
    frames = observations(6000, lambda _: [HEAD])
    shot = ShotLayout(0, 6000, LayoutType.SCREEN_CAM, source="vision",
                      cam_box=CAM_BOX, screen_box=Box(0, 0, 1, 1))
    shots = LayoutAnalyzer._follow_webcam(shot, frames, 1920, 1080, reference_ms=3000)
    assert [s.layout for s in shots] == [LayoutType.SCREEN_CAM]
    assert shots[0].cam_box == CAM_BOX


RIGHT_SMALL = Box(.845, .53, .09, .20)
RIGHT_LARGE = Box(.72, .20, .145, .34)
RIGHT_CAM = Box(.672, .476, .328, .524)


@pytest.mark.parametrize("mirror", [False, True])
@pytest.mark.parametrize("reference_ms", [1000, 5000, 9000])
def test_side_presenter_punch_in_switches_to_single_view_and_back(mirror, reference_ms):
    def flip(box):
        return Box(1 - box.x - box.w, box.y, box.w, box.h) if mirror else box
    small, large, cam = map(flip, (RIGHT_SMALL, RIGHT_LARGE, RIGHT_CAM))
    frames = observations(10000, lambda t: [large if 4000 <= t < 7000 else small])
    shot = ShotLayout(0, 10000, LayoutType.SCREEN_CAM, source="vision",
                      cam_box=cam, cam_face=small, screen_box=Box(0, 0, 1, 1))
    shots = LayoutAnalyzer._follow_webcam(shot, frames, 3840, 2160, reference_ms)
    assert [(s.start_ms, s.end_ms, s.layout) for s in shots] == [
        (0, 4000, "screen_cam"), (4000, 7000, "talking_head"), (7000, 10000, "screen_cam"),
    ]
    view = shot_views(shots[1], 5000, 3840, 2160, 1080, 1920)
    assert len(view) == 1
    (x, y, w, h), destination = view[0]
    assert x <= large.x * 3840 < (large.x + large.w) * 3840 <= x + w
    assert y <= large.y * 2160 < (large.y + large.h) * 2160 <= y + h
    assert destination == (0, 0, 1080, 1920)


@pytest.mark.parametrize("faces", [[], [RIGHT_LARGE], [RIGHT_SMALL, RIGHT_LARGE]])
def test_webcam_expansion_ignores_brief_changes_and_shared_screen_faces(faces):
    # Two samples are insufficient; even a sustained second face must not
    # displace the still-visible webcam.
    end = 8000 if len(faces) == 2 else 4500
    frames = observations(10000, lambda t: faces if 4000 <= t < end else [RIGHT_SMALL])
    assert module.expanded_webcam_intervals(frames, RIGHT_CAM, 10000) == []


def test_punch_in_works_when_vision_saw_the_enlarged_camera():
    frames = observations(10000, lambda t: [RIGHT_LARGE if 4000 <= t < 7000 else RIGHT_SMALL])
    # This larger vision region contains both positions. Expansion evidence
    # comes from the stable compact presenter, not the size of vision's box.
    shot = ShotLayout(0, 10000, LayoutType.SCREEN_CAM, source="vision",
                      cam_box=Box(.55, .12, .45, .88), cam_face=RIGHT_LARGE,
                      screen_box=Box(0, 0, 1, 1))
    shots = LayoutAnalyzer._follow_webcam(shot, frames, 3840, 2160, reference_ms=5000)
    assert next(s for s in shots if s.start_ms <= 5000 < s.end_ms).layout == "talking_head"


def test_recorded_punch_in_keeps_face_visible_and_returns_to_split(monkeypatch):
    fixture = json.loads((Path(__file__).parent / "fixtures/presenter_punch_in.json").read_text())
    frames = observations(fixture['duration_ms'], lambda _: [])
    for frame, sample in zip(frames, fixture['samples']):
        frame.faces = [Box(*f['box']) for f in sample['faces']]
        frame.scores = [f['score'] for f in sample['faces']]
    x, y, w, h = fixture['cam_box']
    response = {**CAM_RESULT, 'cam_box': [round(y*1000), round(x*1000), round((y+h)*1000), round((x+w)*1000)]}
    plan, calls = analyze(monkeypatch, frames, fixture['duration_ms'], vision=True,
                          response=lambda _: response, capture=True)
    assert len(calls) == 1  # relative geometry needs no extra paid classification
    assert any(b['t_ms'] == 5000 and b['to_layout'] == 'talking_head' for b in plan.trace['boundaries'])
    assert any(b['t_ms'] == 8750 and b['to_layout'] == 'screen_cam' for b in plan.trace['boundaries'])
    for frame in frames:
        t = frame.t_ms
        if t < 2250:
            assert layout_at(plan, t).layout == "talking_head", t
        if 5000 <= t < 8750:
            shot = layout_at(plan, t)
            assert shot.layout == "talking_head", t
            face = frame.faces[0]
            (x, y, w, h), _ = shot_views(shot, t, 3840, 2160, 1080, 1920)[0]
            retained = (max(0, min(x+w, (face.x+face.w)*3840)-max(x, face.x*3840))
                        * max(0, min(y+h, (face.y+face.h)*2160)-max(y, face.y*2160)))
            assert retained / (face.area * 3840 * 2160) >= .99, t
        elif 2500 <= t < 4750 or t >= 8750:
            assert layout_at(plan, t).layout == "screen_cam", t


def test_keyframe_selection_never_crosses_a_segment_boundary():
    frames = [(0, b"corner"), (1000, b"head"), (2000, b"corner")]
    assert LayoutAnalyzer._pick_keyframe(frames, 1800, 1250, 2000) is None
    assert LayoutAnalyzer._pick_keyframe(frames, 900, 750, 1750) == (1000, b"head")


def test_splits_with_nonzero_window_and_ignores_ambiguous_faces():
    frames = observations(8000, lambda t: [CAM_FACE] if t < 4000 else [HEAD])
    assert split_layout_segments(frames[8:], 1875, 8000) == [(1875, 4000), (4000, 8000)]
    ambiguous = observations(4000, lambda _: [Box(.45, .4, .05, .08)])
    assert split_layout_segments(ambiguous, 0, 4000) == [(0, 4000)]


def test_vision_cache_distinguishes_geometry_with_identical_colors(monkeypatch):
    analyzer = LayoutAnalyzer()
    calls = []
    async def completion(client, payload):
        calls.append(payload)
        return {"choices": [{"message": {"content": json.dumps(CAM_RESULT)}}]}, {"cost": 0.001}
    async def client():
        return object()
    monkeypatch.setattr(module, "chat_completion", completion)
    monkeypatch.setattr(analyzer, "_get_client", client)
    _, encoded = cv2.imencode(".jpg", np.zeros((90, 160, 3), np.uint8))
    shot = ShotLayout(0, 4000, LayoutType.SCREEN_CAM)
    async def exercise():
        results = []
        for face in (CAM_FACE, HEAD, HEAD):
            results.append(await analyzer._vision_classify(encoded.tobytes(), [FrameInfo(0, [face], None)], shot))
        return results
    results = asyncio.run(exercise())
    assert len(calls) == 2
    assert [cost for _, cost in results] == [0.001, 0.001, 0.0]
    hints = calls[0]["messages"][0]["content"][0]["text"].split("may be incomplete): ")[1]
    assert json.loads(hints) == [CAM_FACE.to_list()]


@pytest.mark.parametrize("side_punch_in", [False, True])
def test_rendered_transition_keeps_subject_visible(monkeypatch, tmp_path, side_punch_in):
    ffmpeg = os.environ.get("TEST_FFMPEG") or shutil.which("ffmpeg")
    if not ffmpeg:
        pytest.skip("ffmpeg not installed")
    width, height, fps, duration = 640, 360, 4, 6
    small, large = (RIGHT_SMALL, RIGHT_LARGE) if side_punch_in else (CAM_FACE, HEAD)
    frames = observations(duration * 1000, lambda t: [large] if 2000 <= t < 4000 else [small])
    result = {**CAM_RESULT, 'cam_box': [476, 672, 1000, 1000]}
    plan, _ = analyze(monkeypatch, frames, duration * 1000, vision=side_punch_in, response=lambda _: result)
    raw = tmp_path / "source.rgb"
    with raw.open("wb") as output:
        for frame in frames:
            pixels = np.zeros((height, width, 3), np.uint8)
            face = frame.faces[0]
            x, y, w, h = [int(v) for v in (face.x * width, face.y * height, face.w * width, face.h * height)]
            pixels[y:y+h, x:x+w] = (255, 0, 0)
            output.write(pixels.tobytes())
    # The plan normally carries decoded source dimensions; the fixture above
    # used 1920x1080, so set the actual synthetic video dimensions for rendering.
    plan.source_width, plan.source_height = width, height
    graph = build_layout_graph(plan, 180, 320, fps=str(fps))
    rendered = subprocess.run([
        ffmpeg, "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{width}x{height}",
        "-r", str(fps), "-i", str(raw), "-filter_complex", graph, "-map", "[base]",
        "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], check=True, capture_output=True, timeout=30).stdout
    output = np.frombuffer(rendered, np.uint8).reshape(-1, 320, 180, 3)
    assert len(output) == fps * duration
    for index, image in enumerate(output):
        red = (image[:, :, 0] > 180) & (image[:, :, 1] < 50) & (image[:, :, 2] < 50)
        assert red.sum() > 300, index
        if 2 * fps <= index < 4 * fps:
            # The full-screen subject occupies the central crop, not the old
            # lower-left webcam panel or a blank corner of the source.
            assert red[50:170, 30:150].sum() > 3000, index
