"""SUB/WAVE radio-documentaries production pipeline.

A deterministic harness with two LLM stages (research, write). Everything else
here is plain code. See ../producer-guide.md ("Automation & what's scriptable")
for the stage map, and ../script-format.md for the script contract these modules
enforce.
"""

__all__ = ["scriptmodel", "lint", "budget", "catalog"]
