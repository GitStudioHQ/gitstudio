#!/bin/zsh
# (Re)creates the python fixture repo every scenario starts from. Idempotent.
# Six files reference MAX_RETRIES through four import styles, so a rename that
# "only updates the definition" is visible as five untouched files.
set -e
GSQA_DIR=${GSQA_DIR:-/tmp/gsqa-pylance}
P="$GSQA_DIR/proj"
PY=${GSQA_PYTHON:-$(command -v python3)}
rm -rf "$P"
mkdir -p "$P/app" "$P/tests" "$P/.vscode"
cat > "$P/.vscode/settings.json" <<EOF
{
  "python.defaultInterpreterPath": "$PY",
  "python.analysis.indexing": true,
  "python.analysis.diagnosticMode": "workspace",
  "files.refactoring.autoSave": true
}
EOF
: > "$P/app/__init__.py"
cat > "$P/app/config.py" <<'EOF'
"""Shared constants."""

MAX_RETRIES = 3
TIMEOUT_S = 30


def compute(x: int) -> int:
    return x * MAX_RETRIES
EOF
cat > "$P/app/service.py" <<'EOF'
from app.config import MAX_RETRIES, compute


def run(n: int) -> int:
    total = 0
    for _ in range(MAX_RETRIES):
        total += compute(n)
    return total
EOF
cat > "$P/app/worker.py" <<'EOF'
import app.config as cfg


def work() -> int:
    return cfg.MAX_RETRIES + cfg.TIMEOUT_S
EOF
cat > "$P/app/cli.py" <<'EOF'
from app import config


def main() -> None:
    print(config.MAX_RETRIES)
    print(config.compute(2))
EOF
cat > "$P/main.py" <<'EOF'
from app.config import MAX_RETRIES
from app.service import run

if __name__ == "__main__":
    print(run(MAX_RETRIES))
EOF
cat > "$P/tests/test_config.py" <<'EOF'
from app.config import MAX_RETRIES, compute


def test_compute() -> None:
    assert compute(1) == MAX_RETRIES
EOF
cd "$P"
git init -q -b main
git -c user.name=qa -c user.email=qa@example.com add -A
git -c user.name=qa -c user.email=qa@example.com commit -q -m "fixture"
echo "fixture repo at $P ($(git rev-parse --short HEAD))"
