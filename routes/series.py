import logging

from fastapi import APIRouter

from ..helpers import db
from ..helpers.auth import library_owner, optional_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/series", tags=["series"])


@router.get("")
def list_series(
    owner: library_owner,
    viewer: optional_user,
) -> dict:
    series = db.get_series_list(owner["id"])
    is_owner = (
        viewer is not None and viewer["user_id"] == owner["id"]
    )
    return {"series": series, "is_owner": is_owner}


@router.get("/{series_name}")
def get_series(
    series_name: str,
    owner: library_owner,
    viewer: optional_user,
) -> dict:
    books = db.get_series_books(owner["id"], series_name)
    is_owner = (
        viewer is not None and viewer["user_id"] == owner["id"]
    )
    return {
        "series": series_name,
        "books": books,
        "is_owner": is_owner,
    }
