"""Bounded OpenRouter Decisions adapter for Jev. No media, credentials or provider errors in records.

Contract: https://openrouter.ai/docs/guides/community/jev; pricing snapshot: 2026-09-24.
One instance belongs to one job. Cancellation propagates; failures are data.
"""
import asyncio
import copy
import hashlib
import json
import math
import re
import time
from typing import Literal, TypedDict

import httpx

MODEL = 'typesafe/jev-1.13'
RULE_VERSION = 'editorial-v2-openrouter'
ENDPOINT = 'https://openrouter.ai/api/alpha/decisions'
INPUT_USD_PER_TOKEN = .042 / 1_000_000


class Question(TypedDict):
    type: Literal['noul', 'choice', 'score']
    instructions: str
    criteria: dict | list


def noul(instructions: str, yes: str, no: str) -> Question:
    return {'type': 'noul', 'instructions': instructions, 'criteria': {'true': yes, 'false': no}}


def choice(instructions: str, criteria: dict[str, str]) -> Question:
    return {'type': 'choice', 'instructions': instructions, 'criteria': criteria}


def score(instructions: str, levels: list[str]) -> Question:
    return {'type': 'score', 'instructions': instructions, 'criteria': levels}


def _number(value, low=0, high=1):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError('Invalid judgment number')
    return value


def validate_answers(raw, questions):
    if not isinstance(raw, dict) or set(raw) != set(questions):
        raise ValueError('Missing judgments')
    answers = {}
    for key, question in questions.items():
        answer = raw[key]
        kind = question['type']
        if not isinstance(answer, dict) or answer.get('type') != kind:
            raise ValueError('Incorrect judgment type')
        if kind == 'noul':
            answers[key] = {'type': kind, 'noul': _number(answer.get('noul'))}
            continue
        options = set(question['criteria']) if kind == 'choice' else {str(i) for i in range(len(question['criteria']))}
        probabilities = answer.get('probabilities')
        if not isinstance(probabilities, dict) or set(probabilities) != options:
            raise ValueError('Incorrect judgment options')
        probabilities = {k: _number(v) for k, v in probabilities.items()}
        if abs(sum(probabilities.values()) - 1) > .005:
            raise ValueError('Invalid probability distribution')
        clean = {'type': kind, 'probabilities': probabilities, 'confidence': _number(answer.get('confidence'))}
        if kind == 'choice':
            selected = answer.get('choice')
            if selected not in options or probabilities[selected] < max(probabilities.values()) - .005:
                raise ValueError('Invalid selected option')
            clean['choice'] = selected
        else:
            value = _number(answer.get('score'), 0, len(options) - 1)
            if abs(value - sum(int(k) * v for k, v in probabilities.items())) > .02:
                raise ValueError('Inconsistent score')
            clean.update(score=value, legend={str(i): level for i, level in enumerate(question['criteria'])})
        answers[key] = clean
    return answers


class JevService:
    def __init__(self, api_key='', *, transport=None, max_requests=64, token_budget=180_000, timeout=15):
        self._api_key = api_key or ''
        self._transport = transport
        self._semaphore = asyncio.Semaphore(2)
        self._cache = {}
        self.max_requests, self.token_budget, self.timeout = max_requests, token_budget, timeout
        self.requests = self.reserved_tokens = self.input_tokens = self.output_tokens = 0
        self.estimated_cost_usd = 0.0
        self.request_seconds = 0.0

    @classmethod
    def from_settings(cls, settings):
        key = getattr(settings, 'openrouter_api_key', None) if getattr(settings, 'jev_enabled', True) else None
        return cls(key)

    @property
    def enabled(self):
        return bool(self._api_key)

    async def evaluate(self, state, questions: dict[str, Question]):
        payload = {'model': MODEL, 'state': state, 'questions': questions}
        encoded = json.dumps(payload, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        cache_id = hashlib.sha256(RULE_VERSION.encode() + encoded).hexdigest()
        record = {'status': 'disabled', 'model': MODEL, 'requested_model': MODEL, 'rule_version': RULE_VERSION,
                  'cache_id': cache_id, 'cache_hit': False, 'latency_ms': 0,
                  'input_tokens': None, 'output_tokens': None, 'cost_usd': None,
                  'estimated_cost_usd': None, 'answers': {}, 'questions': questions}
        if not self.enabled:
            return record
        # UTF-8 bytes are a conservative input-token reservation; reserve room
        # for the fixed, bounded answer schema too. No invented API token knobs.
        reserve = len(encoded) + 128 * len(questions)
        if not 1 <= len(questions) <= 16 or len(encoded) > 24_000:
            return {**record, 'status': 'evidence_limit'}
        async with self._semaphore:
            if cache_id in self._cache:
                return {**copy.deepcopy(self._cache[cache_id]), 'cache_hit': True, 'latency_ms': 0,
                        'input_tokens': 0, 'output_tokens': 0, 'cost_usd': 0.0, 'estimated_cost_usd': 0.0}
            now = time.monotonic()
            if self.requests >= self.max_requests or self.reserved_tokens + reserve > self.token_budget or self.request_seconds >= 120:
                return {**record, 'status': 'budget_exhausted'}
            self.requests += 1
            self.reserved_tokens += reserve
            record['status'] = 'unavailable'
            try:
                async with asyncio.timeout(self.timeout):
                    async with httpx.AsyncClient(transport=self._transport, timeout=self.timeout, follow_redirects=False) as client:
                        async with client.stream('POST', ENDPOINT, headers={'Authorization': f'Bearer {self._api_key}',
                                                  'Content-Type': 'application/json', 'Accept-Encoding': 'identity'}, content=encoded) as response:
                            response.raise_for_status()
                            if response.headers.get('content-encoding', 'identity').lower() != 'identity':
                                raise ValueError('Unsupported response encoding')
                            body = bytearray()
                            async for chunk in response.aiter_bytes():
                                body.extend(chunk)
                                if len(body) > 128_000:
                                    raise ValueError('Oversized response')
                data = json.loads(body)
                actual_model = data.get('model')
                if not isinstance(actual_model, str) or not re.fullmatch(re.escape(MODEL) + r'(?:-\d{8})?', actual_model):
                    raise ValueError('Unexpected model version')
                record['model'] = actual_model
                usage = data.get('usage', {})
                input_tokens = _number(usage.get('input_tokens'), 0, 1_000_000)
                output_tokens = _number(usage.get('output_tokens'), 0, 1_000_000)
                if not isinstance(input_tokens, int) or not isinstance(output_tokens, int):
                    raise ValueError('Invalid token usage')
                self.input_tokens += input_tokens
                self.output_tokens += output_tokens
                self.reserved_tokens += max(0, input_tokens + output_tokens - reserve)
                estimate = input_tokens * INPUT_USD_PER_TOKEN
                billed = usage.get('cost')
                if billed is not None:
                    billed = _number(billed, 0, 1000)
                self.estimated_cost_usd += billed if billed is not None else estimate
                record.update(input_tokens=input_tokens, output_tokens=output_tokens, cost_usd=billed, estimated_cost_usd=estimate)
                record.update(answers=validate_answers(data.get('answers'), questions), status='success')
            except asyncio.CancelledError:
                raise
            except (httpx.HTTPError, TimeoutError, ValueError, TypeError, AttributeError):
                pass  # Never retain response text, request headers or exception strings.
            elapsed = time.monotonic() - now
            self.request_seconds += elapsed
            record['latency_ms'] = round(elapsed * 1000)
            if record['status'] == 'success':
                self._cache[cache_id] = copy.deepcopy(record)
            return record
