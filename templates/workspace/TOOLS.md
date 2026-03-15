# TOOLS.md - Workspace Tool Overrides

Discoclaw already injects the tracked tool and environment instructions from
`templates/instructions/TOOLS.md` at runtime.

Use this file only for workspace-specific overrides, clarifications, and local
environment notes that should apply after the tracked version.

Good uses for this file:

- exact local paths, ports, or service names for this install
- ask-first rules that are specific to this machine or workspace
- local tool wrappers or operational shortcuts not worth tracking in git

If you do not have any local overrides, you can delete this file.
