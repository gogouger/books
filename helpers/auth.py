"""Google OAuth token validation and user identity resolution."""

import json
import logging
import os
from typing import Annotated

from fastapi import Depends, HTTPException, Request, status
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token

from .db import DATA_DIR, get_user_by_username

log = logging.getLogger(__name__)

SECURE = os.getenv("BOOKS_SECURE", "false").lower() == "true"
GOOGLE_CLIENT_ID = os.getenv("BOOKS_GOOGLE_CLIENT_ID", "")

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


require_user = Annotated[dict, Depends(_get_user)]
