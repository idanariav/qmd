#!/usr/bin/env bash
set -euo pipefail

# Re-index all collections and regenerate vector embeddings.
#
# Usage: scripts/reindex.sh

qmd index && qmd embed
