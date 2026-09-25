"""Regressions for camera motion within a shot, independent of face detection."""
import os
import shutil
import subprocess

import numpy as np
import pytest

from clip_engine.services.layout_analyzer import (
    Box, ClipLayoutPlan, FrameInfo, LayoutType, heuristic_layout, smooth_focus_path, track_faces,
)
from clip_engine.services.layout_renderer import build_layout_graph, path_value_at, shot_views


def frames(duration, face_at):
    return [FrameInfo(t, face_at(t), None) for t in range(0, duration, 250)]


def position(path, t, axis=1):
    return path_value_at([(point[0], point[axis]) for point in path], t)


def test_zoom_at_fifteen_seconds_keeps_following_selected_subject():
    # Same proportions/timing as the reported clip: a 2.1x zoom leaves the
    # new face visible for less than the old 35% track-presence threshold.
    before, after = Box(.55, .38, .083, .195), Box(.43, .22, .168, .414)
    observations = frames(22500, lambda t: [before if t < 15000 else after])
    diagnostics = {}
    shot = heuristic_layout(observations, 0, 22500, 1920, 1080, diagnostics)
    assert shot.layout == LayoutType.TALKING_HEAD
    selected = [track for track in diagnostics['tracks'] if track['selected']]
    assert len(selected) == 1 and len(selected[0]['samples']) == len(observations)
    assert position(shot.focus_path, 16000) < position(shot.focus_path, 14000) - .035
    old_crop = shot_views(shot, 14000, 1920, 1080, 1080, 1920)[0][0]
    new_crop = shot_views(shot, 16000, 1920, 1080, 1080, 1920)[0][0]
    assert new_crop[0] < old_crop[0] - 65


def test_large_position_jump_does_not_invent_a_two_person_layout():
    left, right = Box(.18, .2, .14, .3), Box(.65, .2, .14, .3)
    observations = frames(8000, lambda t: [left if t < 4000 else right])
    shot = heuristic_layout(observations, 0, 8000, 1920, 1080)
    assert shot.layout == LayoutType.TALKING_HEAD
    assert position(shot.focus_path, 7000) > .65


def test_two_visible_people_keep_separate_tracks():
    left, right = Box(.18, .2, .14, .3), Box(.65, .2, .14, .3)
    observations = frames(8000, lambda _: [left, right])
    assert len(track_faces(observations)) == 2
    assert heuristic_layout(observations, 0, 8000, 1920, 1080).layout == LayoutType.TWO_SHOT


def test_long_dropout_does_not_reuse_stale_identity():
    face = Box(.4, .2, .14, .3)
    observations = frames(8000, lambda t: [] if 2000 <= t < 4000 else [face])
    assert len(track_faces(observations)) == 2


def test_single_detection_jump_does_not_move_camera():
    face, blip = Box(.4, .2, .14, .3), Box(.75, .2, .14, .3)
    observations = frames(8000, lambda t: [blip if t == 4000 else face])
    shot = heuristic_layout(observations, 0, 8000, 1920, 1080)
    assert all(cx == pytest.approx(face.cx) for _, cx, _ in shot.focus_path)


@pytest.mark.parametrize('axis', [1, 2])
def test_camera_path_retains_direction_reversals_in_both_axes(axis):
    samples = []
    for t in range(0, 12000, 250):
        # Never rests at the turn. A moving/still-only simplifier would join
        # the endpoints and discard this out-and-back excursion entirely.
        moving = .2 + .5 * (1 - abs(t - 6000) / 6000)
        x, y = (moving, .3) if axis == 1 else (.4, moving)
        samples.append((t, Box(x, y, .1, .2)))
    path = smooth_focus_path(samples, 12000, .316)
    assert position(path, 6500, axis) > position(path, 0, axis) + .25
    assert position(path, 6500, axis) > position(path, 11750, axis) + .25
    assert len(path) <= 40


def test_rendered_crop_follows_subject_after_large_jump(tmp_path):
    ffmpeg = os.environ.get('TEST_FFMPEG') or shutil.which('ffmpeg')
    if not ffmpeg:
        pytest.skip('ffmpeg not installed')
    left, right = Box(.18, .2, .14, .3), Box(.65, .2, .14, .3)
    observations = frames(8000, lambda t: [left if t < 3000 else right])
    shot = heuristic_layout(observations, 0, 8000, 640, 360)
    plan = ClipLayoutPlan([shot], 640, 360)
    raw = tmp_path / 'motion.rgb'
    with raw.open('wb') as output:
        for frame in observations:
            pixels = np.zeros((360, 640, 3), np.uint8)
            face = frame.faces[0]
            x, y, w, h = (int(v) for v in (face.x * 640, face.y * 360, face.w * 640, face.h * 360))
            pixels[y:y+h, x:x+w] = (255, 0, 0)
            output.write(pixels.tobytes())
    result = subprocess.run([
        ffmpeg, '-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '640x360',
        '-r', '4', '-i', str(raw), '-filter_complex', build_layout_graph(plan, 180, 320, fps='4'),
        '-map', '[base]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], capture_output=True, check=True, timeout=30)
    output = np.frombuffer(result.stdout, np.uint8).reshape(-1, 320, 180, 3)
    assert len(output) == 32
    for index in [4, 24, 28]:
        image = output[index]
        red = (image[:, :, 0] > 180) & (image[:, :, 1] < 50) & (image[:, :, 2] < 50)
        assert red.sum() > 6000
        assert abs(np.where(red)[1].mean() - 90) < 25
