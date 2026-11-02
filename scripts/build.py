#!/usr/bin/env python3
"""Assemble assets/apps/soma.js from the source parts in src/soma/, in name order.

    python3 scripts/build.py           write assets/apps/soma.js
    python3 scripts/build.py --check   exit with an error if it is out of date
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
parts = sorted((ROOT / 'src' / 'soma').glob('*.part.js'))
if not parts:
    sys.exit('No source parts in src/soma/')
text = ''.join(p.read_text() for p in parts)
target = ROOT / 'assets' / 'apps' / 'soma.js'
if '--check' in sys.argv:
    if target.read_text() != text:
        sys.exit('assets/apps/soma.js is out of date: run python3 scripts/build.py')
    print('assets/apps/soma.js is up to date')
else:
    target.write_text(text)
    print(f'wrote {target.relative_to(ROOT)} from {len(parts)} parts')
