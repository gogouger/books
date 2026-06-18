from fastapi import APIRouter

from ..helpers.auth import GOOGLE_CLIENT_ID
from .auth import router as auth_router
from .books import router as books_router
from .kindle import router as kindle_router
from .kobo import router as kobo_router
from .opds import router as opds_router
from .recommendations import router as recommendations_router
from .series import router as series_router

router = APIRouter()


@router.get("/config")
def get_config() -> dict:
    return {"google_client_id": GOOGLE_CLIENT_ID}


router.include_router(auth_router)
router.include_router(kobo_router)
router.include_router(opds_router)

library_router = APIRouter(prefix="/{username}")
library_router.include_router(books_router)
library_router.include_router(kindle_router)
library_router.include_router(recommendations_router)
library_router.include_router(series_router)
router.include_router(library_router)
