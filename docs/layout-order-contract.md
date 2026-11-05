# Diagnostic page-layout order

TAWB's ordinary order is semantic document order. It is predictable, agrees
with browser accessibility navigation, and remains `layout-default`. Visual
layout is an explicit diagnostic escape hatch for a page whose CSS has put a
thing somewhere unrelated to its document position. It never joins the normal
AX/PAGE/INSPECT/SOURCE view cycle.

The three command actions are:

- `layout-default`: use the extractor's existing document order;
- `layout-container`: reorder coherent groups only inside rendered layout
  containers;
- `layout-rectangle`: order every placeable block by its rendered rectangle.

Both readers expose them only through the command line: press `:` and type the
action id, such as `layout-rectangle`. None has a default key, and none is part
of the backslash view cycle. To return to ordinary reading, run
`layout-default`.

A layout action rebuilds the current page view and restores the current element,
not its old line number. Changing AX/PAGE/INSPECT/SOURCE keeps the selected
layout. Running `layout-default` removes all geometry metadata on the next
snapshot, so ordinary snapshots pay no layout-measurement cost.

## Geometry

Geometry is collected in one page-side extraction pass. Coordinates are document
coordinates, not terminal coordinates. Every emitted semantic item may carry:

- its first non-empty rendered rectangle;
- the direction and writing mode that govern its inline order;
- the chain of flex, grid, and CSS-column containers that place it;
- for each such container, the direct rendered child group containing it and
  that group's rectangle;
- whether the group is fixed or sticky.

Text uses the first non-empty `Range.getClientRects()` fragment. Controls and
atomic semantic items use their element's first non-empty client rectangle.
The group rectangle belongs to the direct child of the relevant layout
container, so a heading's words remain one heading and a purchase card remains
one card.

A rectangle is unavailable when the browser reports no finite non-empty box.
Hidden content remains governed by the existing extractor and is not made
visible merely to obtain coordinates.

Child-frame rectangles are translated through the hosting frame's rectangle.
Content from a frame that cannot be placed retains its existing frame position.

## Rectangle order

`layout-rectangle` is intentionally aggressive:

1. Cluster placeable blocks into visual rows when their vertical spans overlap,
   using a small tolerance for baselines that differ by a pixel or two.
2. Order rows by block progression (normally top to bottom).
3. Order blocks within a row by inline progression (left to right for LTR,
   right to left for RTL).
4. Preserve document order when rectangles overlap substantially or compare
   equal.
5. Keep an unplaceable block attached to the nearest placeable document-order
   predecessor; leading unplaceable blocks remain at the beginning.

This can interleave newspaper columns or a sidebar with an article. That is why
it is diagnostic and command-only.

## Container order

`layout-container` is conservative and hierarchical:

1. Ordinary block flow remains in document order.
2. At each flex or grid container, bundle items by the direct child that the
   container places. Order those child groups by visual row and inline position,
   then keep each group's internal order.
3. At a CSS multi-column container, order block groups down each column and
   then advance in the container's inline direction.
4. Apply the rule recursively from inner containers to outer containers.
5. A table row remains a group; cells follow their visual inline direction and
   the contents of a cell remain together.
6. Substantially overlapping groups retain document order. Fixed and sticky
   groups remain coherent and compare by their measured group rectangle rather
   than having their descendants scattered through the page.
7. Items without usable container geometry remain in their original position.

Container order may deliberately leave an inaccessible arrangement unchanged
when CSS does not expose an unambiguous grouping. Rectangle order is the more
forceful fallback.

## Existing behavior that must survive

Both diagnostic orders preserve the original block object and item metadata.
Activation, form editing, link destinations, table metadata, popup ownership,
shadow-root handling, frame identity, live-region diffing, and source-view place
restoration therefore continue to resolve the same element.

An opened popup remains beside its opener rather than being returned to a DOM
portal. Modal filtering remains the extractor's decision. A live refresh
reanchors by element after reordering; it never restores a stale line number.

## Fixture cases

Automated fixtures cover:

- a Walmart-like purchase card after reviews in DOM order but beside the product
  heading in a grid;
- flex `order` and explicit grid placement;
- a normal single-column article that neither diagnostic mode changes;
- LTR and RTL rows;
- overlapping cards, equal rectangles, zero-size items, and generated text;
- a CSS multi-column region;
- table rows and cells;
- fixed and sticky groups;
- a portaled popup and a child frame;
- switching among all three modes while retaining the same selected element;
- activation after either diagnostic reorder;
- JavaScript/Crystal and Firefox/Chromium parity.
