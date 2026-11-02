# Pyodide 314.0.6 runtime for the ND2 engine

Bundled so ND2 (and CZI) files open without jsDelivr or PyPI: offline, on networks that block them, and
always with these exact files. Loaded by `ToolkitCore.nd2` (`assets/toolkit-core.js`), which falls back
to https://cdn.jsdelivr.net/pyodide/v314.0.6/full/ only if this copy fails. Hashes in `vendor-lock.json`.

| File | Source | License |
|---|---|---|
| pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm, python_stdlib.zip, pyodide-lock.json | cdn.jsdelivr.net/pyodide/v314.0.6/full/ | Pyodide: MPL-2.0 (LICENSE.pyodide.txt); CPython standard library: PSF License |
| numpy-2.4.6 (wheel) | same; sha256 matches pyodide-lock.json | BSD-3-Clause (inside the wheel) |
| typing_extensions-4.15.0 (wheel) | same; sha256 matches pyodide-lock.json | PSF-2.0 (inside the wheel) |
| zstandard-0.25.0 (wheel, CZI only) | same; sha256 matches pyodide-lock.json | BSD-3-Clause (inside the wheel) |
| nd2-0.11.3-py3-none-any.whl | files.pythonhosted.org (PyPI); sha256 matches PyPI | BSD-3-Clause (inside the wheel) |

Only the packages above are bundled. To update, download the new release's files and wheels to a new
`assets/vendor/pyodide/vX/` folder, check them against its `pyodide-lock.json` and PyPI, and change the
version in `assets/toolkit-core.js` (the project check keeps pages on the same version).
