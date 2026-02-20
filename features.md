# Feature Plans

## 0. Git init

- [x] Get into git. Don't store books themselves. Metadata on books can also
  be separate. Project should be a git project, though.

## 1. Public library URLs (architecture rework)

- [x] Rework to be `books.mclauthlin.com/<library>` with features gated behind
  login. Not logged in should be able to see the books, ratings, etc, just not
  make any edits (stars, email the book, search for a new book, etc).

Touches routing, auth, frontend router, nginx, every page/component. All API
routes need an `optional_user` variant for read-only guest access. Frontend
needs conditional rendering to hide mutation controls for guests.

## 2. Reading status enum (prep for KOReader)

- [x] Migrate `is_read` (0/1) to a `reading_status` field: unread / reading /
  read. Add `date_started`, `pages_read`, `total_pages` columns.

Future: KOReader lua script on Kobo will POST reading progress (currently
reading, page updates, read completion, rating on finish). Will need
token-based auth for device API since Kobo can't do browser OAuth.

## 3. Rating system rethink

- [x] Replaced 0-5 half-star scale with 1-5 integer ratings + `is_favorite`
  boolean. Migration truncates half-stars to integers, converts existing 5.0
  books to favorites (except The Expanse and The Foreworld Saga overrides).
  UI removes half-star logic, adds heart icon for favorites on cards/detail/
  series views, and a favorites filter toggle in the filter bar.

## 4. Series cluster

- [x] Drop "series" of just one book
- [x] Clicking on a series from a book should show the whole series
- [x] Remove "Next" concept in series -- just Read and Unread
- [x] Series view progress visualization: blue bar for partial, green for
  complete? Green border for read books? Consistent color language.
- [x] If series continuation is missing from library, still include it as a
  placeholder (no thumbnail, but title/author/series index) so we can search
  for it in calibre
- [x] Series should have a "fetch series metadata" on the individual series and should auto-fetch if a book is added from a series (check book metadata, then check series metadata).
- [ ] We should also do a monthly search against all series we have (can we grab all of them? What's a good rate? 10 / 5 minutes? 1/minute?)
- [x] Need to figure out best way to keep track of user edits vs series that will get re-updated. Probably keep all online data, but then update with user edits. Could edit the number, ignore the book, edit the (effective) series name ... anything.
- [x] Would be interesting to see how many are in a series more dynamically ... if there are two, two divisions, if there are 20, 20 divisions of the bar?
- [x] Should be able to click on an author or a series from the library view and go to a filtered view of those things (filter to author or the individual series view, respectively). They should show that you're mousing over those fields specifically instead of the full book card when you do that. Similarly, should be able to click on the author from the single book view

## 5. Book detail and editing

- [x] Clicking on a book should have an edit button (add series, goodreads
  tags, do searches, etc)
- [x] After clicking on a book, back should go back to the same spot in the
  list (or book should be a popup?)
- [x] Get rid of "delete" button

## 6. UI polish

- [x] Dark mode
- [ ] List vs thumbnail switch
- [x] Infinite scroll (replace current pagination)
- [ ] Sidebar with #A-Z for quick select of letter (or numbers if sorting by
  rating)
- [x] "Read" could be a green border
- [x] Fix thumbnail cropping -- shouldn't be cropped
- [x] Favicon

## 7. Sort fixes

- [x] Sort order ascending/descending doesn't make sense with all fields (e.g.
  rating should default descending). Make sort direction context-aware.
- [x] Sort by date read (already stored as `date_finished`, just needs UI)

## 8. Bigger features (later)

- [x] Add book: series autocomplete/suggestions as you type, maybe suggest
  based on author as well
- [x] Search book in calibre
- [ ] Multiple kindle email addresses as send-to targets (e.g. send to both
  me and ada's accounts from my library)

## 9. KOReader integration (when hardware arrives)

- [ ] Lua script for KOReader on Kobo
- [ ] POST reading progress: pages read, currently reading status
- [ ] Read completion triggers status change
- [ ] Rating/ranking prompt on finish
- [ ] Token-based device auth (separate from Google OAuth)
