"""Versioned, credential-free recorded framing diagnostics. Never runs inference."""

import json
import os
from fractions import Fraction

from clip_engine.services import layout_analyzer as analyzer
from clip_engine.services.layout_renderer import _fill_crop_path, shot_views, video_frame_pieces

TRACE_VERSION = 1
MAX_TRACE_BYTES = 32 * 1024 * 1024


def plan_record(plan, out_w, out_h, landscape=False):
    records = []
    for shot in plan.shots:
        row = {**shot.summary(), "detected_layout": shot.detected_layout,
               "cam_face": shot.cam_face.to_list() if shot.cam_face else None,
               "focus_path": shot.focus_path, "crop_path": []}
        if landscape:
            w, h = plan.source_width, plan.source_height
            if abs(w / h - out_w / out_h) < .01 * out_w / out_h:
                destination = (0, 0, out_w, out_h)
            else:
                scale = min(out_w / w, out_h / h)
                fit_w, fit_h = int(w * scale + .5), int(h * scale + .5)
                destination = ((out_w - fit_w) // 2, (out_h - fit_h) // 2, fit_w, fit_h)
            views = [((0, 0, w, h), destination)]
        else:
            views = shot_views(shot, shot.start_ms, plan.source_width, plan.source_height, out_w, out_h)
            if shot.layout == analyzer.LayoutType.TALKING_HEAD:
                _, _, xs, ys = _fill_crop_path(shot, plan.source_width, plan.source_height, out_w, out_h)
                row["crop_path"] = [[round(t * 1000), round(x, 1), round(y, 1)] for (t, x), (_, y) in zip(xs, ys)]
        row["views"] = [{"source": list(source), "destination": list(dest)} for source, dest in views]
        records.append(row)
    return records


def make_trace(request, analysis_plan, attempted_plan, rendered_plan, time_map,
               window_start, window_ms, width, height, fps, attempts, settings):
    analysis = analysis_plan.trace if analysis_plan is not None and analysis_plan.trace else {}
    rate = float(Fraction(fps))
    output_frame = 0
    video = []
    for shot, start, count in video_frame_pieces(rendered_plan, time_map.keeps, fps):
        video.append({"shot": shot, "source_start_ms": start * 1000 / rate,
                      "source_end_ms": (start + count) * 1000 / rate,
                      "output_start_ms": output_frame * 1000 / rate,
                      "output_end_ms": (output_frame + count) * 1000 / rate})
        output_frame += count
    return {
        "version": TRACE_VERSION,
        "source": {"width": rendered_plan.source_width, "height": rendered_plan.source_height},
        "window": {"start_ms": window_start, "duration_ms": window_ms,
                   "requested_start_ms": request.start_time_ms, "requested_end_ms": request.end_time_ms},
        "output": {"width": width, "height": height, "duration_ms": time_map.output_ms, "fps": rate},
        "sample_fps": analyzer.ANALYSIS_FPS,
        "thresholds": {name: getattr(analyzer, name) for name in (
            "FACE_SCORE_THRESHOLD", "STRONG_FACE_SCORE", "COMPETING_FACE_SCORE", "SHOT_CUT_THRESHOLD", "MIN_SHOT_MS", "LAYOUT_CHANGE_MS",
            "LAYOUT_CHANGE_SAMPLES", "MIN_TRACK_PRESENCE", "OVERLAY_MAX_FACE_HEIGHT", "MIN_FACE_HEIGHT")},
        "config": {"style": request.layout_style, "pacing": request.pacing,
                   "vision_enabled": bool(settings.layout_vision_enabled),
                   "vision_model": settings.layout_vision_model, "detector": "YuNet face_detection_yunet_2023mar",
                   "analysis_width": analyzer.ANALYSIS_WIDTH},
        "analysis_status": "recorded" if analysis else "unavailable",
        "samples": analysis.get("samples", []), "boundaries": analysis.get("boundaries", []),
        "decisions": analysis.get("decisions", []),
        "attempted_plan": plan_record(attempted_plan, width, height, request.aspect_ratio == "16:9"),
        "rendered_plan": plan_record(rendered_plan, width, height, request.aspect_ratio == "16:9"),
        "attempts": attempts, "keeps": time_map.keeps,
        "planner_skips": [[max(0, a - window_start), min(window_ms, b - window_start)]
                          for a, b in request.skip_ranges_ms if b > window_start and a < window_start + window_ms],
        "video_pieces": video,
        "editorial": request.editorial_context,
    }


def save_trace(path, trace):
    """Only caller-constructed allowlisted facts; never provider payloads or errors."""
    encoded = json.dumps(trace, allow_nan=False, separators=(",", ":")).encode()
    if len(encoded) > MAX_TRACE_BYTES:
        raise ValueError("Framing trace exceeds the size limit")
    with open(path, "xb") as output:
        os.chmod(path, 0o600)
        output.write(encoded)
