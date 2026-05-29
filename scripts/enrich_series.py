#!/usr/bin/env python3
"""Set series + series_index on a user's books from a curated map.

The StoryGraph export has no series data, so this fills it for the major
series via (a) an ordered curated map (index = position) and (b) regex for
titles that embed their number. Unmatched books (theology, standalones,
uncertain ordering) are left untouched. Re-runnable.

    uv run python /tmp/enrich_series.py gordon
"""

import re
import sys

from books.helpers import db

# Ordered main-sequence lists — index is position (1-based).
SERIES = {
    "The Stormlight Archive": [
        "The Way of Kings", "Words of Radiance", "Oathbringer",
        "Rhythm of War", "Wind and Truth",
    ],
    "Mistborn: Era One": [
        "The Final Empire", "The Well of Ascension", "The Hero of Ages",
    ],
    "Mistborn: Era Two": [
        "The Alloy of Law", "Shadows of Self", "The Bands of Mourning",
        "The Lost Metal",
    ],
    "The Reckoners": ["Steelheart", "Firefight", "Calamity"],
    "Skyward": ["Skyward", "Starsight", "Cytonic", "Defiant"],
    "The Wheel of Time": [
        "The Eye of the World", "The Great Hunt", "The Dragon Reborn",
        "The Shadow Rising", "The Fires of Heaven", "Lord of Chaos",
        "A Crown of Swords", "The Path of Daggers", "Winter's Heart",
        "Crossroads of Twilight", "Knife of Dreams", "The Gathering Storm",
        "Towers of Midnight", "A Memory of Light",
    ],
    "The Dresden Files": [
        "Storm Front", "Fool Moon", "Grave Peril", "Summer Knight",
        "Death Masks", "Blood Rites", "Dead Beat", "Proven Guilty",
        "White Night", "Small Favor", "Turn Coat", "Changes", "Ghost Story",
        "Cold Days", "Skin Game", "Peace Talks", "Battle Ground",
    ],
    "Codex Alera": [
        "Furies of Calderon", "Academ's Fury", "Cursor's Fury",
        "Captain's Fury", "Princep's Fury", "First Lord's Fury",
    ],
    "The Expanse": [
        "Leviathan Wakes", "Caliban's War", "Abaddon's Gate", "Cibola Burn",
        "Nemesis Games", "Babylon's Ashes", "Persepolis Rising",
        "Tiamat's Wrath", "Leviathan Falls",
    ],
    "Red Rising Saga": [
        "Red Rising", "Golden Son", "Morning Star", "Iron Gold",
        "Dark Age", "Light Bringer",
    ],
    "Ranger's Apprentice": [
        "The Ruins of Gorlan", "The Burning Bridge", "The Icebound Land",
        "The Battle for Skandia", "The Sorcerer of the North",
        "The Siege of Macindaw", "Erak's Ransom", "The Kings of Clonmel",
        "Halt's Peril", "The Emperor of Nihon-Ja", "The Lost Stories",
    ],
    "Ranger's Apprentice: The Royal Ranger": [
        "The Royal Ranger: A New Beginning", "The Red Fox Clan",
        "Duel at Araluen",
    ],
    "Percy Jackson and the Olympians": [
        "The Lightning Thief", "The Sea of Monsters", "The Titan's Curse",
        "The Battle of the Labyrinth", "The Last Olympian",
    ],
    "The Heroes of Olympus": [
        "The Lost Hero", "The Son of Neptune", "The Mark of Athena",
        "The House of Hades", "The Blood of Olympus",
    ],
    "Lightbringer": [
        "The Black Prism", "The Blinding Knife", "The Broken Eye",
        "The Blood Mirror", "The Burning White",
    ],
    "Sun Eater": [
        "Empire of Silence", "Howling Dark", "Demon in White",
        "Kingdoms of Death", "Ashes of Man", "Disquiet Gods",
    ],
    "Bobiverse": [
        "We Are Legion (We Are Bob)", "For We Are Many", "All These Worlds",
        "Heaven's River", "Not Till We Are Lost",
    ],
    "Silo": ["Wool", "Shift", "Dust"],
    "The Broken Earth": [
        "The Fifth Season", "The Obelisk Gate", "The Stone Sky",
    ],
    "The Kingkiller Chronicle": [
        "The Name of the Wind", "The Wise Man's Fear",
    ],
    "The Inheritance Cycle": ["Eragon", "Eldest", "Brisingr", "Inheritance"],
    "Gentleman Bastard": [
        "The Lies of Locke Lamora", "Red Seas Under Red Skies",
        "The Republic of Thieves",
    ],
    "The Licanius Trilogy": [
        "The Shadow of What Was Lost", "An Echo of Things to Come",
        "The Light of All That Falls",
    ],
    "Hierarchy": ["The Will of the Many", "The Strength of the Few"],
    "The Hunger Games": ["The Hunger Games", "Catching Fire", "Mockingjay"],
    "Harry Potter": [
        "Harry Potter and the Sorcerer's Stone",
        "Harry Potter and the Chamber of Secrets",
        "Harry Potter and the Prisoner of Azkaban",
        "Harry Potter and the Goblet of Fire",
        "Harry Potter and the Order of the Phoenix",
        "Harry Potter and the Half-Blood Prince",
        "Harry Potter and the Deathly Hallows",
    ],
    "The Lord of the Rings": [
        "The Fellowship of the Ring", "The Two Towers",
        "The Return of the King",
    ],
    "Remembrance of Earth's Past": [
        "The Three-Body Problem", "The Dark Forest",
    ],
    "The Dark Profit Saga": [
        "Orconomics: A Satire", "Son of a Liche", "Dragonfired",
    ],
    "Dungeon Crawler Carl": [
        "Dungeon Crawler Carl", "Carl's Doomsday Scenario",
    ],
    "Shadow of the Leviathan": [
        "The Tainted Cup", "A Drop of Corruption",
    ],
    "Heretical Fishing": [
        "Heretical Fishing", "Heretical Fishing 2", "Heretical Fishing 3",
    ],
}


