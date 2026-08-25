"""
sentinel_video -- the front door between the research desk and the video engine.

This package is deliberately small. The desk (sentinel/) decides what is true
and exports findings.json; openmontage renders video. Neither should know about
the other's internals, so the only thing here is the door between them: a
validator that says whether a findings deck can safely become a video, and
refuses it with a reason when it cannot.

WHY A VALIDATOR AND NOT A CONVERTER
    A converter would paper over the interesting cases. If a finding has no
    source, the right outcome is not "render it without a citation" -- it is
    "stop, this cannot go on screen." Video is the least correctable medium
    the desk publishes to: a bad number in a document can be amended, and a
    bad number burned into 900 frames and posted is a re-render and a
    correction notice.
"""
__version__ = "1.0.0"
