# Script extraction fixtures

`two-scene-play.txt` and `two-scene-play-es.txt` are the hand-authored English
and Spanish sources for the DOCX and PDF fixtures.
Run `python fixtures/plays/generate-fixtures.py` from the repository root to
reproduce both binaries. The generator uses only Python's standard library,
fixed ZIP metadata, a fixed document body, and deterministic PDF object offsets.
The fixtures are purpose-written for this repository and contain no third-party
or production documents.

## Public-domain full-length fixtures

Three UTF-8 Project Gutenberg texts provide realistic regression inputs at
different sizes: `riders-to-the-sea.txt` (47 KB),
`the-importance-of-being-earnest.txt` (142 KB), and `hamlet.txt` (193 KB).
Their Project Gutenberg licenses and metadata remain embedded in each file;
the sources are the corresponding [GITenberg repositories](https://github.com/GITenberg).
These works are public domain in the United States; consumers should check
their local copyright rules. Interface icons in `apps/web/public/icons` come
from [Tabler Icons](https://github.com/tabler/tabler-icons) under the MIT license.
