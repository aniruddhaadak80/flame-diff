"""Deterministic engine for flame-diff.

The engine is deliberately dependency-free. Every operation is a pure function:
same input, same output, no clock, no network, no randomness. Time and any entropy
must be passed in by the caller.

The product's claim is that a trace comparison can be *proved* faithful. Three invariants
carry that claim, and each has a test that would fail if it broke:

  * `detokenize(tokenize(s)) == s` for every string s — the token stream loses nothing;
  * `canonicalize` is order-independent and idempotent — so the diff only ever reflects
    real changes in the work;
  * the edit script is minimal — proven against a brute-force longest-common-subsequence
    oracle, not against itself.
"""

from .api import OPERATIONS, analyse
from .protocol import EngineError, dispatch

__all__ = ["EngineError", "dispatch", "OPERATIONS", "analyse"]
__version__ = "0.1.0"