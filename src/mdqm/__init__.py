"""MIDAS custom-page DQM.

Two halves, kept apart on purpose:

``mdqm.dqm``      generic machinery -- event sourcing, histogram accumulation,
                  the expression sandbox, the brpc server. Knows nothing about
                  any particular detector.
``mdqm.plugins``  per-experiment decoding. ``wavedream`` is the only one today.

The pages in ``pages/`` follow the same split: ``dqm-common.js`` is generic,
``dqm-scalars.js`` and friends are not.
"""

__version__ = "0.1.0"
