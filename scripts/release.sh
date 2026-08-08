#!/usr/bin/env bash
# Release fm-access-pcc to npm and GitHub Releases.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# --- Parse args ---

SKIP_NPM=false
YES=false
VERSION_TYPE="patch"

for arg in "$@"; do
  case "$arg" in
    --skip-npm) SKIP_NPM=true ;;
    -y|--yes) YES=true ;;
    patch|minor|major) VERSION_TYPE="$arg" ;;
    *)
      echo "Usage: $0 [patch|minor|major] [--skip-npm] [-y|--yes]" >&2
      exit 1
      ;;
  esac
done

# --- Preflight checks ---

if ! command -v gh >/dev/null 2>&1; then
  echo "Error: GitHub CLI (gh) is required. Install: https://cli.github.com/" >&2
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "Error: gh is not authenticated. Run: gh auth login" >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ "$BRANCH" != "master" && "$BRANCH" != "main" ]]; then
  echo "Error: release from master/main only (current: $BRANCH)" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Error: working tree is not clean" >&2
  git status --short >&2
  exit 1
fi

PKG_NAME="$(node -p "require('./package.json').name")"

if [[ "$SKIP_NPM" == false ]]; then
  if ! npm whoami >/dev/null 2>&1; then
    echo "Error: not logged in to npm (npm whoami failed). Use --skip-npm or run npm login." >&2
    exit 1
  fi
fi

# Avoid network install side-effects during release verification
export FM_ACCESS_PCC_SKIP_CUA_DRIVER_POSTINSTALL=1
export FM_ACCESS_PCC_AUTO_SERVE=0

# --- Build & test ---

echo "Building..."
bun run build

echo "Running tests..."
bun run test

echo "Type checking..."
bun run typecheck

# --- Dry-run pack ---

echo "Dry-run pack..."
npm pack --dry-run

# --- Confirm ---

if [[ "$YES" != true ]]; then
  if [[ "$SKIP_NPM" == true ]]; then
    read -r -p "Bump $VERSION_TYPE and create a GitHub release (skip npm)? [y/N] " confirm
  else
    read -r -p "Bump $VERSION_TYPE, publish to npm, and create a GitHub release? [y/N] " confirm
  fi
  if [[ "$confirm" != "y" && "$confirm" != "Y" ]]; then
    echo "Aborted."
    exit 0
  fi
else
  echo "Proceeding with non-interactive release (-y): $VERSION_TYPE (skip-npm=$SKIP_NPM)"
fi

# --- Version bump ---

npm version "$VERSION_TYPE" --no-git-tag-version
VERSION="$(node -p "require('./package.json').version")"
TAG="v${VERSION}"

# bun.lock may reference workspace name/version — stage if changed
git add package.json
if [[ -f bun.lock ]]; then
  git add bun.lock 2>/dev/null || true
fi
git commit -m "chore: release ${TAG}"

echo "Creating git tag ${TAG}..."
git tag "${TAG}"

# --- Pack & publish ---

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Packing tarball..."
# npm pack prints the filename; also place in TMP_DIR
PACK_OUT="$(npm pack --pack-destination "$TMP_DIR" 2>/dev/null | tail -n1)"
TARBALL="${TMP_DIR}/${PACK_OUT}"
if [[ ! -f "$TARBALL" ]]; then
  # Fallback to conventional name
  TARBALL="${TMP_DIR}/${PKG_NAME}-${VERSION}.tgz"
fi
if [[ ! -f "$TARBALL" ]]; then
  echo "Error: expected tarball not found in ${TMP_DIR}" >&2
  ls -la "$TMP_DIR" >&2 || true
  exit 1
fi
echo "Packed: $TARBALL"

if [[ "$SKIP_NPM" == false ]]; then
  echo "Publishing to npm..."
  npm publish --access public
else
  echo "Skipping npm publish (--skip-npm)"
fi

# --- Push & GitHub release ---

echo "Pushing to GitHub..."
git push origin HEAD
git push origin "${TAG}"

echo "Creating GitHub release ${TAG}..."
if gh release view "${TAG}" >/dev/null 2>&1; then
  gh release upload "${TAG}" "${TARBALL}" --clobber
else
  gh release create "${TAG}" \
    --title "fm-access-pcc ${TAG}" \
    --generate-notes \
    "${TARBALL}"
fi

RELEASE_URL="$(gh release view "${TAG}" --json url --jq .url)"

echo ""
echo "Release complete:"
if [[ "$SKIP_NPM" == false ]]; then
  echo "  npm:    ${PKG_NAME}@${VERSION}"
fi
echo "  github: ${RELEASE_URL}"
