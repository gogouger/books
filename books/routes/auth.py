import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from ..helpers import db
from ..helpers.auth import require_user

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])


class UserResponse(BaseModel):
    id: int
    username: str
    display_name: str
    kindle_email: str | None


class KindleEmailUpdate(BaseModel):
    kindle_email: str


@router.get("/me")
def get_me(
    payload: require_user,
) -> UserResponse:
    user = db.get_user_by_id(payload["user_id"])
    if user is None:
        raise HTTPException(
            status_code=404, detail="User not found"
        )
    return UserResponse(
        id=user["id"],
        username=user["username"],
        display_name=user["display_name"],
        kindle_email=user["kindle_email"],
    )


@router.patch("/me/kindle")
def update_kindle_email(
    req: KindleEmailUpdate,
    payload: require_user,
) -> dict:
    db.update_user_kindle_email(
        payload["user_id"], req.kindle_email
    )
    return {"success": True}
