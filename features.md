# Feature Plans

## 0. Git init

- [x] Get into git. Don't store books themselves. Metadata on books can also
  be separate. Project should be a git project, though.

## 1. Public library URLs (architecture rework)

- [ ] Rework to be `books.mclauthlin.com/<library>` with features gated behind
  login. Not logged in should be able to see the books, ratings, etc, just not
  make any edits (stars, email the book, search for a new book, etc).

Touches routing, auth, frontend router, nginx, every page/component. All API
routes need an `optional_user` variant for read-only guest access. Frontend
needs conditional rendering to hide mutation controls for guests.

## 2. Reading status enum (prep for KOReader)

- [ ] Migrate `is_read` (0/1) to a `reading_status` field: unread / reading /
  read. Add `date_started`, `pages_read`, `total_pages` columns.

Future: KOReader lua script on Kobo will POST reading progress (currently
reading, page updates, read completion, rating on finish). Will need
token-based auth for device API since Kobo can't do browser OAuth.

## 3. Rating system rethink

- [ ] The real scale is 3-5 with 0.5 increments (5 tiers). 1 and 2 are rarely
  used. 3 = fun, 4 = really enjoyed, 4.5 = great, 5 = one of the best ever.
  Investigate a better system -- maybe fewer tiers with meaningful labels, or
  keep numeric but compress the range. Decide before building more UI around
  ratings. Also matters for KOReader rate-on-finish flow.

## 4. Series cluster

- [ ] Drop "series" of just one book
- [ ] Clicking on a series from a book should show the whole series
- [ ] Remove "Next" concept in series -- just Read and Unread
- [ ] Series view progress visualization: blue bar for partial, green for
  complete? Green border for read books? Consistent color language.
- [ ] If series continuation is missing from library, still include it as a
  placeholder (no thumbnail, but title/author/series index) so we can search
  for it in calibre

## 5. Book detail and editing

- [ ] Clicking on a book should have an edit button (add series, goodreads
  tags, do searches, etc)
- [ ] After clicking on a book, back should go back to the same spot in the
  list (or book should be a popup?)
- [ ] Get rid of "delete" button

## 6. UI polish

- [ ] Dark mode
- [ ] List vs thumbnail switch
- [ ] Infinite scroll (replace current pagination)
- [ ] Sidebar with #A-Z for quick select of letter (or numbers if sorting by
  rating)
- [ ] "Read" could be a green border
- [ ] Fix thumbnail cropping -- shouldn't be cropped
- [ ] Favicon

## 7. Sort fixes

- [ ] Sort order ascending/descending doesn't make sense with all fields (e.g.
  rating should default descending). Make sort direction context-aware.
- [ ] Sort by date read (already stored as `date_finished`, just needs UI)

## 8. Bigger features (later)

- [ ] Add book: series autocomplete/suggestions as you type, maybe suggest
  based on author as well
- [ ] Search book in calibre
- [ ] Multiple kindle email addresses as send-to targets (e.g. send to both
  me and ada's accounts from my library)
- [ ] Page for books missing metadata (find and fix them)

## 9. KOReader integration (when hardware arrives)

- [ ] Lua script for KOReader on Kobo
- [ ] POST reading progress: pages read, currently reading status
- [ ] Read completion triggers status change
- [ ] Rating/ranking prompt on finish
- [ ] Token-based device auth (separate from Google OAuth)
