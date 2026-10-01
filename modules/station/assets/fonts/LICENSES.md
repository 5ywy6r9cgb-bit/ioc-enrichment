# Fonts shipped with the station

These are Latin subsets (woff2) made with fontTools `pyftsubset` from the fonts that the theme-factory themes name.

| File | Family | License |
|---|---|---|
| dejavu-sans*.woff2, dejavu-serif-bold.woff2 | DejaVu Sans / Sans Condensed / Sans Mono / Serif | Bitstream Vera Fonts license, plus public-domain changes by the DejaVu authors. Free to use, embed and redistribute. |
| freesans*.woff2, freeserif-bold.woff2 | GNU FreeFont (FreeSans, FreeSerif) | GPLv3 with the font exception. Embedding in documents and web pages does not bring those documents under the GPL. |

The station embeds only the faces the chosen theme uses, as data URIs in `assets/site.css`, so a built site never loads a font from another host.
