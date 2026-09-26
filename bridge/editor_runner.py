"""Private editor worker. Main validates the library root and owns its lock."""
import asyncio
import json
import os
import sys
import signal

from bridge_runner import reserve_stdout_for_protocol, emit


def main():
    reserve_stdout_for_protocol()
    try:
        raw = sys.stdin.read(16385)
        if len(raw) > 16384:
            raise ValueError('Request too large')
        config = json.loads(raw)
        if config.get('action') not in ('review', 'export') or not os.path.isabs(config['run']):
            raise ValueError('Invalid editor action')
        os.environ['LOCAL_MODE'] = 'true'
        from network_guard import install
        install()
        from clip_engine.logging_safety import install_safe_logging
        install_safe_logging()
        from clip_engine.services.manual_editor import run_editor
        async def work():
            task = asyncio.current_task()
            if os.name != 'nt':
                asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, task.cancel)
            await run_editor(config)
        asyncio.run(work())
        emit({'ok': True})
        return 0
    except (Exception, asyncio.CancelledError):
        emit({'ok': False})
        return 1


if __name__ == '__main__':
    sys.exit(main())
