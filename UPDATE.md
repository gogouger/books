# Plugin Self-Update for booksync.koplugin

## Context

The booksync KOReader plugin is currently deployed to the Kobo manually via SCP. When the plugin code changes, you have to remember to SCP the updated files. This adds a self-update mechanism so the plugin can check the Books server for a newer version and update itself in-place.

## Current State

**Plugin** (`koreader/plugins/booksync.koplugin/`):

- `_meta.lua` -- metadata (name, fullname, description). No version field.
- `main.lua` -- 744 lines. Full plugin: settings, sync logic, HTTP (Basic Auth), event handlers.
- Plugin already has `httpGet()` and `httpPost()` using `socket.http` + `ltn12` + `mime` (for Basic Auth).

**Server** (`books/routes/kobo.py`):

- `GET /api/kobo/ping` -- returns `{status, username}`, validates Basic Auth
- `POST /api/kobo/sync` -- reading state sync
- Basic Auth via `basic_auth_user` dependency

**Deploy** (`deploy.sh`):

- Builds UI, syncs API source to `/data/containers/books/`, rebuilds Docker
- Plugin files are NOT currently deployed to the server -- only manually SCP'd to Kobo

## Approach

Simple integer versioning. The server serves the plugin files directly from the repo source (copied during deploy). The plugin compares its local version against the server's, downloads new files if needed, and prompts for a KOReader restart.

The plugin has only 2 files, so no zip/archive packaging is needed -- just download each file individually.

Update checks are manual only (menu item).

## Changes

### 1. `koreader/plugins/booksync.koplugin/_meta.lua` -- add version

```lua
return {
    name = "booksync",
    fullname = _("Book Sync"),
    description = _("Sync reading progress, status, and ratings with Books server."),
    version = 1,
}
```

Bump this integer each time you change the plugin before deploying.

### 2. `books/routes/kobo.py` -- server endpoints

**Modify `GET /ping`**: Include `plugin_version` in the response by parsing it from the deployed `_meta.lua` file in `$BOOKS_DATA_DIR/plugin/`.

```python
import re
from fastapi.responses import PlainTextResponse

PLUGIN_DIR = Path(DATA_DIR) / "plugin"
_PLUGIN_FILES = {"main.lua", "_meta.lua"}

def _get_plugin_version() -> int:
    meta_path = PLUGIN_DIR / "_meta.lua"
    if not meta_path.exists():
        return 0
    text = meta_path.read_text()
    match = re.search(r"version\s*=\s*(\d+)", text)
    return int(match.group(1)) if match else 0

@router.get("/ping")
def ping(user: basic_auth_user) -> dict:
    return {
        "status": "ok",
        "username": user["username"],
        "plugin_version": _get_plugin_version(),
    }
```

**Add `GET /plugin/download/{filename}`**: Serves raw file content for `main.lua` or `_meta.lua`. Rejects any filename not in the allowed set. Requires basic auth.

```python
@router.get("/plugin/download/{filename}")
def download_plugin_file(
    filename: str,
    _user: basic_auth_user,
) -> PlainTextResponse:
    if filename not in _PLUGIN_FILES:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Unknown file")
    filepath = PLUGIN_DIR / filename
    if not filepath.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    return PlainTextResponse(filepath.read_text())
```

### 3. `koreader/plugins/booksync.koplugin/main.lua` -- self-update logic

New methods to add:

**`httpGetRaw(url)`** -- like existing `httpGet()` but returns raw string instead of JSON-decoding. Used to download Lua source files.

**`getPluginDir()`** -- resolves plugin install directory via `debug.getinfo`:

```lua
function BookSync:getPluginDir()
    local info = debug.getinfo(1, "S")
    local dir = info.source:match("^@(.+)/[^/]+$")
    if dir then return dir end
    return DataStorage:getDataDir() .. "/plugins/booksync.koplugin"
end
```

**`getLocalVersion()`** -- reads version integer from `_meta.lua` via pattern match on raw text (no Lua execution, robust):

```lua
function BookSync:getLocalVersion()
    local plugin_dir = self:getPluginDir()
    local fh = io.open(plugin_dir .. "/_meta.lua", "r")
    if not fh then return 0 end
    local text = fh:read("*a")
    fh:close()
    return tonumber(text:match("version%s*=%s*(%d+)")) or 0
end
```

**`checkForUpdate()`** -- calls `/ping`, compares `plugin_version` against local version. Returns `remote_ver, local_ver, err`.

**`performUpdate()`** -- downloads both files to `.new` temps, then swaps (backup original -> rename `.new` -> clean up backups). On any failure, rolls back and cleans up `.new` files.

Update flow:
1. Download `_meta.lua` and `main.lua` as `_meta.lua.new` and `main.lua.new`
2. Back up originals to `.bak`
3. Rename `.new` to actual
4. Clean up `.bak` files
5. If any step fails, restore from `.bak`

**`promptUpdateCheck()`** -- orchestrates: check version, show confirm dialog if update available, call `performUpdate()`, show restart prompt.

**New menu item**: "Check for updates" at the bottom of the Book Sync submenu. Connects to WiFi if needed.

```lua
{
    text = _("Check for updates"),
    callback = function()
        if NetworkMgr:isConnected() then
            self:promptUpdateCheck()
        else
            NetworkMgr:turnOnWifiAndWaitForConnection(function()
                self:promptUpdateCheck()
            end)
        end
    end,
},
```

### 4. `deploy.sh` -- copy plugin source to data dir

Add a step to rsync the plugin source files into `$DEST/data/plugin/` so the server can serve them:

```bash
echo "=== Syncing plugin source ==="
mkdir -p "$DEST/data/plugin"
rsync -a "$PROJ/koreader/plugins/booksync.koplugin/" "$DEST/data/plugin/"
```

## Files Modified

- `koreader/plugins/booksync.koplugin/_meta.lua`
- `koreader/plugins/booksync.koplugin/main.lua`
- `books/routes/kobo.py`
- `deploy.sh`

## Error Handling

- **Plugin dir not writable**: `io.open(..., "w")` returns nil, caught and reported
- **Network failure mid-download**: `.new` files cleaned up, originals untouched
- **Rename failure**: Backup restored from `.bak`
- **Server has no plugin files**: `_get_plugin_version()` returns 0, no update offered
- **Version not bumped**: Plugin won't detect an update. That's on you to remember.

## Update Workflow

1. Edit plugin source in `koreader/plugins/booksync.koplugin/`
2. Increment `version` in `_meta.lua`
3. Run `./deploy.sh` -- copies plugin source to server data dir
4. On Kobo: Menu > Book Sync > Check for updates
5. Plugin downloads new files, replaces itself, prompts for KOReader restart

## Verification

1. `uv run uvicorn books.main:app --reload --port 8000`
2. `curl -u user:pass http://localhost:8000/kobo/ping` -- should include `plugin_version`
3. `curl -u user:pass http://localhost:8000/kobo/plugin/download/main.lua` -- should return Lua source
4. `curl -u user:pass http://localhost:8000/kobo/plugin/download/bad.lua` -- should return 404
5. After deploy, test on Kobo: Menu > Book Sync > Check for updates
