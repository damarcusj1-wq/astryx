---
'@astryxdesign/core': patch
---

[perf] Closing a Popover, menu or other anchored layer no longer lays out the page an extra time. The layer runtime reads the closing layer's animations only when a transition that holds `display` or `overlay` can keep the hidden layer shown, and it reads that before the close changes anything. A layer that fades out, as TopNavMegaMenu's panel does, still keeps its trigger's anchor name until the fade ends.
