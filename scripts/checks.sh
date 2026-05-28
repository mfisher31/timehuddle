#!/usr/bin/env bash
# checks.sh — Run all CI checks locally (mirrors .github/workflows/checks.yml).
#
# Usage:
#   ./scripts/checks.sh              # run all jobs
#   ./scripts/checks.sh frontend     # run frontend job only
#   ./scripts/checks.sh backend      # run backend job only
#   ./scripts/checks.sh --fix        # auto-fix lint + format, then run all jobs
#   ./scripts/checks.sh backend --fix  # auto-fix then run backend job only
#
# Requirements:
#   - nvm (or the correct Node version already active)
#   - MongoDB running on localhost:27017 (for backend tests)

set -euo pipefail

cd "$(dirname "$0")/.."

# Parse --fix flag from any argument position
FIX=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--fix" ]]; then
    FIX=true
  else
    ARGS+=("$arg")
  fi
done
set -- "${ARGS[@]+${ARGS[@]}}"

# Activate the pinned Node version if nvm is available
# nvm is usually a shell function, so source it in non-interactive shells.
if [[ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
  # shellcheck disable=SC1090
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
fi

if command -v nvm &>/dev/null; then
  nvm use
elif [ -f .nvmrc ]; then
  echo "Warning: nvm not found. Ensure Node $(cat .nvmrc) is active." >&2
fi

run_frontend() {
  echo ""
  echo "==> Frontend — lint, format, typecheck, test, build"
  if [[ "$FIX" == "true" ]]; then
    npm run lint:fix
    npm run format:fix
  else
    npm run lint
    npm run format
  fi
  npm run typecheck
  CI=1 npm test
  npm run build
  echo "==> Frontend: PASSED"
}

check_mongo() {
  local uri="${MONGODB_URI:-mongodb://localhost:27017/timehuddle_test}"
  local host
  host=$(echo "$uri" | sed -E 's|mongodb://([^/]+)/.*|\1|')
  local hostname="${host%%:*}"
  local port="${host##*:}"
  [[ "$port" == "$hostname" ]] && port=27017

  if ! nc -z "$hostname" "$port" 2>/dev/null; then
    echo "Error: MongoDB is not reachable at $hostname:$port" >&2
    echo "Start MongoDB before running backend checks." >&2
    exit 1
  fi
}

run_backend() {
  echo ""
  echo "==> Backend — lint, format, typecheck, build, test"
  check_mongo
  local test_videos_dir="$PWD/backend/.tmp/videos"
  mkdir -p "$test_videos_dir"
  (
    cd backend
    if [[ "$FIX" == "true" ]]; then
      npm run lint:fix
      npm run format:fix
    else
      npm run lint
      npm run format
    fi
    npm run typecheck
    npm run build
    MONGODB_URI="${MONGODB_URI:-mongodb://localhost:27017/timehuddle_test}" \
    BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-local-test-secret}" \
    TIMEHUDDLE_VIDEOS_DIR="$test_videos_dir" \
    PORT="${PORT:-4000}" \
    CI=1 npm test
  )
  echo "==> Backend: PASSED"
}

run_playwright() {
  echo ""
  echo "==> Playwright — E2E tests"
  npx playwright test -j4 --fully-parallel
  echo "==> Playwright: PASSED"
}

JOB="${1:-all}"


case "$JOB" in
  frontend)   run_frontend ;;
  backend)    run_backend ;;
  playwright) run_playwright ;;
  all)
    run_frontend
    run_backend
    run_playwright
    echo ""
    echo "All checks passed."
    ;;
  *)
    echo "Unknown job: $JOB. Use: frontend | backend | playwright | all" >&2
    exit 1
    ;;
esac
