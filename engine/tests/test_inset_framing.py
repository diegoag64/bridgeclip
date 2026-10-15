"""Framing regressions for weak false faces and padded source inserts."""
import asyncio
import os
import shutil
import subprocess

import cv2
import numpy as np
import pytest

from clip_engine.services.layout_analyzer import (
    Box, ClipLayoutPlan, FrameInfo, LayoutAnalyzer, LayoutType, ShotLayout,
    content_boundaries, detect_content_box, heuristic_layout,
)
from clip_engine.services.layout_renderer import build_layout_graph, shot_views


def inset_frame(color=230, x=190, width=270):
    rng = np.random.default_rng(10)
    image = np.clip(color + rng.normal(0, 3, (360, 640, 3)), 0, 255).astype(np.uint8)
    image[20:340, x:x+width] = rng.integers(30, 170, (320, width, 3), np.uint8)
    return image


@pytest.mark.parametrize('color', [0, 230, 255])
def test_detects_black_white_and_textured_padding(color):
    box = detect_content_box(inset_frame(color))
    assert box is not None
    assert box.to_list() == pytest.approx([190/640, 20/360, 270/640, 320/360], abs=.012)


def test_ignores_plain_background_person_shapes_and_fullscreen_detail():
    wall = np.full((360, 640, 3), 230, np.uint8)
    assert detect_content_box(wall) is None
    cv2.ellipse(wall, (320, 180), (100, 165), 0, 0, 360, (60, 80, 150), -1)
    assert detect_content_box(wall) is None
    assert detect_content_box(np.random.default_rng(2).integers(0, 256, wall.shape, np.uint8)) is None
    # An inset placed against one edge does not have the required two margins.
    assert detect_content_box(inset_frame(x=0)) is None


def test_large_weak_lamp_detection_cannot_beat_confident_subject():
    lamp, person = Box(.24, 0, .20, .325), Box(.46, .35, .156, .36)
    frames = [FrameInfo(t, [person, lamp], None, [.94, .78]) for t in range(0, 1250, 250)]
    diagnostic = {}
    shot = heuristic_layout(frames, 0, 1250, 1920, 1080, diagnostic)
    assert shot.layout == LayoutType.TALKING_HEAD
    assert shot.people == [person]
    assert all(x == pytest.approx(person.cx) for _, x, _ in shot.focus_path)
    # Raw detector observations remain available, but only the real face is tracked.
    assert diagnostic['tracks'][0]['samples'] == [[t, 0] for t in range(0, 1250, 250)]
    assert len(frames[0].faces) == 2


def test_clear_faces_can_split_but_a_sole_weak_detection_keeps_the_frame():
    a, b = Box(.15, .2, .14, .3), Box(.65, .2, .14, .3)
    two = [FrameInfo(t, [a, b], None, [.96, .93]) for t in range(0, 4000, 250)]
    assert heuristic_layout(two, 0, 4000, 1920, 1080).layout == LayoutType.TWO_SHOT
    one = [FrameInfo(t, [a], None, [.82]) for t in range(0, 4000, 250)]
    assert heuristic_layout(one, 0, 4000, 1920, 1080).layout == LayoutType.SCREEN


def test_padding_transitions_ignore_blips_and_detect_changed_region():
    a, b = Box(.3, .05, .4, .9), Box(.2, .05, .6, .9)
    frames = [FrameInfo(t, [], None, content_box=(a if 1000 <= t < 3000 else b if 3000 <= t < 5000 else None))
              for t in range(0, 7000, 250)]
    frames[1].content_box = a  # isolated false positive
    frames[9].content_box = None  # brief detector miss inside a stable inset
    assert content_boundaries(frames) == [1000, 3000, 5000]


def test_inset_overrides_face_motion_and_gets_independent_transition(monkeypatch):
    box = detect_content_box(inset_frame())
    hist = np.zeros((24, 16), np.float32)
    hist[1, 1] = 1
    # Same color distribution; the old histogram and face-layout paths miss this.
    frames = [FrameInfo(t, [Box(.4 + .1 * (t % 500 == 0), .3, .15, .3)], hist, [.95],
                        box if 1250 <= t < 3500 else None) for t in range(0, 5000, 250)]
    analyzer = LayoutAnalyzer()
    monkeypatch.setattr(analyzer, '_decode_and_detect', lambda *_: (frames, []))
    monkeypatch.setattr(analyzer, '_vision_enabled', lambda: True)
    plan = asyncio.run(analyzer.analyze('fixture.mp4', 0, 5000, 640, 360, capture=True))
    assert [(s.start_ms, s.end_ms) for s in plan.shots] == [(0, 1250), (1250, 3500), (3500, 5000)]
    shot = plan.shots[1]
    assert shot.content_box == box
    assert shot.people == [] and shot.focus_path == []
    assert plan.trace['decisions'][1]['vision']['status'] == 'content_region'
    assert shot_views(shot, 1500, 640, 360, 180, 320) == shot_views(shot, 3000, 640, 360, 180, 320)
    assert plan.shots[2].content_box is None
    assert plan.shots[2].focus_path


