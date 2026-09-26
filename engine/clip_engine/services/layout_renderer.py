"""
Layout Renderer - turns a ClipLayoutPlan into an FFmpeg filter graph.

Each shot is trimmed from the source and framed with its own layout, then the
shots are concatenated back into one 9:16 stream:

    talking_head  full-frame crop that pans with the speaker
    two_shot      each person in their own panel, stacked
    screen_cam    screen (complete active area fitted without clipping) over the webcam
    screen        whole frame over a blurred copy of itself

Also provides per-shot positions for captions, the title card and the
channel banner so they never sit on top of a face or cut across a seam.

Everything here is pure string/number math so it can be unit tested without
FFmpeg.
"""

from bisect import bisect_left
from dataclasses import dataclass
from fractions import Fraction
from math import ceil
from typing import Optional

from clip_engine.services.layout_analyzer import Box, ClipLayoutPlan, LayoutType, ShotLayout
from clip_engine.services.video_speed import speed_audio_filter, validate_video_speed

# Two people get equal space. Screen shares start with more room for the
# screen; a smaller webcam can move the seam farther down.
TWO_SHOT_TOP_RATIO = 0.5
SCREEN_CAM_TOP_RATIO = 0.6
MAX_SCREEN_CAM_TOP_RATIO = 0.7
# Never upscale a crop more than this (beyond it faces/text turn to mush).
MAX_UPSCALE = 2.6
# How much of a face-box height a person crop spans (head + shoulders).
PERSON_CROP_FACE_MULT = 3.2
# Where the face sits vertically inside a person crop (0 = top).
PERSON_FACE_Y = 0.40
# Margin around the webcam box kept out of the screen panel (share of its size).
AVOID_MARGIN = 0.15


def even(value: float) -> int:
    """Round down to an even integer (yuv420p needs even dimensions)."""
    return max(2, int(value) // 2 * 2)


def _clamp(value: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, value))


def piecewise_expr(points: list[tuple[float, float]]) -> str:
    """Piecewise-linear FFmpeg expression of `t` through (t_sec, value) points."""
    if not points:
        return "0"
    points = sorted(points)
    expr = f"{points[-1][1]:.1f}"
    for (t0, v0), (t1, v1) in reversed(list(zip(points, points[1:]))):
        span = max(t1 - t0, 1e-3)
        expr = f"if(lt(t,{t1:.3f}),{v0:.1f}+({v1 - v0:.1f})*(t-{t0:.3f})/{span:.3f},{expr})"
    return expr


def step_expr(boundaries: list[float], values: list[float]) -> str:
    """Step-function expression: values[i] until boundaries[i], last value after."""
    expr = f"{values[-1]:.0f}"
    for boundary, value in reversed(list(zip(boundaries, values[:-1]))):
        expr = f"if(lt(t,{boundary:.3f}),{value:.0f},{expr})"
    return expr


# ------------------------------------------------------------------
# Crop geometry (all in source pixels)
# ------------------------------------------------------------------


def _fill_crop_path(
    shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int,
) -> tuple[int, int, list[tuple[float, float]], list[tuple[float, float]]]:
    """Crop size and its (t_sec, x) / (t_sec, y) keyframes in window time."""
    target = out_w / out_h
    if src_w / src_h > target:
        crop_h = even(src_h)
        crop_w = even(src_h * target)
    else:
        crop_w = even(src_w)
        crop_h = even(src_w / target)

    path = shot.focus_path or [(0, 0.5, 0.5)]
    xs, ys = [], []
    for t_ms, cx, cy in path:
        t = (shot.start_ms + t_ms) / 1000
        xs.append((t, _clamp(cx * src_w - crop_w / 2, 0, src_w - crop_w)))
        ys.append((t, _clamp(cy * src_h - crop_h * PERSON_FACE_Y, 0, src_h - crop_h)))
    return crop_w, crop_h, xs, ys


def fill_crop(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int, str, str]:
    """9:16 crop that follows the shot's focus path. Returns (w, h, x_expr, y_expr).

    Expressions are in window time (`t` before the piece's timestamps are
    reset), so the path is offset by the shot's start.
    """
    crop_w, crop_h, xs, ys = _fill_crop_path(shot, src_w, src_h, out_w, out_h)
    x_expr = piecewise_expr(xs) if crop_w < src_w else "0"
    y_expr = piecewise_expr(ys) if crop_h < src_h else "0"
    return crop_w, crop_h, x_expr, y_expr


def path_value_at(points: list[tuple[float, float]], t: float) -> float:
    """Value of piecewise_expr(points) at time t (held flat past either end)."""
    points = sorted(points)
    if t <= points[0][0]:
        return points[0][1]
    for (t0, v0), (t1, v1) in zip(points, points[1:]):
        if t < t1:
            return v0 + (v1 - v0) * (t - t0) / max(t1 - t0, 1e-3)
    return points[-1][1]


