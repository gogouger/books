import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .helpers import db
from .routes import router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(name)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)

app = FastAPI(title="Books API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def startup() -> None:
    db.init_db()
    log.info("Books API started")


app.include_router(router)


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}
