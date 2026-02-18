"""Google OAuth token validation and user identity resolution."""

import json
import logging
from typing import Annotated

from decouple import config
from fastapi import Depends, HTTPException, Path, Request, status
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token

from .db import DATA_DIR, get_user_by_username

log = logging.getLogger(__name__)

SECURE = config("BOOKS_SECURE", default="false").lower() == "true"
GOOGLE_CLIENT_ID = config("BOOKS_GOOGLE_CLIENT_ID", default="")

_users_path = DATA_DIR / "users.json"
_users_cache: dict[str, str] | None = None


def _load_users() -> dict[str, str]:
    """Load email-to-username mapping from users.json."""
    global _users_cache
    if _users_cache is None:
        if _users_path.exists():
            _users_cache = json.loads(_users_path.read_text())
        else:
            log.warning("users.json not found at %s", _users_path)
            _users_cache = {}
    return _users_cache


def _get_user(request: Request) -> dict:
    """Validate Bearer token and return user dict.

    Returns:
        Dict with user_id and username keys.

    Raises:
        HTTPException: 401 if token missing/invalid,
            403 if email not registered.
    """
    if not SECURE:
        return {"user_id": 1, "username": "andy"}

    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Missing token"
        )

    token = auth_header[7:]
    try:
        idinfo = id_token.verify_oauth2_token(
            token, GoogleRequest(), GOOGLE_CLIENT_ID
        )
    except ValueError as e:
        log.warning("Invalid token: %s", e)
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED, "Invalid token"
        ) from e

    email = idinfo.get("email", "")
    users = _load_users()
    if email not in users:
        log.warning("Unknown email: %s", email)
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Not authorized"
        )

    username = users[email]
    user = get_user_by_username(username)
    if user is None:
        log.error(
            "User '%s' in users.json but not in DB", username
        )
        raise HTTPException(
            status.HTTP_403_FORBIDDEN, "Not authorized"
        )

    return {"user_id": user["id"], "username": user["username"]}


def _optional_user(request: Request) -> dict | None:
    """Like _get_user but returns None instead of raising.

    Used by read-only routes so anonymous visitors can browse.
    """
    try:
        return _get_user(request)
    except HTTPException:
        return None


def _resolve_library_owner(
    username: str = Path(...),
) -> dict:
    """Resolve {username} path param to a user dict.

    Raises:
        HTTPException: 404 if username not found.
    """
    user = get_user_by_username(username)
    if user is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND, "User not found"
        )
    return {
        "id": user["id"],
        "username": user["username"],
        "display_name": user["display_name"],
    }


def _require_owner(
    request: Request,
    username: str = Path(...),
) -> dict:
    """Authenticate user and verify they own this library.

    Returns:
        Dict with user_id and username keys.

    Raises:
        HTTPException: 401 if not authenticated, 403 if not owner.
    """
    user = _get_user(request)
    owner = _resolve_library_owner(username)
    if user["user_id"] != owner["id"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Not your library",
        )
    return user


require_user = Annotated[dict, Depends(_get_user)]
optional_user = Annotated[dict | None, Depends(_optional_user)]
library_owner = Annotated[dict, Depends(_resolve_library_owner)]
require_owner = Annotated[dict, Depends(_require_owner)]
