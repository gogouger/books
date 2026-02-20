"""Google OAuth and HTTP Basic Auth user identity resolution."""

import base64
import json
import logging
from typing import Annotated

from decouple import config
from fastapi import Depends, HTTPException, Path, Request, status
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token

from .db import (
    DATA_DIR,
    get_user_by_username,
    verify_password,
)

log = logging.getLogger(__name__)

GOOGLE_CLIENT_ID = config("BOOKS_GOOGLE_CLIENT_ID", default="")

_users_path = DATA_DIR / "users.json"
_users_cache: dict[str, str] = {}
_users_mtime: float = 0.0


def _load_users() -> dict[str, str]:
    """Load email-to-username mapping from users.json.

    Re-reads the file when its mtime changes.
    """
    global _users_cache, _users_mtime
    if not _users_path.exists():
        log.warning("users.json not found at %s", _users_path)
        return {}
    mtime = _users_path.stat().st_mtime
    if mtime != _users_mtime:
        _users_cache = json.loads(_users_path.read_text())
        _users_mtime = mtime
        log.info("Loaded %d users from %s", len(_users_cache), _users_path)
    return _users_cache


def _get_user(request: Request) -> dict:
    """Validate Bearer token and return user dict.

    Returns:
        Dict with user_id and username keys.

    Raises:
        HTTPException: 401 if token missing/invalid,
            403 if email not registered.
    """
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

    return {
        "user_id": user["id"],
        "username": user["username"],
        "is_superuser": bool(user.get("is_superuser")),
    }


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
        "kindle_email": user.get("kindle_email"),
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
    if user["user_id"] != owner["id"] and not user["is_superuser"]:
        raise HTTPException(
            status.HTTP_403_FORBIDDEN,
            "Not your library",
        )
    # When superuser acts on another library, use the owner's ID
    return {"user_id": owner["id"], "username": owner["username"]}


def _basic_auth_user(request: Request) -> dict:
    """Validate HTTP Basic Auth credentials and return user dict.

    Returns:
        Dict with user_id and username keys.

    Raises:
        HTTPException: 401 if credentials missing or invalid.
    """
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Basic "):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Authentication required",
            headers={"WWW-Authenticate": "Basic realm=\"books\""},
        )

    try:
        decoded = base64.b64decode(auth_header[6:]).decode("utf-8")
        username, password = decoded.split(":", 1)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid credentials",
            headers={"WWW-Authenticate": "Basic realm=\"books\""},
        )

    user = get_user_by_username(username)
    if user is None or not user.get("password_hash"):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid credentials",
            headers={"WWW-Authenticate": "Basic realm=\"books\""},
        )

    if not verify_password(password, user["password_hash"]):
        raise HTTPException(
            status.HTTP_401_UNAUTHORIZED,
            "Invalid credentials",
            headers={"WWW-Authenticate": "Basic realm=\"books\""},
        )

    return {
        "user_id": user["id"],
        "username": user["username"],
        "is_superuser": bool(user.get("is_superuser")),
    }


require_user = Annotated[dict, Depends(_get_user)]
optional_user = Annotated[dict | None, Depends(_optional_user)]
basic_auth_user = Annotated[dict, Depends(_basic_auth_user)]
library_owner = Annotated[dict, Depends(_resolve_library_owner)]
require_owner = Annotated[dict, Depends(_require_owner)]
