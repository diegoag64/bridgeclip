"""Private, atomic JSON checkpoints for one local clipping run. Never store keys."""

import hashlib
import json
import os
import stat
import tempfile
from contextvars import ContextVar
from dataclasses import asdict, fields, is_dataclass
from pathlib import Path
from typing import get_args, get_origin, get_type_hints


CURRENT = ContextVar('job_checkpoint', default=None)
MAX_BYTES = 32 * 1024 * 1024


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                     allow_nan=False, default=str).encode()).hexdigest()


def restore(cls, value):
    """Rebuild known dataclasses only; checkpoint data never chooses a Python type."""
    if value is None:
        return None
    if is_dataclass(cls):
        hints = get_type_hints(cls)
        return cls(**{f.name: restore(hints[f.name], value[f.name]) for f in fields(cls) if f.name in value})
    origin, args = get_origin(cls), get_args(cls)
    if origin is list:
        return [restore(args[0], entry) for entry in value]
    if args and type(None) in args:
        return restore(next(t for t in args if t is not type(None)), value)
    return value


class Checkpoints:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.directory.is_symlink() or not self.directory.is_dir():
            raise ValueError('Invalid checkpoint directory')

    def _path(self, namespace, inputs):
        return self.directory / (digest([namespace, inputs]) + '.json')

    def load(self, namespace, inputs):
        path = self._path(namespace, inputs)
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | getattr(os, 'O_NOFOLLOW', 0))
            with os.fdopen(fd, encoding='utf-8') as source:
                info = os.fstat(source.fileno())
                if path.is_symlink() or not stat.S_ISREG(info.st_mode) or info.st_size > MAX_BYTES:
                    return None
                data = json.load(source)
            if data.get('version') == 1 and data.get('digest') == digest(data.get('value')):
                return data['value']
        except (OSError, ValueError, TypeError, AttributeError):
            pass
        return None

    def save(self, namespace, inputs, value):
        if is_dataclass(value):
            value = asdict(value)
        payload = json.dumps({'version': 1, 'digest': digest(value), 'value': value},
                             ensure_ascii=True, allow_nan=False)
        if len(payload.encode()) > MAX_BYTES:
            raise ValueError('Checkpoint exceeds the size limit')
        temp = None
        try:
            with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=self.directory, delete=False) as output:
                temp = output.name
                output.write(payload)
                output.flush()
                os.fsync(output.fileno())
            os.replace(temp, self._path(namespace, inputs))
        finally:
            if temp and os.path.exists(temp):
                os.unlink(temp)


async def cached(namespace, inputs, operation, cls=None):
    store = CURRENT.get()
    value = store.load(namespace, inputs) if store else None
    if value is not None:
        return restore(cls, value) if cls else value
    result = await operation()
    if store:
        store.save(namespace, inputs, result)
    return result
