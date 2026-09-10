"""Stop exact reasoning cycles without limiting the length of productive thought.

This guard observes generated reasoning tokens, never prompts or tool arguments.
It cancels the native generation context on a loop and emits only a fixed error.
"""

from collections import deque


class ReasoningLoopError(ValueError):
    def __init__(self):
        super().__init__("Local model stopped because its reasoning repeated in a loop. Retry the request or select another model.")


def guard_reasoning_stream(context, stream):
    # 2026-09-10, Codex conservative guard for the owner's long-reasoning request:
    # >=256 tokens, >=4 exact cycles, periods <=256, checked every 16 tokens.
    # Semantic/near-repeat detection is deferred to avoid cutting off valid thought.
    recent = deque(maxlen=1024)
    count = 0
    try:
        for response in stream:
            if response.state != "reasoning":
                recent.clear()
                count = 0
            else:
                recent.append(response.token)
                count += 1
                if len(recent) >= 256 and count % 16 == 0:
                    # A Z scan of the reversed suffix reuses overlapping matches.
                    # At most 1024 tokens are scanned per checkpoint, instead of
                    # rescanning the same suffix separately for every period.
                    tokens = list(reversed(recent))
                    matches = [0] * len(tokens)
                    left = right = 0
                    for period in range(1, min(256, len(tokens) // 4) + 1):
                        if period <= right:
                            matches[period] = min(right - period + 1, matches[period - left])
                        length = matches[period]
                        while period + length < len(tokens) and tokens[length] == tokens[period + length]:
                            length += 1
                        matches[period] = length
                        if period + length - 1 > right:
                            left, right = period, period + length - 1
                        if length >= max(256, period * 4) - period:
                            raise ReasoningLoopError()
            yield response
    finally:
        context.stop()
