import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..helpers import db
from ..helpers.auth import require_owner
from ..helpers.db import DATA_DIR
from ..helpers.email import send_to_kindle

log = logging.getLogger(__name__)
router = APIRouter(tags=["kindle"])


class KindleSendRequest(BaseModel):
    email: str | None = None


@router.post("/books/{book_id}/kindle")
async def send_book_to_kindle(
    book_id: int,
    req: KindleSendRequest | None = None,
    payload: require_owner = None,
) -> dict:
    user_id = payload["user_id"]
    book = db.get_book(book_id, user_id)
    if book is None:
        raise HTTPException(
            status_code=404, detail="Book not found"
        )
    if not book.get("file_path"):
        raise HTTPException(
            status_code=400, detail="No epub file for this book"
        )

    # Determine target email
    kindle_email = None
    if req and req.email:
        kindle_email = req.email
    else:
        user = db.get_user_by_id(user_id)
        if user:
            kindle_email = user.get("kindle_email")

    if not kindle_email:
        raise HTTPException(
            status_code=400,
            detail="No Kindle email configured",
        )

    epub_path = (
        DATA_DIR / "files" / str(user_id) / book["file_path"]
    )
    if not epub_path.exists():
        raise HTTPException(
            status_code=404, detail="Epub file missing"
        )

    success = await send_to_kindle(
        kindle_email, book["title"], epub_path
    )
    if not success:
        raise HTTPException(
            status_code=500,
            detail="Failed to send email",
        )
    return {
        "success": True,
        "sent_to": kindle_email,
    }
