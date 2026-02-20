"""CLI tool to set/reset a user's password for OPDS access."""

import getpass
import sys
from pathlib import Path

# Add project root to path so we can import books package
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from books.helpers.db import (
    get_user_by_username,
    hash_password,
    set_password_hash,
)


def main() -> None:
    if len(sys.argv) != 2:
        print(f"Usage: {sys.argv[0]} <username>")
        sys.exit(1)

    username = sys.argv[1]
    user = get_user_by_username(username)
    if user is None:
        print(f"Error: user '{username}' not found")
        sys.exit(1)

    password = getpass.getpass(f"New password for {username}: ")
    if not password:
        print("Error: password cannot be empty")
        sys.exit(1)

    confirm = getpass.getpass("Confirm password: ")
    if password != confirm:
        print("Error: passwords do not match")
        sys.exit(1)

    hashed = hash_password(password)
    set_password_hash(user["id"], hashed)
    print(f"Password updated for {username}")


if __name__ == "__main__":
    main()
