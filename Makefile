SHELL := /bin/sh
PYTHON ?= python3

# `make version 1.2.3` would otherwise make Make treat 1.2.3 as a second
# target. The version target reads those goals itself, and the pattern rule
# below accepts only something that looks like a version. Unknown targets are
# still refused rather than silently ignored.
VERSION_GOALS := $(filter-out version,$(MAKECMDGOALS))

.DEFAULT_GOAL := help

.PHONY: help show-version check-version version release

help:
	@printf '%s\n' \
	  'make show-version          print the version in version.yml' \
	  'make check-version         verify every manifest agrees with version.yml' \
	  'make version               increment the patch version, commit and tag' \
	  'make version 1.2.3         set an explicit version, commit and tag' \
	  'make version VERSION=1.2.3 the same, using a Make variable' \
	  'make release               publish the tagged HEAD as a GitHub release'

show-version:
	@$(PYTHON) tools/version.py show

check-version:
	@$(PYTHON) tools/version.py check

version:
	@$(PYTHON) tools/version.py $(if $(strip $(VERSION) $(VERSION_GOALS)),set $(strip $(VERSION) $(VERSION_GOALS)),bump)

release:
	@$(PYTHON) tools/version.py release

# Absorb the positional version accepted by `make version X.Y.Z`. Anything
# else is an unknown target, not an argument to swallow.
%:
	@case "$@" in \
	  *.*.*) : ;; \
	  *) echo "Unknown target: $@" >&2; exit 2 ;; \
	esac
