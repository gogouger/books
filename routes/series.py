import logging

from fastapi import APIRouter

from ..helpers import db
from ..helpers.auth import require_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/series", tags=["series"])


@router.get("")
def list_series(
    payload: require_user,
) -> dict:
    series = db.get_series_list(payload["user_id"])
    return {"series": series}


@router.get("/{series_name}")
def get_series(
    series_name: str,
    payload: require_user,
) -> dict:
    books = db.get_series_books(
        payload["user_id"], series_name
    )
    return {"series": series_name, "books": books}
