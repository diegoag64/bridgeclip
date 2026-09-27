# Frame & review investigation — September 27, 2026

The slow review preparation was dominated by local video decoding, rather than Jev. A sparse-frame FFmpeg command placed its duration limit after the input. When the selected frames ended before that limit, FFmpeg could continue decoding the remainder of the source while the caller waited for EOF. Each candidate repeated this work.

## Evidence from the saved run

The inspected run used a 50:15.7 source (3840×2160 VP9, approximately 23.976 fps) and prepared 21 candidates. Its saved stage timings were:

| Stage | Elapsed |
| --- | ---: |
| Download / read video | 2:13 |
| Understand source | 0:21 |
| Transcribe | 1:09 |
| Find moments | 1:13 |
| Frame & review | 65:01 |
| Save files | 0:03 |
| Build preview | 8:26 |

For all 21 candidates, the recorded Jev review completion followed the layout-plan log by approximately 0.45–0.52 seconds. These are observed intervals, not provider-side timings. They point to framing as the primary bottleneck in this run.

## Fix and local comparison

`LayoutAnalyzer._precise_frames` now puts `-t` before `-i`, bounding input decoding to the camera-scan interval. The selected frame indices, timestamps, detection resolution, layout logic, and model choices are unchanged. FFmpeg documents the distinction between input and output duration limits in its [main options reference](https://ffmpeg.org/ffmpeg.html#Main-options).

Both versions were profiled locally using candidate 16's 30.679-second excerpt from the saved source. No provider requests were made.

| Measurement | Before | After |
| --- | ---: | ---: |
| Initial face sampling | 4.08 s | 6.34 s |
| Camera scan | 3.55 s | 6.39 s |
| Detailed face tracking | 317.41 s | 7.37 s |
| Combined camera scan + detailed tracking | 320.97 s | 13.76 s |
| Scanned frames | 759 | 759 |
| Analyzed frames | 165 | 165 |

The combined detailed pass was approximately 23.3× faster. Sampling/scan timings vary with machine load; this is a single-candidate comparison, not an end-to-end speed guarantee. The full 50-minute job has not been rerun. Build preview is a separate cost and remains unchanged.

A regression test uses real FFmpeg with sparse selected frames ending before the requested endpoint, verifies the input-bound duration option, and checks preserved frame timestamps. Existing framing tests also pass.

## Visibility for subsequent jobs

The progress screen now reports the candidate index, source-excerpt duration, current subtask, subtask progress when available, and cumulative time in:

- Face sampling
- Camera-change scanning
- Detailed face tracking
- Shot-layout checks
- Jev editorial review

Usage rows are grouped by requested model and pipeline stage, with calls in flight, failures, input/output tokens, and provider-reported cost. Responses update usage; a one-second heartbeat keeps elapsed diagnostics current during local processing. Missing usage and cost remain explicitly unknown. Cached Jev responses do not count as network requests. Completed jobs persist this breakdown alongside their stage timings; earlier jobs cannot recover telemetry that was never recorded.

Further optimization should use these measurements to distinguish local decoding, shot-layout model latency, and preview generation. Lower-resolution source proxies or candidate concurrency would require separate quality, memory, and throughput checks; neither is needed for this decoding-boundary fix.