def _fit_rect(cx: float, cy: float, w: float, h: float, bounds: tuple[float, float, float, float]) -> tuple[int, int, int, int]:
    """Place a w x h rect centered on (cx, cy), shifted to stay inside bounds (x, y, w, h)."""
    bx, by, bw, bh = bounds
    w, h = min(w, bw), min(h, bh)
    x = _clamp(cx - w / 2, bx, bx + bw - w)
    y = _clamp(cy - h / 2, by, by + bh - h)
    return even(w), even(h), max(0, int(x) // 2 * 2), max(0, int(y) // 2 * 2)


def person_crop(
    face: Box,
    src_w: int,
    src_h: int,
    panel_w: int,
    panel_h: int,
    x_bounds: Optional[tuple[float, float]] = None,
) -> tuple[int, int, int, int]:
    """Head-and-shoulders crop for one person, at the panel's aspect ratio.

    `x_bounds` (source px) keeps the crop on this person's side of a
    two-shot so the neighbour doesn't bleed in. Near a frame edge the crop
    tightens (within MAX_UPSCALE) instead of pushing the face off-center.
    """
    aspect = panel_w / panel_h
    min_h = panel_h / MAX_UPSCALE
    x0, x1 = x_bounds or (0, src_w)
    fx, fy = face.cx * src_w, face.cy * src_h

    crop_h = _clamp(face.h * src_h * PERSON_CROP_FACE_MULT, min_h, src_h)
    crop_h = min(crop_h, max((x1 - x0) / aspect, min_h))
    # Keep the face between 25% and 58% of the panel height.
    crop_h = min(crop_h, max((src_h - fy) / (1 - 0.58), min_h), max(fy / 0.25, min_h))
    crop_w = crop_h * aspect

    bounds = (x0, 0, x1 - x0, src_h) if crop_w <= x1 - x0 else (0, 0, src_w, src_h)
    cy = fy + crop_h * (0.5 - PERSON_FACE_Y)
    return _fit_rect(fx, cy, crop_w, crop_h, bounds)


def cam_crop(cam: Box, face: Optional[Box], src_w: int, src_h: int, panel_w: int, panel_h: int) -> tuple[int, int, int, int]:
    """Crop inside the webcam overlay, centered on the face.

    At the panel's aspect when filling the panel stays within MAX_UPSCALE.
    A webcam too small for that keeps as much of the overlay as fits the
    panel at MAX_UPSCALE instead; `panel_fit` then letterboxes it over a
    blurred fill rather than blowing the face up to mush.
    """
    aspect = panel_w / panel_h
    # Dimensions round down, but the left/top bounds must round INWARD.
    # Rounding a fractional webcam origin down includes screen pixels outside
    # the overlay, which become a conspicuous strip after enlargement.
    cam = cam.clamp()
    left, top = ceil(cam.x * src_w / 2) * 2, ceil(cam.y * src_h / 2) * 2
    right = int((cam.x + cam.w) * src_w) // 2 * 2
    bottom = int((cam.y + cam.h) * src_h) // 2 * 2
    bounds = (left, top, max(2, right - left), max(2, bottom - top))
    bw, bh = bounds[2], bounds[3]
    if bw / bh > aspect:
        crop_h, crop_w = bh, bh * aspect
    else:
        crop_w, crop_h = bw, bw / aspect
    if panel_w / crop_w > MAX_UPSCALE:
        crop_w, crop_h = min(bw, panel_w / MAX_UPSCALE), min(bh, panel_h / MAX_UPSCALE)
    fx = (face.cx if face else cam.cx) * src_w
    fy = (face.cy if face else cam.cy) * src_h
    if face and cam.contains(face.cx, face.cy):
        centered_w = 2 * min(fx - left, right - fx)
        centered_h = centered_w / aspect
        # Ignore small off-center poses. For larger offsets, tighten within
        # the real camera bounds. panel_fit still caps enlargement and adds
        # a centered blurred fill if the resulting crop is too small.
        if (centered_w < crop_w * .9 and centered_w >= face.w * src_w * 1.5
                and centered_h >= face.h * src_h * 1.8):
            crop_w, crop_h = centered_w, min(crop_h, centered_h)
    return _fit_rect(fx, fy + crop_h * (0.5 - PERSON_FACE_Y), crop_w, crop_h, bounds)


def panel_fit(rect: tuple[int, int, int, int], panel_w: int, panel_h: int) -> Optional[tuple[int, int]]:
    """Scaled size of a crop that can't fill its panel within MAX_UPSCALE, else None."""
    w, h = rect[0], rect[1]
    fill = max(panel_w / w, panel_h / h)
    if fill <= MAX_UPSCALE * 1.02 and abs(w / h - panel_w / panel_h) <= 0.02 * panel_w / panel_h:
        return None
    scale = min(panel_w / w, panel_h / h, MAX_UPSCALE)
    return even(w * scale), even(h * scale)


def stacked_panel_heights(shot: ShotLayout, src_h: int, out_h: int) -> tuple[int, int]:
    """Return even top/bottom heights for one stacked shot.

    A webcam's source height limits how tall its destination can be before it
    must be enlarged beyond MAX_UPSCALE. Keep at least 30% for the webcam;
    panel_fit will letterbox overlays that are smaller still (or too narrow).
    The same seam is used by the graph and caption placement.
    """
    if shot.layout != LayoutType.SCREEN_CAM or shot.cam_box is None:
        top_h = even(out_h * TWO_SHOT_TOP_RATIO)
    else:
        preferred_bottom = out_h - even(out_h * SCREEN_CAM_TOP_RATIO)
        minimum_bottom = out_h - even(out_h * MAX_SCREEN_CAM_TOP_RATIO)
        webcam_budget = even(shot.cam_box.h * src_h * MAX_UPSCALE)
        bottom_h = max(minimum_bottom, min(preferred_bottom, webcam_budget))
        top_h = out_h - bottom_h
    return top_h, out_h - top_h


def screen_crop(
    screen: Optional[Box],
    focus: Optional[Box],
    src_w: int,
    src_h: int,
    panel_w: int,
    panel_h: int,
    avoid: Optional[Box] = None,
) -> tuple[int, int, int, int]:
    """Keep the entire semantic focus region; fit it rather than crop to fill.

    Webcam avoidance is secondary to preserving the text/chart. If no clean
    rectangle contains the focus, retain it rather than cutting off its labels.
    Without a reliable focus, show the largest unobscured screen region.
    """
    screen = (screen or Box(0, 0, 1, 1)).clamp()
    bounds = (screen.x * src_w, screen.y * src_h, screen.w * src_w, screen.h * src_h)
    bx, by, bw, bh = bounds
    target = None
    if focus is not None:
        left, top = max(bx, focus.x * src_w), max(by, focus.y * src_h)
        right = min(bx + bw, (focus.x + focus.w) * src_w)
        bottom = min(by + bh, (focus.y + focus.h) * src_h)
        if right > left and bottom > top:
            target = (left, top, right - left, bottom - top)

    if avoid is not None:
        # Try a border margin first, then the actual camera edge. Never slide
        # a complete paragraph out of view merely to hide a repeated webcam.
        for margin in (AVOID_MARGIN, 0):
            ax0 = (avoid.x - avoid.w * margin) * src_w
            ax1 = (avoid.x + avoid.w * (1 + margin)) * src_w
            ay0 = (avoid.y - avoid.h * margin) * src_h
            ay1 = (avoid.y + avoid.h * (1 + margin)) * src_h
            if ax1 <= bx or ax0 >= bx + bw or ay1 <= by or ay0 >= by + bh:
                break
            regions = [(bx, by, min(bw, ax0 - bx), bh),
                       (max(bx, ax1), by, bx + bw - max(bx, ax1), bh),
                       (bx, by, bw, min(bh, ay0 - by)),
                       (bx, max(by, ay1), bw, by + bh - max(by, ay1))]
            choices = [r for r in regions if r[2] >= 2 and r[3] >= 2 and
                       (target is None or (r[0] <= target[0] and r[1] <= target[1] and
                        r[0] + r[2] >= target[0] + target[2] and r[1] + r[3] >= target[1] + target[3]))]
            if choices:
                bounds = max(choices, key=lambda r: r[2] * r[3])
                break
    bx, by, bw, bh = bounds
    if target is None:
        return _fit_rect(bx + bw / 2, by + bh / 2, bw, bh, bounds)
    tx, ty, tw, th = target
    # Keep surrounding context even if vision selects a single word. Width and
    # height are independent: a wide paragraph must not become a narrow slice.
    w = min(bw, max(tw * 1.12, bw * .6, panel_w / MAX_UPSCALE))
    h = min(bh, max(th * 1.12, bh * .6, panel_h / MAX_UPSCALE))
    return _fit_rect(tx + tw / 2, ty + th / 2, w, h, bounds)


def screen_view(shot: ShotLayout, src_w: int, src_h: int, panel_w: int, panel_h: int):
    """Identical contained screen geometry for rendering and inspection."""
    rect = screen_crop(shot.screen_box, shot.screen_focus, src_w, src_h, panel_w, panel_h, shot.cam_box)
    width, height = panel_fit(rect, panel_w, panel_h) or (panel_w, panel_h)
    return rect, ((panel_w - width) // 2, (panel_h - height) // 2, width, height)


# ------------------------------------------------------------------
# Filter graph
# ------------------------------------------------------------------


def _crop(rect: tuple[int, int, int, int]) -> str:
    w, h, x, y = rect
    return f"crop={w}:{h}:{x}:{y}"


def letterbox_geometry(src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    """(scaled video height, y offset) of the fit layout."""
    scaled_h = min(out_h, even(out_w * src_h / src_w + 1))
    return scaled_h, (out_h - scaled_h) // 2


def content_view(
    shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int,
) -> tuple[tuple[int, int, int, int], tuple[int, int, int, int]]:
    """The complete inset and its fitted destination, shared with diagnostics."""
    box = shot.content_box.clamp()
    x, y = max(0, int(box.x * src_w) // 2 * 2), max(0, int(box.y * src_h) // 2 * 2)
    w, h = min(even(box.w * src_w), src_w - x), min(even(box.h * src_h), src_h - y)
    scale = min(out_w / w, out_h / h)
    fw, fh = min(out_w, even(w * scale)), min(out_h, even(h * scale))
    return (x, y, w, h), ((out_w - fw) // 2, (out_h - fh) // 2, fw, fh)


def foreground_geometry(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    if shot.content_box is not None:
        _, (_, y, _, h) = content_view(shot, src_w, src_h, out_w, out_h)
        return h, y
    return letterbox_geometry(src_w, src_h, out_w, out_h)


def shot_chain(
    i: int, shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int, landscape: bool = False,
    fps: str = '30', start_frame: int = 0,
) -> str:
    """Filters from [t{i}] (a trimmed piece) to [v{i}] (framed, out_w x out_h)."""
    scale = "flags=lanczos"
    if shot.manual_crops:
        views = manual_views(shot, src_w, src_h, out_w, out_h)
        n = len(views)
        parts = [f"[t{i}]split={n}" + ''.join(f"[mc{i}_{j}]" for j in range(n))] if n > 1 else []
        for j, ((x, y, w, h), (_, _, pw, ph)) in enumerate(views):
            source = f"mc{i}_{j}" if n > 1 else f"t{i}"
            target = f"mp{i}_{j}" if n > 1 else f"v{i}"
            if shot.manual_transition_ms:
                # Perspective maps a moving source rectangle to a fixed frame.
                # Unlike changing crop dimensions, it preserves a fixed output
                # size and supports simultaneous pan/zoom without huge buffers.
                p = f"clip(((in+{start_frame})*1000/({fps})-({shot.manual_transition_start_ms}))/{shot.manual_transition_ms},0,1)"
                ease = f"({p}*{p}*(3-2*{p}))"
                origin, dest = shot.manual_from_crops[j], shot.manual_crops[j]
                def coord(k, size):
                    return f"{size}*({origin[k]:.10f}+({dest[k] - origin[k]:.10f})*{ease})"
                left, top, width, height = (coord(k, size) for k, size in enumerate(('W', 'H', 'W', 'H')))
                corners = [left, top, f"{left}+{width}", top, left, f"{top}+{height}", f"{left}+{width}", f"{top}+{height}"]
                transform = 'perspective=' + ':'.join(f"{key}='{value}'" for key, value in zip(('x0', 'y0', 'x1', 'y1', 'x2', 'y2', 'x3', 'y3'), corners))
                transform += ':sense=source:eval=frame:interpolation=cubic'
            else:
                transform = f"crop={w}:{h}:{x}:{y}"
            parts.append(f"[{source}]{transform},scale={pw}:{ph}:{scale},setsar=1[{target}]")
        if n > 1:
            parts.append(''.join(f"[mp{i}_{j}]" for j in range(n)) + f"vstack=inputs={n}[v{i}]")
        return ';'.join(parts)
    if landscape:
        # Within 1% of 16:9 (e.g. 1920x1088 encodes) a direct scale is invisible.
        if abs(src_w / src_h - out_w / out_h) < 0.01 * out_w / out_h:
            return f"[t{i}]scale={out_w}:{out_h}:{scale},setsar=1[v{i}]"
        # 4:3, vertical or other shapes: whole frame over a blurred fill of
        # itself instead of black bars.
        bg_w, bg_h = even(out_w // 4), even(out_h // 4)
        return (
            f"[t{i}]split=2[lb{i}][lf{i}];"
            f"[lb{i}]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h},"
            f"gblur=sigma=10,lutyuv=y=val-20,scale={out_w}:{out_h}[lbg{i}];"
            f"[lf{i}]scale={out_w}:{out_h}:force_original_aspect_ratio=decrease:{scale}[lfg{i}];"
            f"[lbg{i}][lfg{i}]overlay=(W-w)/2:(H-h)/2,setsar=1[v{i}]"
        )
    if shot.content_box is not None:
        (x, y, w, h), (dx, dy, fw, fh) = content_view(shot, src_w, src_h, out_w, out_h)
        bg_w, bg_h = even(out_w // 4), even(out_h // 4)
        return (
            f"[t{i}]crop={w}:{h}:{x}:{y},split=2[ib{i}][if{i}];"
            f"[ib{i}]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h},"
            f"gblur=sigma=10,lutyuv=y=val-20,scale={out_w}:{out_h}[ibg{i}];"
            f"[if{i}]scale={fw}:{fh}:{scale}[ifg{i}];"
            f"[ibg{i}][ifg{i}]overlay={dx}:{dy},setsar=1[v{i}]"
        )
    if shot.layout == LayoutType.TALKING_HEAD:
        w, h, x_expr, y_expr = fill_crop(shot, src_w, src_h, out_w, out_h)
        return (
            f"[t{i}]crop=w={w}:h={h}:x='{x_expr}':y='{y_expr}',"
            f"scale={out_w}:{out_h}:{scale},setsar=1[v{i}]"
        )

    top_h, bottom_h = stacked_panel_heights(shot, src_h, out_h)
    if shot.layout == LayoutType.TWO_SHOT and len(shot.people) >= 2:
        left, right = shot.people[0], shot.people[1]
        mid = (left.cx + right.cx) / 2 * src_w
        return (
            f"[t{i}]split=2[pa{i}][pb{i}];"
            f"[pa{i}]{_crop(person_crop(left, src_w, src_h, out_w, top_h, (0, mid)))},"
            f"scale={out_w}:{top_h}:{scale}[top{i}];"
            f"[pb{i}]{_crop(person_crop(right, src_w, src_h, out_w, bottom_h, (mid, src_w)))},"
            f"scale={out_w}:{bottom_h}:{scale}[bot{i}];"
            f"[top{i}][bot{i}]vstack=inputs=2,setsar=1[v{i}]"
        )
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None:
        cam_rect = cam_crop(shot.cam_box, shot.cam_face, src_w, src_h, out_w, bottom_h)
        fit = panel_fit(cam_rect, out_w, bottom_h)
        if fit is None:
            cam_panel = f"[sb{i}]{_crop(cam_rect)},scale={out_w}:{bottom_h}:{scale}[bot{i}]"
        else:
            # Small webcam: show it at MAX_UPSCALE over a blurred fill of itself.
            fit_w, fit_h = fit
            bg_w, bg_h = even(out_w // 4), even(bottom_h // 4)
            cam_panel = (
                f"[sb{i}]{_crop(cam_rect)},split=2[cb{i}][cf{i}];"
                f"[cb{i}]scale={bg_w}:{bg_h}:force_original_aspect_ratio=increase,crop={bg_w}:{bg_h},"
                f"gblur=sigma=10,lutyuv=y=val-20,scale={out_w}:{bottom_h}[cbg{i}];"
                f"[cf{i}]scale={fit_w}:{fit_h}:{scale}[cfg{i}];"
                f"[cbg{i}][cfg{i}]overlay={(out_w - fit_w) // 2}:{(bottom_h - fit_h) // 2}[bot{i}]"
            )
        screen_rect, (dx, dy, fw, fh) = screen_view(shot, src_w, src_h, out_w, top_h)
        return (
            f"[t{i}]split=2[sa{i}][sb{i}];"
            f"[sa{i}]{_crop(screen_rect)},scale={fw}:{fh}:{scale},"
            f"pad={out_w}:{top_h}:{dx}:{dy}:color=0x12151b[top{i}];"
            f"{cam_panel};"
            f"[top{i}][bot{i}]vstack=inputs=2,setsar=1[v{i}]"
        )

    # Fit: whole frame over a blurred, darkened fill of itself.
    scaled_h, overlay_y = letterbox_geometry(src_w, src_h, out_w, out_h)
    bg_w = min(src_w, even(src_h * out_w / out_h))
    bg_h = min(src_h, even(src_w * out_h / out_w)) if bg_w == src_w else src_h
    return (
        f"[t{i}]split=2[bi{i}][fi{i}];"
        f"[bi{i}]crop={bg_w}:{bg_h}:{(src_w - bg_w) // 2}:{(src_h - bg_h) // 2},"
        # Blur at quarter size then upscale: same look, ~16x cheaper than a
        # sigma-40 blur at full 1080x1920.
        f"scale={out_w // 4}:{out_h // 4},gblur=sigma=10,lutyuv=y=val-20,"
        f"scale={out_w}:{out_h}[bg{i}];"
        f"[fi{i}]scale={out_w}:{scaled_h}:{scale}[fg{i}];"
        f"[bg{i}][fg{i}]overlay=0:{overlay_y},setsar=1[v{i}]"
    )


def timeline_pieces(plan: ClipLayoutPlan, keeps: Optional[list[tuple[int, int]]] = None) -> list[tuple[int, int, int]]:
    """(shot index, start_ms, end_ms) for every kept piece of every shot, in order."""
    window_end = plan.shots[-1].end_ms
    keeps = [(0, window_end)] if keeps is None else keeps
    pieces = []
    for i, shot in enumerate(plan.shots):
        for k_start, k_end in keeps:
            s_, e_ = max(shot.start_ms, k_start), min(shot.end_ms, k_end)
            if e_ > s_:
                pieces.append((i, s_, e_))
    return pieces


# Audio polish: platform loudness target and click-free edges. The explicit
# aformat pins the channel layout: without it FFmpeg 6.x can't negotiate one
# between loudnorm and the AAC encoder on split/stacked graphs ("Cannot
# select channel layout"), which failed every smart render. The source is
# pinned too, before asplit/concat: a source with an unknown channel layout
# fails that negotiation earlier, at the concat.
AUDIO_FORMAT = "aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo"
# Preserve the window's clock, including delayed starts and missing packets.
# Resetting each stream to STARTPTS would erase their relative offset.
AUDIO_SYNC = "aresample=48000:async=1:first_pts=0:min_hard_comp=0.001"
LOUDNESS_TARGET = "I=-14:TP=-1.5:LRA=11"
# Some FFmpeg versions emit NaNs when normalizing short digital silence.
# Preserve silence and finite samples; never feed invalid floats to AAC.
FINITE_AUDIO = "aeval='if(isnan(val(ch))+isinf(val(ch)),0,val(ch))':c=same"
LOUDNESS_FILTER = f"loudnorm={LOUDNESS_TARGET},aresample=48000,{FINITE_AUDIO},{AUDIO_FORMAT}"


def measured_loudness_filter(measured: dict) -> Optional[str]:
    """Second pass of two-pass loudnorm: a linear gain from a first-pass
    measurement (FFmpeg's print_format=json output). Unlike single-pass
    dynamic mode it can't pump over a long clip. None if the measurement is
    unusable (e.g. digital silence)."""
    keys = ("input_i", "input_tp", "input_lra", "input_thresh", "target_offset")
    try:
        values = {k: float(measured[k]) for k in keys}
    except (KeyError, TypeError, ValueError):
        return None
    if any(v != v or abs(v) == float("inf") for v in values.values()) or values["input_i"] < -70:
        return None
    return (
        f"loudnorm={LOUDNESS_TARGET}"
        f":measured_I={values['input_i']:.2f}:measured_TP={values['input_tp']:.2f}"
        f":measured_LRA={values['input_lra']:.2f}:measured_thresh={values['input_thresh']:.2f}"
        f":offset={values['target_offset']:.2f}:linear=true,"
        f"aresample=48000,{FINITE_AUDIO},{AUDIO_FORMAT}"
    )
EDGE_FADE_S = 0.012
START_FADE_S = 0.03
END_FADE_S = 0.08


def _audio_fades(duration_s: float, first: bool, last: bool) -> str:
    fade_in = START_FADE_S if first else EDGE_FADE_S
    fade_out = END_FADE_S if last else EDGE_FADE_S
    if duration_s <= fade_in + fade_out:
        return ""
    return (
        f",afade=t=in:st=0:d={fade_in}"
        f",afade=t=out:st={duration_s - fade_out:.3f}:d={fade_out}"
    )


def video_frame_pieces(plan: ClipLayoutPlan, keeps: Optional[list[tuple[int, int]]], fps: str) -> list[tuple[int, int, int]]:
    """Exact (shot index, source start frame, frame count) used by the renderer."""
    pieces = timeline_pieces(plan, keeps)
    if not pieces:
        raise ValueError("The edit contains no video")
    rate = Fraction(fps)
    if rate <= 0:
        raise ValueError("Frame rate must be positive")

    def frame_at(ms: int) -> int:
        return int(Fraction(ms, 1000) * rate + Fraction(1, 2))

    # Use differences of rounded totals, never a sum of rounded durations.
    # Sub-frame layout slivers may contribute no frame but retain their audio.
    video_pieces = []
    elapsed_ms = frame_end = 0
    for i, start, end in pieces:
        # Quantize the removed time once. Independently rounding source and
        # destination starts can shift a frame twice at the same edit.
        start_frame = frame_at(start - elapsed_ms) + frame_end
        elapsed_ms += end - start
        next_frame = frame_at(elapsed_ms)
        count = next_frame - frame_end
        if count:
            video_pieces.append((i, start_frame, count))
        frame_end = next_frame
    if not video_pieces:
        raise ValueError("The edit is shorter than one video frame")
    return video_pieces


def build_layout_graph(
    plan: ClipLayoutPlan,
    out_w: int,
    out_h: int,
    keeps: Optional[list[tuple[int, int]]] = None,
    with_audio: bool = False,
    landscape: bool = False,
    fps: str = "30",
    loudness_filter: Optional[str] = None,
    video_speed: float = 1.0,
) -> str:
    """Filter graph from [0:v] (and [0:a]) to [base] (and [aout]).

    `fps` is the output frame rate (a number or rational like "30000/1001");
    `loudness_filter` replaces the default single-pass loudnorm.

    Video uses a single frame grid before trimming. Piece lengths are rounded
    on the cumulative output timeline, so rounding never accumulates at cuts.
    Audio uses the same window clock and exact keep intervals; framing changes
    must neither splice speech nor add concat's longest-stream padding.
    """
    validate_video_speed(video_speed)
    src_w, src_h = plan.source_width, plan.source_height
    window_end = plan.shots[-1].end_ms
    video_pieces = video_frame_pieces(plan, keeps, fps)
    n = len(video_pieces)
    # Fill delayed/sparse video using its timestamps, without speeding it up.
    # Tail padding is bounded by the requested window and trimmed per piece.
    parts: list[str] = [
        f"[0:v]fps={fps}:start_time=0:round=near,"
        f"tpad=stop_mode=clone:stop_duration={window_end / 1000:.3f}[clocked]"
    ]
    if n == 1:
        parts.append("[clocked]null[s0]")
    else:
        parts.append(f"[clocked]split={n}" + "".join(f"[s{k}]" for k in range(n)))
    for k, (i, start_frame, count) in enumerate(video_pieces):
        parts.append(f"[s{k}]trim=start_frame={start_frame}:end_frame={start_frame + count}[t{k}]")
        chain = shot_chain(k, plan.shots[i], src_w, src_h, out_w, out_h, landscape, fps, start_frame)
        parts.append(chain[: chain.rindex(f"[v{k}]")] + f"[c{k}]")
        parts.append(f"[c{k}]setpts=PTS-STARTPTS[v{k}]")

    inputs = "".join(f"[v{k}]" for k in range(n))
    # Concat uses a microsecond time base; re-establish exact rational frame
    # timestamps instead of propagating its rounding across long edits.
    parts.append(f"{inputs}concat=n={n}:v=1:a=0,settb=expr=1/({fps}),setpts=N,fps={fps}[base]")

    if with_audio:
        audio_keeps = [(0, window_end)] if keeps is None else keeps
        audio_n = len(audio_keeps)
        # apad cannot produce samples when the selected window contains zero
        # audio packets. A finite silent bed also covers that valid case.
        parts.append(f"anullsrc=r=48000:cl=stereo:d={window_end / 1000:.3f}[silence]")
        parts.append(f"[0:a:0]{AUDIO_FORMAT},{AUDIO_SYNC}[clocked_audio]")
        source_audio = (
            f"[silence][clocked_audio]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,"
            f"atrim=end={window_end / 1000:.3f}"
        )
        if audio_n == 1:
            parts.append(f"{source_audio}[as0]")
        else:
            parts.append(f"{source_audio},asplit={audio_n}" + "".join(f"[as{k}]" for k in range(audio_n)))
        for k, (start, end) in enumerate(audio_keeps):
            fades = _audio_fades((end - start) / 1000, k == 0, k == audio_n - 1)
            parts.append(
                f"[as{k}]atrim=start={start / 1000:.3f}:end={end / 1000:.3f},"
                f"asetpts=PTS-{start / 1000:.3f}/TB{fades}[a{k}]"
            )
        inputs = "".join(f"[a{k}]" for k in range(audio_n))
        # The input resampler has already materialized source offsets/gaps,
        # and concat has applied the exact sample edits. Rebuild the final
        # clock from those samples AFTER loudnorm: its buffered EOF flush can
        # leave a PTS jump when the edit ends between its 100 ms blocks. AAC
        # then encodes that jump as an overlong packet, delaying the tail.
        # Resetting timestamps here preserves all content and source silence;
        # doing it before AUDIO_SYNC would erase legitimate source offsets.
        parts.append(
            f"{inputs}concat=n={audio_n}:v=0:a=1,{loudness_filter or LOUDNESS_FILTER},"
            f"{speed_audio_filter(video_speed, sum(end - start for start, end in audio_keeps))}"
            "asettb=1/48000,asetpts=N[aout]"
        )
    return ";".join(parts)


# ------------------------------------------------------------------
# Overlay placement per layout (output pixels)
# ------------------------------------------------------------------

# Captions on a full-frame speaker sit in the lower third, clear of the face
# and above the platform UI.
FILL_CAPTION_Y = 1340
FILL_BANNER_Y = 1590
TOP_TITLE_Y = 110


def caption_anchor(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> tuple[int, int]:
    """(ASS alignment, y) for captions during this shot."""
    if shot.layout == LayoutType.TWO_SHOT or (shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None):
        return 5, stacked_panel_heights(shot, src_h, out_h)[0]  # centered on the seam
    if shot.layout in (LayoutType.SCREEN, LayoutType.SCREEN_CAM):
        scaled_h, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        bar = out_h - (overlay_y + scaled_h)
        if bar >= 200:
            return 2, out_h - int(bar * 0.55)
    return 5, int(out_h * FILL_CAPTION_Y / 1920)


def title_y(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int, title_h: int) -> int:
    if shot.layout == LayoutType.SCREEN:
        _, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        if overlay_y > title_h + 20:
            return max(10, overlay_y // 2 - title_h // 2)
    return int(out_h * TOP_TITLE_Y / 1920)


def banner_y(shot: ShotLayout, src_w: int, src_h: int, out_w: int, out_h: int) -> int:
    if shot.layout == LayoutType.SCREEN:
        scaled_h, overlay_y = foreground_geometry(shot, src_w, src_h, out_w, out_h)
        if out_h - (overlay_y + scaled_h) >= 120:
            return overlay_y + scaled_h + 25
    return int(out_h * FILL_BANNER_Y / 1920)


def per_shot_expr(plan: ClipLayoutPlan, values: list[float]) -> str:
    """Expression of `t` that takes values[i] during shot i."""
    if len(set(values)) == 1:
        return f"{values[0]:.0f}"
    boundaries = [s.end_ms / 1000 for s in plan.shots[:-1]]
    return step_expr(boundaries, values)


# ------------------------------------------------------------------
# Faces on the output frame, for caption placement
# ------------------------------------------------------------------

# (x0, y0, x1, y1) in output pixels.
Rect = tuple[int, int, int, int]

# Detections are 1/ANALYSIS_FPS (250 ms) apart. Each one covers this long on
# either side, so a missed frame doesn't open a gap a caption could drop into.
FACE_HOLD_MS = 375
# Faces shorter than this on the output are background (posters, crowds).
MIN_ZONE_FACE_PX = 48


@dataclass(frozen=True)
class FaceZone:
    """Faces visible on the output frame during [start_ms, end_ms) of output time."""

    start_ms: int
    end_ms: int
    rects: tuple[Rect, ...]


def manual_views(shot, src_w, src_h, out_w, out_h, t_ms=None):
    """Exact normalized crops shared with the editor. Round inward for yuv420p."""
    result = []
    panel_h = even(out_h / len(shot.manual_crops))
    crops = shot.manual_crops
    if shot.manual_transition_ms and t_ms is not None:
        p = max(0, min(1, (t_ms - shot.manual_transition_start_ms) / shot.manual_transition_ms))
        ease = p * p * (3 - 2 * p)
        crops = [[a + (b - a) * ease for a, b in zip(start, end)] for start, end in zip(shot.manual_from_crops, crops)]
    for i, (x, y, w, h) in enumerate(crops):
        px, py = max(0, int(x * src_w) // 2 * 2), max(0, int(y * src_h) // 2 * 2)
        pw, ph = min(even(w * src_w), src_w - px), min(even(h * src_h), src_h - py)
        result.append(((px, py, pw, ph), (0, i * panel_h, out_w, out_h - panel_h if i == 1 else panel_h)))
    return result


def shot_views(
    shot: ShotLayout, t_ms: int, src_w: int, src_h: int, out_w: int, out_h: int,
) -> list[tuple[tuple[float, float, float, float], tuple[int, int, int, int]]]:
    """Where the source lands on the output at window time t_ms.

    One (source crop, output rect) pair per panel, both as (x, y, w, h). Mirrors
    the 9:16 branches of shot_chain.
    """
    if shot.manual_crops:
        return manual_views(shot, src_w, src_h, out_w, out_h, t_ms)
    if shot.content_box is not None:
        return [content_view(shot, src_w, src_h, out_w, out_h)]
    if shot.layout == LayoutType.TALKING_HEAD:
        crop_w, crop_h, xs, ys = _fill_crop_path(shot, src_w, src_h, out_w, out_h)
        t = t_ms / 1000
        x = path_value_at(xs, t) if crop_w < src_w else 0
        y = path_value_at(ys, t) if crop_h < src_h else 0
        return [((x, y, crop_w, crop_h), (0, 0, out_w, out_h))]

    top_h, bottom_h = stacked_panel_heights(shot, src_h, out_h)
    if shot.layout == LayoutType.TWO_SHOT and len(shot.people) >= 2:
        left, right = shot.people[0], shot.people[1]
        mid = (left.cx + right.cx) / 2 * src_w
        top = person_crop(left, src_w, src_h, out_w, top_h, (0, mid))
        bottom = person_crop(right, src_w, src_h, out_w, bottom_h, (mid, src_w))
        return [
            ((top[2], top[3], top[0], top[1]), (0, 0, out_w, top_h)),
            ((bottom[2], bottom[3], bottom[0], bottom[1]), (0, top_h, out_w, bottom_h)),
        ]
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_box is not None:
        screen, screen_dest = screen_view(shot, src_w, src_h, out_w, top_h)
        cam = cam_crop(shot.cam_box, shot.cam_face, src_w, src_h, out_w, bottom_h)
        fit = panel_fit(cam, out_w, bottom_h)
        if fit is None:
            cam_dest = (0, top_h, out_w, bottom_h)
        else:
            cam_dest = ((out_w - fit[0]) // 2, top_h + (bottom_h - fit[1]) // 2, fit[0], fit[1])
        return [
            ((screen[2], screen[3], screen[0], screen[1]), screen_dest),
            ((cam[2], cam[3], cam[0], cam[1]), cam_dest),
        ]

    scaled_h, overlay_y = letterbox_geometry(src_w, src_h, out_w, out_h)
    return [((0, 0, src_w, src_h), (0, overlay_y, out_w, scaled_h))]


def face_rects(
    shot: ShotLayout, faces: list[Box], t_ms: int, src_w: int, src_h: int, out_w: int, out_h: int,
) -> list[Rect]:
    """Output-pixel rects of the faces (normalized source boxes) visible at t_ms."""
    rects: list[Rect] = []
    for (cx, cy, cw, ch), (dx, dy, dw, dh) in shot_views(shot, t_ms, src_w, src_h, out_w, out_h):
        sx, sy = dw / cw, dh / ch
        for face in faces:
            x0 = max(dx + (face.x * src_w - cx) * sx, dx)
            y0 = max(dy + (face.y * src_h - cy) * sy, dy)
            x1 = min(dx + ((face.x + face.w) * src_w - cx) * sx, dx + dw)
            y1 = min(dy + ((face.y + face.h) * src_h - cy) * sy, dy + dh)
            # Faces cut off by the crop still count by their visible part, but
            # not a sliver at the panel edge or a face in the background.
            if x1 - x0 >= MIN_ZONE_FACE_PX / 2 and (face.h * src_h * sy) >= MIN_ZONE_FACE_PX and y1 > y0:
                rects.append((round(x0), round(y0), round(x1), round(y1)))
    return rects


def _shot_faces(shot: ShotLayout) -> list[Box]:
    """The shot's summary face boxes, for shots the detector never saw a face in."""
    if shot.layout in (LayoutType.TALKING_HEAD, LayoutType.TWO_SHOT):
        return list(shot.people)
    if shot.layout == LayoutType.SCREEN_CAM and shot.cam_face is not None:
        return [shot.cam_face]
    return []


def face_zones(plan: ClipLayoutPlan, time_map, out_w: int, out_h: int) -> list[FaceZone]:
    """Faces on the output frame over the edited timeline (9:16 only).

    `plan` is in window time (not remapped); `time_map` moves each detection
    onto the output timeline and drops time the edit cut. A shot where the
    detector saw no face (e.g. a vision-refined shot) falls back to its
    summary boxes for its whole length.
    """
    src_w, src_h = plan.source_width, plan.source_height
    samples = sorted(plan.face_samples, key=lambda s: s[0])
    zones: list[FaceZone] = []
    for shot in plan.shots:
        in_shot = [(t, faces) for t, faces in samples if shot.start_ms <= t < shot.end_ms]
        hold = FACE_HOLD_MS
        if not any(faces for _, faces in in_shot):
            in_shot = [((shot.start_ms + shot.end_ms) // 2, _shot_faces(shot))]
            hold = shot.end_ms - shot.start_ms
        for t, faces in in_shot:
            rects = tuple(face_rects(shot, faces, t, src_w, src_h, out_w, out_h)) if faces else ()
            if not rects:
                continue
            for keep_start, keep_end in time_map.pieces_within(shot.start_ms, shot.end_ms):
                lo, hi = max(keep_start, t - hold), min(keep_end, t + hold)
                if hi > lo:
                    zones.append(FaceZone(time_map.to_output(lo), time_map.to_output(hi), rects))
    return sorted(zones, key=lambda z: z.start_ms)


# Band a moved caption stays in (share of the height): below the title card
# (y 110, up to ~140 px tall) and above the channel banner / platform UI.
CAPTION_TOP_LIMIT = 0.15
CAPTION_BOTTOM_LIMIT = 0.80
# Room kept around a face (share of its size). Detector boxes run from the
# brows to the chin: hair needs more room above than the chin below, and a
# close-up's chin needs no more than a fixed margin.
FACE_PAD_X = 0.15
FACE_PAD_TOP = 0.25
FACE_PAD_BOTTOM = 0.12
MAX_FACE_PAD_BOTTOM_PX = 40
CAPTION_FACE_GAP = 12


class CaptionPlacer:
    """Picks each caption group's position so it doesn't cover a face.

    A group starts at its shot's anchor (caption_anchor). If that would cover
    a face visible at any time while the group is up, it moves just below or
    above the faces, whichever is nearer the anchor, inside the band clear of
    the title and banner. Later groups in the same shot keep a moved position
    while it stays clear, so captions don't hop between phrases. If no spot
    is clear, the one covering the least face wins.
    """

    def __init__(self, anchors: list[tuple[int, int, int]], zones: list[FaceZone], out_w: int, out_h: int):
        self.anchors = anchors  # (until_ms, alignment, y), as for CaptionGeneratorService._apply_anchors
        self.zones = sorted(zones, key=lambda z: z.start_ms)
        self._starts = [z.start_ms for z in self.zones]
        self._longest = max((z.end_ms - z.start_ms for z in self.zones), default=0)
        self.out_w, self.out_h = out_w, out_h
        self._last: Optional[tuple[int, float]] = None  # (anchor index, center y)

    def faces_during(self, start_ms: int, end_ms: int) -> list[Rect]:
        first = bisect_left(self._starts, start_ms - self._longest)
        last = bisect_left(self._starts, end_ms)
        return [r for z in self.zones[first:last] if z.end_ms > start_ms for r in z.rects]

    def __call__(self, start_ms: int, end_ms: int, block_w: int, block_h: int) -> tuple[int, int]:
        """(ASS alignment, y) for a caption block on screen during [start_ms, end_ms)."""
        index = next((i for i, (until, _, _) in enumerate(self.anchors) if start_ms < until), len(self.anchors) - 1)
        _, alignment, anchor_y = self.anchors[index]
        half = block_h / 2
        default = anchor_y - half if alignment in (1, 2, 3) else anchor_y + half if alignment in (7, 8, 9) else anchor_y

        left, right = (self.out_w - block_w) / 2, (self.out_w + block_w) / 2
        faces, keep_clear = [], []
        for x0, y0, x1, y1 in self.faces_during(start_ms, end_ms):
            w, h = x1 - x0, y1 - y0
            if x1 + w * FACE_PAD_X > left and x0 - w * FACE_PAD_X < right:
                faces.append((y0, y1))
                keep_clear.append((
                    y0 - h * FACE_PAD_TOP - CAPTION_FACE_GAP,
                    y1 + min(h * FACE_PAD_BOTTOM, MAX_FACE_PAD_BOTTOM_PX) + CAPTION_FACE_GAP,
                ))

        top, bottom = self.out_h * CAPTION_TOP_LIMIT + half, self.out_h * CAPTION_BOTTOM_LIMIT - half
        if top > bottom:
            top = bottom = self.out_h / 2

        def in_band(c: float) -> float:
            return min(max(c, top), bottom)

        def overlap(c: float, spans: list[tuple[float, float]]) -> float:
            return sum(max(0.0, min(c + half, b) - max(c - half, a)) for a, b in spans)

        # (center, tier): the previous spot beats the anchor, which beats the rest.
        candidates = [(default, 1)]
        if self._last is not None and self._last[0] == index:
            candidates.append((self._last[1], 0))
        for a, b in keep_clear:
            candidates += [(in_band(b + half), 2), (in_band(a - half), 2)]
        candidates += [(top, 2), (bottom, 2)]

        center, _ = min(candidates, key=lambda c: (
            4 * overlap(c[0], faces) + overlap(c[0], keep_clear), c[1], abs(c[0] - default),
        ))
        self._last = (index, center)
        if center == default:
            return alignment, anchor_y
        return 5, round(center)
