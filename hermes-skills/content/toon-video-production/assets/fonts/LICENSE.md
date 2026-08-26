# Bundled font

`DejaVuSans-Bold.ttf` is bundled so the FFmpeg `subtitles` filter never
depends on system font configuration (a known failure mode: missing fonts
break ASS caption burns silently or with tofu glyphs). The assembly step
passes `fontsdir=` pointing at this directory.

DejaVu fonts are free/redistributable under the DejaVu Fonts License
(a Bitstream Vera derivative): https://dejavu-fonts.github.io/License.html

To use a brand font instead, drop the .ttf here and set:

```
TOON_FONT_PATH=/absolute/path/to/font.ttf
TOON_FONT_NAME="Exact Font Family Name"
```

and update `Fontname` in the caption template(s) to match `TOON_FONT_NAME`.
