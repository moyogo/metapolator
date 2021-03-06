
The verbatim directory contains plain clones of font data that can be
used in examples. Works derived from the fonts in the verbatim
directory will be placed into other directories depending on purpose.
For example, a subset of the glyphs of Merriweather-Regular.otf might
be saved into subsets/Merriweather-Regular-PAN.ufo to allow quicker
tinkering using only the PAN glyphs or some other subset.

The test/components.ufo font is for UFO component testing. It consists
of three glyphs: a, b, and c. The c is drawn with a horizontal bar
across the bottom of the glyph. The b has a bar across the middle of
the glyph and a component reference to the c glyph (this b should be
two horizontal bars). The a has a horizontal bar across the top of the
glyph and a component reference to the 'b' glyph. Thus the 'a' glyph
should be rendered as three horizontal lines. This allows testing not
only single component references, but also recursive references.

components-reverse.ufo is a semantic reverse of components.ufo in that
the 'c' glyph has a reference to 'b' which references 'a'. This is to
test out if the order of loading glyphs has any impact on the
correctness of the result. ie, if it just happens that loading the glyphs
in a specific order allows the component references to be connected.

I also hand crafted test/components-circular.ufo to test bad font
loading. The components-circular font is based on the above but having
'c' referencing 'a' and thus creating a circular reference which is
expressly not allowed by the UFO specification:
http://unifiedfontobject.org/versions/ufo3/glif.html#component
