import logging
from email.message import EmailMessage
from pathlib import Path

import aiosmtplib
from decouple import config

log = logging.getLogger(__name__)

SMTP_HOST = config("smtp_host", default="localhost")
SMTP_PORT = config("smtp_port", default=25, cast=int)
SMTP_FROM = config("smtp_from", default="maclocke@gmail.com")


async def send_to_kindle(
    kindle_email: str,
    book_title: str,
    epub_path: Path,
) -> bool:
    if not SMTP_HOST:
        log.error("SMTP not configured")
        return False

    msg = EmailMessage()
    msg["Subject"] = book_title
    msg["From"] = SMTP_FROM
    msg["To"] = kindle_email
    msg.set_content(f"Sending: {book_title}")

    epub_data = epub_path.read_bytes()
    msg.add_attachment(
        epub_data,
        maintype="application",
        subtype="epub+zip",
        filename=f"{book_title}.epub",
    )

    try:
        await aiosmtplib.send(
            msg,
            hostname=SMTP_HOST,
            port=SMTP_PORT,
            use_tls=False,
            start_tls=False,
        )
        log.info(
            "Sent '%s' to %s", book_title, kindle_email
        )
        return True
    except Exception:
        log.exception(
            "Failed to send '%s' to %s",
            book_title,
            kindle_email,
        )
        return False
