#!/usr/bin/env bash
#
# Release tag helper: reads the version from package.json, ensures the working
# tree is clean, tags `v<version>` and pushes the tag to origin.
#
# Usage:
#   ./scripts/release.sh          # tag v$(package.json version)
#   ./scripts/release.sh major    # bump major, then tag + push
#   ./scripts/release.sh minor    # bump minor, then tag + push
#   ./scripts/release.sh patch    # bump patch, then tag + push
#   ./scripts/release.sh 1.2.3    # force-exact version, then tag + push
#
# Conventions:
#   - Tag name is `v<version>` (e.g. `v0.2.0`).
#   - The version bump commits package.json + package-lock.json BEFORE tagging,
#     so the tag always points at the bumped version.
set -euo pipefail

cd "$(dirname "$0")/.."

ARG="${1:-}"

# --- Pre-flight safety checks (BEFORE any bump) -----------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "error: working tree is dirty. Commit or stash before tagging." >&2
  git status --short >&2
  exit 1
fi

# --- Resolve the target version --------------------------------------------
bump_version() {
  local current major minor patch next
  current="$(node -p "require('./package.json').version")"
  IFS='.' read -r major minor patch <<<"$current"
  minor="${minor:-0}"
  patch="${patch:-0}"

  case "$ARG" in
  major) next="$((major + 1)).0.0" ;;
  minor) next="${major}.$((minor + 1)).0" ;;
  patch) next="${major}.${minor}.$((patch + 1))" ;;
  esac
  npm version "$next" --no-git-tag-version >/dev/null
}

if [[ -n "$ARG" && "$ARG" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  npm version "$ARG" --no-git-tag-version >/dev/null
elif [[ "$ARG" == "major" || "$ARG" == "minor" || "$ARG" == "patch" ]]; then
  bump_version
elif [[ -n "$ARG" ]]; then
  echo "error: unknown argument '$ARG' (use major|minor|patch|<x.y.z>|none)" >&2
  exit 1
fi

# --- Commit the version change (if any) ------------------------------------
if [[ -n "$ARG" ]] && ! git diff --quiet package.json package-lock.json; then
  git add package.json package-lock.json
  git commit -m "chore: bump version"
fi

VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

if git rev-parse "$TAG" >/dev/null 2>&1; then
  echo "error: tag $TAG already exists." >&2
  exit 1
fi

echo "Tagging ${TAG}..."
git tag -a "$TAG" -m "Release ${TAG}"
git push origin "$TAG"
git push origin main
echo "Pushed ${TAG} ✨"