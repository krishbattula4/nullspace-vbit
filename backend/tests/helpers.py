"""Test utility helpers."""
import time
from collections.abc import Callable


def wait_until(
    predicate: Callable[[], bool],
    timeout: float = 2.0,
    interval: float = 0.02,
) -> bool:
    """Poll predicate with time.sleep until it returns True, or timeout expires.

    Returns True as soon as the predicate holds, False on timeout.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(interval)
    return predicate()
