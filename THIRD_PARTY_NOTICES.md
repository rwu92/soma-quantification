# Third-party software

Soma Quantification bundles the following software in `assets/vendor/`, unchanged unless noted. Each
keeps its own licence; the MIT licence in `LICENSE` covers only this project's own code.

| Software | Version | Licence | Used for |
|---|---|---|---|
| [Pyodide](https://pyodide.org) | 314.0.6 | Mozilla Public License 2.0 (`assets/vendor/pyodide/v314.0.6/LICENSE.pyodide.txt`) | Python in the browser, to read ND2 files |
| CPython standard library (in Pyodide, `python_stdlib.zip`) | 3.14.2 | Python Software Foundation License | Part of Pyodide |
| [nd2](https://github.com/tlambert03/nd2) | 0.11.3 | BSD 3-Clause | Reading Nikon ND2 files |
| [NumPy](https://numpy.org) | 2.4.6 | BSD 3-Clause | Array maths for ND2 reading and Z projection |
| [typing_extensions](https://github.com/python/typing_extensions) | 4.15.0 | Python Software Foundation License | Dependency of nd2 |
| [zstandard](https://github.com/indygreg/python-zstandard) | 0.25.0 | BSD 3-Clause | Dependency of nd2 |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | MIT (dual-licensed MIT or GPL-3.0; used under MIT) | Reading and writing ZIP files |
| [pako](https://github.com/nodeca/pako) (inflate) | 2.1.0 | MIT and Zlib | Decompressing Deflate-compressed TIFFs |
| [UTIF.js](https://github.com/photopea/UTIF.js) | 3.1.0 | MIT | Reading compressed TIFFs. Local changes, described at the top of the file: compression 32946 (legacy Adobe Deflate) is read like Deflate, and JPEG-compressed TIFFs tagged RGB are not colour-converted twice. |

If the bundled Pyodide cannot be loaded, the page falls back to the same Pyodide version from
https://cdn.jsdelivr.net/pyodide/v314.0.6/full/.
