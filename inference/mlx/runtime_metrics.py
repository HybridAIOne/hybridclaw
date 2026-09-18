"""Count generated tokens without retaining their text, IDs, or task identity.

These process-lifetime counters serve authenticated health reads; they neither
change inference budgets nor sample GPU activity (the gateway reads macOS).
"""

import threading
import uuid


class RuntimeMetrics:
    def __init__(self):
        self._instance_id = uuid.uuid4().hex
        self._generated_tokens = 0
        self._lock = threading.Lock()

    def snapshot(self):
        with self._lock:
            return {"instanceId": self._instance_id, "generatedTokens": self._generated_tokens}

    def observe(self, stream):
        try:
            for response in stream:
                with self._lock:
                    self._generated_tokens += 1
                yield response
        finally:
            stream.close()
