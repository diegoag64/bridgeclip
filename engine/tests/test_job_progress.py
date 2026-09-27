from clip_engine.services.job_progress import StageProgress


def test_measured_stage_counts_and_elapsed_freeze_at_completion():
    now = [10.0]
    tracker = StageProgress(clock=lambda: now[0])
    tracker.update('downloading', percent=25, completed=250, total=1000, unit='bytes')
    now[0] += 2
    rows = tracker.update('transcribing', percent=None)
    assert rows[0] == {'id': 'download', 'state': 'completed', 'percent': 100, 'elapsed_ms': 2000, 'completed': 250, 'total': 1000, 'unit': 'bytes'}
    assert rows[2]['percent'] is None
    now[0] += 3
    finished = tracker.update('completed')
    assert finished[2]['elapsed_ms'] == 3000
    assert finished[1]['state'] == 'skipped'
    now[0] += 100
    assert tracker.snapshot() == finished


def test_failure_and_review_workflow_do_not_claim_render_completion():
    tracker = StageProgress(review=True, clock=lambda: 10)
    tracker.update('rendering', stage='preparing', percent=30)
    rows = tracker.update('failed')
    preparing = next(row for row in rows if row['id'] == 'preparing')
    assert preparing['state'] == 'failed'
    assert preparing['percent'] == 30
    assert not any(row['id'] == 'rendering' for row in rows)
    assert rows[0]['state'] == 'pending'


def test_progress_messages_are_bounded_but_terminal_is_always_delivered():
    from clip_engine.services.ai_clipping_pipeline import AIClippingPipeline, JobStatus
    pipeline = object.__new__(AIClippingPipeline)
    updates = []
    pipeline.progress_callback = updates.append
    pipeline._current_callback_url = None
    pipeline._stage_progress = StageProgress()
    for percent in range(100):
        pipeline._update_progress('test', JobStatus.DOWNLOADING, percent, 'Downloading', stage_percent=percent)
    pipeline._update_progress('test', JobStatus.COMPLETED, 100, 'Complete')
    assert len(updates) < 10
    assert updates[-1].status == JobStatus.COMPLETED
    assert updates[-1].stages[0]['state'] == 'completed'


def test_real_encoding_progress_preserves_file_backed_long_filter_graph(tmp_path):
    import asyncio
    from clip_engine.services.rendering_service import RenderingService
    from .test_camera_scan import source_video
    source = source_video(tmp_path)
    output = tmp_path / 'render.mp4'
    graph = '[0:v]' + ','.join(['null'] * 2200) + '[base]'
    updates = []
    asyncio.run(RenderingService()._run_cmd(['ffmpeg', '-v', 'error', '-i', str(source),
        '-filter_complex', graph, '-map', '[base]', '-c:v', 'libx264', str(output)],
        progress=updates.append, duration_ms=2500))
    assert output.stat().st_size > 0
    assert updates[0] == 0 and updates[-1] == 100
    assert updates == sorted(set(updates))
    assert any(0 < value < 100 for value in updates)
