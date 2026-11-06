---
'@astryxdesign/cli': patch
---

[fix] `astryx swizzle` now gives you a copy that builds with no edits. Before, the copy sent every import that left the component folder to the package's folder entry, which does not export the internal helpers most components use, so `Button`, `Dialog`, `Table` and about 100 other copies failed to type-check or bundle. Now the copy imports what the package exports from the package, carries every internal module it needs beside it in the package's folder layout, and copies the nested folders it imports (such as `Table`'s `plugins/`). Test helpers and notes are no longer copied. A helper an earlier swizzle wrote is reused when it is the same and is never replaced, even with `--overwrite`: a different one stays, and the new copy writes its own under a version-suffixed name. Fixes #3506.

@cixzhang @jiunshinn