def _norm(t: str) -> str:
    t = re.sub(r"\s+", " ", (t or "")).strip().lower()
    return t.rstrip(".").strip()


# Build exact-title lookup
LOOKUP: dict[str, tuple[str, float]] = {}
for series_name, titles in SERIES.items():
    for i, title in enumerate(titles, 1):
        LOOKUP[_norm(title)] = (series_name, float(i))

_ROMAN = {"i": 1, "ii": 2, "iii": 3, "iv": 4, "v": 5}


def resolve(title: str) -> tuple[str, float] | None:
    n = _norm(title)
    if n in LOOKUP:
        return LOOKUP[n]
    # He Who Fights With Monsters, Book N  (various punctuation)
    m = re.match(r"he who fights with monsters[,]?\s*(?:book\s*)?(\d+)$", n)
    if m:
        return ("He Who Fights with Monsters", float(m.group(1)))
    # White Sand, Volume N
    m = re.match(r"white sand[,]?\s*volume\s*(\d+)$", n)
    if m:
        return ("White Sand", float(m.group(1)))
    # The Perfect Run [/ II / III]
    m = re.match(r"the perfect run(?:\s+(ii|iii))?$", n)
    if m:
        return ("The Perfect Run", float(_ROMAN.get(m.group(1) or "i", 1)))
    return None


def main() -> None:
    username = sys.argv[1] if len(sys.argv) > 1 else "gordon"
    db.init_db()
    user = db.get_user_by_username(username)
    if not user:
        print(f"ERROR: user '{username}' not found")
        sys.exit(1)
    uid = user["id"]

    conn = db.get_db()
    rows = conn.execute(
        "SELECT id, title, series FROM books WHERE user_id = ?", (uid,)
    ).fetchall()
    conn.close()

    matched = already = unmatched = 0
    for r in rows:
        bid, title, existing = r[0], r[1], r[2]
        if existing:
            already += 1
            continue
        hit = resolve(title)
        if not hit:
            unmatched += 1
            continue
        series_name, idx = hit
        link_id = db.get_or_create_series_link(uid, series_name)
        db.update_book(bid, uid, {
            "series": series_name,
            "series_index": idx,
            "series_link_id": link_id,
        })
        matched += 1
        print(f"  {series_name} #{idx:g}  <-  {title[:46]}")

    print(f"\nDone: {matched} linked, {already} already had series, "
          f"{unmatched} left unmatched (standalone/theology/uncertain)")


if __name__ == "__main__":
    main()
