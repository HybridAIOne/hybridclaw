# Native MLX dependency notices

This component is installed on demand with `uv.lock`. Packages are downloaded
from PyPI or the pinned source archive below; distributions retain their license
files. No model weights are included in the npm package. Models have separate
pinned license metadata.

Reviewed 2026-09-09 against the installed, locked wheel metadata. No strong
copyleft dependencies were found. certifi and tqdm include MPL-2.0 obligations;
their unmodified distributions retain those notices and source references.

| Package | Version | License |
| --- | --- | --- |
| [annotated-doc](https://pypi.org/project/annotated-doc/0.0.5/) | 0.0.5 | MIT |
| [anyio](https://pypi.org/project/anyio/4.15.1/) | 4.15.1 | MIT |
| [certifi](https://pypi.org/project/certifi/2026.7.22/) | 2026.7.22 | MPL-2.0 |
| [click](https://pypi.org/project/click/8.5.0/) | 8.5.0 | BSD-3-Clause |
| [filelock](https://pypi.org/project/filelock/3.32.6/) | 3.32.6 | MIT |
| [fsspec](https://pypi.org/project/fsspec/2026.7.0/) | 2026.7.0 | BSD-3-Clause |
| [h11](https://pypi.org/project/h11/0.16.0/) | 0.16.0 | MIT |
| [hf-xet](https://pypi.org/project/hf-xet/1.6.0/) | 1.6.0 | Apache-2.0 |
| [httpcore](https://pypi.org/project/httpcore/1.0.9/) | 1.0.9 | BSD-3-Clause |
| [httpx](https://pypi.org/project/httpx/0.28.1/) | 0.28.1 | BSD-3-Clause |
| [huggingface_hub](https://pypi.org/project/huggingface_hub/1.30.0/) | 1.30.0 | Apache-2.0 |
| [idna](https://pypi.org/project/idna/3.19/) | 3.19 | BSD-3-Clause |
| [Jinja2](https://pypi.org/project/Jinja2/3.1.6/) | 3.1.6 | BSD-3-Clause |
| [markdown-it-py](https://pypi.org/project/markdown-it-py/4.2.0/) | 4.2.0 | MIT |
| [MarkupSafe](https://pypi.org/project/MarkupSafe/3.0.3/) | 3.0.3 | BSD-3-Clause |
| [mdurl](https://pypi.org/project/mdurl/0.1.2/) | 0.1.2 | MIT |
| [mlx](https://pypi.org/project/mlx/0.32.2/) | 0.32.2 | MIT |
| [mlx-lm](https://pypi.org/project/mlx-lm/0.31.3/) | 0.31.3 | MIT |
| [mlx-metal](https://pypi.org/project/mlx-metal/0.32.2/) | 0.32.2 | MIT |
| [numpy](https://pypi.org/project/numpy/2.5.3/) | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| [packaging](https://pypi.org/project/packaging/26.3/) | 26.3 | Apache-2.0 OR BSD-2-Clause |
| [protobuf](https://pypi.org/project/protobuf/7.36.1/) | 7.36.1 | BSD-3-Clause |
| [Pygments](https://pypi.org/project/Pygments/2.21.0/) | 2.21.0 | BSD-2-Clause |
| [PyYAML](https://pypi.org/project/PyYAML/6.0.3/) | 6.0.3 | MIT |
| [regex](https://pypi.org/project/regex/2026.9.3/) | 2026.9.3 | Apache-2.0 AND CNRI-Python |
| [rich](https://pypi.org/project/rich/15.0.0/) | 15.0.0 | MIT |
| [safetensors](https://pypi.org/project/safetensors/0.8.0/) | 0.8.0 | Apache-2.0 |
| [sentencepiece](https://pypi.org/project/sentencepiece/0.2.2/) | 0.2.2 | Apache-2.0 |
| [shellingham](https://pypi.org/project/shellingham/1.5.4/) | 1.5.4 | ISC |
| [tokenizers](https://pypi.org/project/tokenizers/0.23.2/) | 0.23.2 | Apache-2.0 |
| [tqdm](https://pypi.org/project/tqdm/4.70.0/) | 4.70.0 | MPL-2.0 AND MIT |
| [transformers](https://pypi.org/project/transformers/5.16.1/) | 5.16.1 | Apache-2.0 |
| [typer](https://pypi.org/project/typer/0.27.2/) | 0.27.2 | MIT |
| [spark-mlx-llm](https://github.com/XHToken/Spark-MLX-LLM/tree/de2b4379fa1e2f2e1f99d84c83f0e008f651d86c) | 0.1.0, commit de2b4379 | Apache-2.0 |
| [typing_extensions](https://pypi.org/project/typing_extensions/4.16.0/) | 4.16.0 | PSF-2.0 |

The Spark extension was reviewed on 2026-09-10. Its source archive and SHA-256
are pinned in `uv.lock`; its model registration exposes a packaged implementation
to MLX-LM. HybridClaw does not call its registry-download loader or import Python
from the model checkpoint. The upstream Apache-2.0 license remains in the installed
distribution. No npm dependency changes are associated with this Python component.
