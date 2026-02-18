from fastapi import APIRouter

from .auth import router as auth_router
from .books import router as books_router
from .kindle import router as kindle_router
from .series import router as series_router

router = APIRouter()
router.include_router(auth_router)
router.include_router(books_router)
router.include_router(kindle_router)
router.include_router(series_router)
