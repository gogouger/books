import { getUser } from './auth';

/**
 * Extract the library username from the URL pathname.
 * e.g. "/andy/" or "/andy/#/book/1" -> "andy"
 * Returns null if at root "/".
 */
export function getLibraryUsername(): string | null {
    const match = window.location.pathname.match(
        /^\/([a-zA-Z0-9_-]+)\/?/
    );
    return match ? match[1] : null;
}

/**
 * Check if the currently logged-in user can edit the library
 * being viewed (owner or superuser).
 */
export function isOwner(): boolean {
    const libraryUser = getLibraryUsername();
    if (!libraryUser) return false;
    const me = getUser();
    if (!me) return false;
    return me.username === libraryUser || me.is_superuser;
}