def test_adjacent_insets_do_not_merge_with_fullscreen_or_other_geometry():
    box = Box(.3, .05, .4, .9)
    shots = [ShotLayout(0, 2000, LayoutType.SCREEN, content_box=box),
             ShotLayout(2000, 4000, LayoutType.SCREEN),
             ShotLayout(4000, 6000, LayoutType.SCREEN, content_box=box)]
    assert len(LayoutAnalyzer._merge_adjacent(shots)) == 3


def test_render_preserves_entire_inset_composition(tmp_path):
    ffmpeg = os.environ.get('TEST_FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('ffmpeg unavailable')
    image = np.full((360, 640, 3), 235, np.uint8)
    image[20:340, 190:460] = (25, 60, 80)
    # Markers on both edges must survive; centering only on a face would cut them.
    image[120:240, 195:215] = (255, 0, 0)
    image[120:240, 435:455] = (0, 255, 0)
    box = detect_content_box(image)
    assert box is not None
    plan = ClipLayoutPlan([ShotLayout(0, 1000, LayoutType.SCREEN, content_box=box)], 640, 360)
    raw = tmp_path / 'inset.rgb'
    raw.write_bytes(image.tobytes() * 4)
    rendered = subprocess.run([
        ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360',
        '-r', '4', '-i', str(raw), '-filter_complex', build_layout_graph(plan, 180, 320, fps='4'),
        '-map', '[base]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], capture_output=True, check=True, timeout=30)
    output = np.frombuffer(rendered.stdout, np.uint8).reshape(-1, 320, 180, 3)
    assert len(output) == 4
    for frame in output:
        red = (frame[:, :, 0] > 180) & (frame[:, :, 1] < 60)
        green = (frame[:, :, 1] > 180) & (frame[:, :, 0] < 60)
        assert red.sum() > 600 and green.sum() > 600
        assert np.where(red)[1].mean() < 25
        assert np.where(green)[1].mean() > 155


def test_inset_counts_as_smart_framing_and_overlays_use_actual_foreground():
    from clip_engine.services.layout_renderer import foreground_geometry, title_y, banner_y
    shot = ShotLayout(0, 4000, LayoutType.SCREEN, content_box=Box(.3, .05, .4, .9))
    plan = ClipLayoutPlan([shot], 640, 360)
    assert not plan.is_letterbox_only  # retain the safe letterbox fallback on render failure
    (_, _, _, _), (_, y, _, h) = shot_views(shot, 0, 640, 360, 1080, 1920)[0]
    assert foreground_geometry(shot, 640, 360, 1080, 1920) == (h, y)
    assert title_y(shot, 640, 360, 1080, 1920, 100) + 100 < y
    assert banner_y(shot, 640, 360, 1080, 1920) > y + h


def pillarbox_frame():
    """4:3 picture centered in 16:9 with black side bars (a common re-upload)."""
    rng = np.random.default_rng(3)
    image = np.zeros((360, 640, 3), np.uint8)
    image[:, 80:560] = cv2.GaussianBlur(rng.integers(60, 200, (360, 480, 3), np.uint8), (9, 9), 0)
    return image


def pillarbox_shot(x=.45, duration_ms=8000):
    box = detect_content_box(pillarbox_frame())
    assert box is not None and box.h == 1
    hist = np.zeros((24, 16), np.float32)
    hist[1, 1] = 1
    frames = [FrameInfo(t, [Box(x, .2, .1, .3)], hist, [.95], box) for t in range(0, duration_ms, 250)]
    return box, frames, heuristic_layout(frames, 0, duration_ms, 1920, 1080)


@pytest.mark.parametrize('x', [.45, .14, .76])
def test_pillarboxed_talking_head_is_tracked_inside_the_picture(x):
    box, _, shot = pillarbox_shot(x)
    assert shot.layout == LayoutType.TALKING_HEAD
    assert shot.content_box is None and shot.crop_bounds == box
    assert shot.focus_path
    left, right = box.x * 1920, (box.x + box.w) * 1920
    for t in range(0, 8000, 500):
        [((cx, cy, cw, ch), destination)] = shot_views(shot, t, 1920, 1080, 1080, 1920)
        assert destination == (0, 0, 1080, 1920)
        assert left <= cx and cx + cw <= right, 'the crop never shows the black bars'
        assert ch == 1080


def test_pillarboxed_speaker_skips_vision_and_honours_explicit_styles(monkeypatch):
    from clip_engine.config import LayoutStyle
    from clip_engine.services.layout_analyzer import apply_style
    box, frames, _ = pillarbox_shot()
    analyzer = LayoutAnalyzer()
    monkeypatch.setattr(analyzer, '_decode_and_detect', lambda *_: (frames, [(0, b'x')]))
    monkeypatch.setattr(analyzer, '_vision_enabled', lambda: True)
    async def no_vision(*_, **__):
        raise AssertionError('a sustained inset speaker needs no paid vision call')
    monkeypatch.setattr(analyzer, '_vision_classify', no_vision)
    plan = asyncio.run(analyzer.analyze('fixture.mp4', 0, 8000, 1920, 1080, capture=True))
    assert [(s.layout, s.crop_bounds) for s in plan.shots] == [(LayoutType.TALKING_HEAD, box)]
    assert plan.trace['decisions'][0]['vision']['status'] == 'content_region'

    fitted = apply_style(heuristic_layout(frames, 0, 8000, 1920, 1080), LayoutStyle.FIT, 1920, 1080)
    assert fitted.layout == LayoutType.SCREEN and fitted.content_box == box and fitted.crop_bounds is None
    # A portrait inset keeps its composition automatically, but "fill" is honoured.
    portrait = ShotLayout(0, 4000, LayoutType.SCREEN, content_box=Box(.3, .05, .4, .9))
    assert apply_style(portrait, LayoutStyle.AUTO, 640, 360).content_box is not None
    filled = apply_style(ShotLayout(0, 4000, LayoutType.SCREEN, content_box=Box(.3, .05, .4, .9)),
                         LayoutStyle.FILL, 640, 360)
    assert filled.layout == LayoutType.TALKING_HEAD and filled.content_box is None
    [((x, _, w, _), _)] = shot_views(filled, 0, 640, 360, 180, 320)
    assert .3 * 640 <= x and x + w <= .7 * 640


def test_portrait_inset_and_brief_or_multiple_faces_keep_the_composition():
    box = detect_content_box(inset_frame())
    face = Box(.45, .3, .1, .3)
    portrait = [FrameInfo(t, [face], None, [.95], box) for t in range(0, 4000, 250)]
    assert heuristic_layout(portrait, 0, 4000, 640, 360).content_box == box
    pillar = detect_content_box(pillarbox_frame())
    brief = [FrameInfo(t, [face] if t < 1000 else [], None, [.95], pillar) for t in range(0, 4000, 250)]
    two = [FrameInfo(t, [Box(.2, .3, .1, .3), Box(.6, .3, .1, .3)], None, [.95, .95], pillar) for t in range(0, 4000, 250)]
    for frames in (brief, two):
        assert heuristic_layout(frames, 0, 4000, 1920, 1080).content_box == pillar


def test_render_of_pillarboxed_speaker_has_no_bars(tmp_path):
    ffmpeg = os.environ.get('TEST_FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('ffmpeg unavailable')
    image = pillarbox_frame()
    _, _, shot = pillarbox_shot(.14, 1000)
    plan = ClipLayoutPlan([shot], 640, 360)
    raw = tmp_path / 'pillar.rgb'
    raw.write_bytes(cv2.cvtColor(image, cv2.COLOR_BGR2RGB).tobytes() * 4)
    rendered = subprocess.run([
        ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360',
        '-r', '4', '-i', str(raw), '-filter_complex', build_layout_graph(plan, 180, 320, fps='4'),
        '-map', '[base]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], capture_output=True, check=True, timeout=30)
    output = np.frombuffer(rendered.stdout, np.uint8).reshape(-1, 320, 180, 3)
    assert len(output) == 4
    # Every output column comes from the picture, never from a black bar.
    assert output.max(axis=(0, 1, 3)).min() > 40


def test_downscaled_detection_matches_full_resolution_edges():
    """Insets are found on a small copy, but their edges stay pixel-exact."""
    from clip_engine.services.layout_analyzer import _content_edges
    rng = np.random.default_rng(4)
    images = [inset_frame(color, x, width) for color in (0, 230, 255) for x, width in ((190, 270), (80, 480), (120, 400))]
    images += [pillarbox_frame(), np.full((360, 640, 3), 230, np.uint8)]
    images += [cv2.GaussianBlur(rng.integers(0, 256, (360, 640, 3), np.uint8), (k, k), 0) for k in (1, 9, 31)]
    for image in images:
        edges = _content_edges(image)
        box = detect_content_box(image)
        if edges is None:
            assert box is None
        else:
            left, top, right, bottom, _ = edges
            assert box.to_list() == Box(left / 640, top / 360, (right - left) / 640, (bottom - top) / 360).to_list()
