--[[
BookSync plugin for KOReader.

Syncs reading progress, status, and ratings with a Books server
via POST /api/kobo/sync (JSON, Basic Auth).

Progress is forward-only: server and plugin always keep the
higher progress value. Progress resets when status leaves "reading".
]]

local DataStorage = require("datastorage")
local Device = require("device")
local Dispatcher = require("dispatcher")
local DocSettings = require("docsettings")
local Event = require("ui/event")
local InfoMessage = require("ui/widget/infomessage")
local InputDialog = require("ui/widget/inputdialog")
local MultiInputDialog = require("ui/widget/multiinputdialog")
local NetworkMgr = require("ui/network/manager")
local SpinWidget = require("ui/widget/spinwidget")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local logger = require("logger")
local json = require("json")
local lfs = require("libs/libkoreader-lfs")
local _ = require("gettext")
local T = require("ffi/util").template

local BookSync = WidgetContainer:extend{
    name = "booksync",
    is_doc_only = false,
    page_turn_count = 0,
    sync_in_progress = false,
    last_sync_fail_time = 0,
}

-- Settings helpers

function BookSync:getSettings()
    return G_reader_settings:readSetting("booksync") or {}
end

function BookSync:saveSetting(key, value)
    local settings = self:getSettings()
    settings[key] = value
    G_reader_settings:saveSetting("booksync", settings)
end

function BookSync:getSetting(key, default)
    local settings = self:getSettings()
    local val = settings[key]
    if val == nil then return default end
    return val
end

function BookSync:getBooksDir()
    -- User override > platform home_dir > cwd
    return self:getSetting("books_dir") or Device.home_dir or "."
end

-- Init

function BookSync:init()
    self:onDispatcherRegisterActions()
    self.ui.menu:registerToMainMenu(self)
    self.page_turn_count = 0
end

function BookSync:onDispatcherRegisterActions()
    Dispatcher:registerAction("booksync_sync_all", {
        category = "none",
        event = "BookSyncAll",
        title = _("Book Sync: sync all books"),
        general = true,
    })
    Dispatcher:registerAction("booksync_sync_current", {
        category = "none",
        event = "BookSyncCurrent",
        title = _("Book Sync: sync this book"),
        reader = true,
    })
end

-- Menu

function BookSync:addToMainMenu(menu_items)
    menu_items.booksync = {
        text = _("Book Sync"),
        sorting_hint = "more_tools",
        sub_item_table = {
            {
                text = _("Server settings"),
                keep_menu_open = true,
                callback = function()
                    self:showServerSettings()
                end,
            },
            {
                text_func = function()
                    if self:getSetting("auto_sync", true) then
                        return _("Auto-sync: on")
                    end
                    return _("Auto-sync: off")
                end,
                callback = function()
                    local cur = self:getSetting("auto_sync", true)
                    self:saveSetting("auto_sync", not cur)
                end,
            },
            {
                text = _("Sync interval (page turns)"),
                keep_menu_open = true,
                callback = function()
                    self:showSyncIntervalDialog()
                end,
            },
            {
                text_func = function()
                    return T(_("Books directory: %1"), self:getBooksDir())
                end,
                keep_menu_open = true,
                callback = function()
                    self:showBooksDirDialog()
                end,
            },
            {
                text = _("Sync all books now"),
                callback = function()
                    self:syncAllWithConnect()
                end,
            },
            {
                text = _("Sync this book now"),
                callback = function()
                    if self.ui.document then
                        self:syncCurrentBook(true)
                    else
                        UIManager:show(InfoMessage:new{
                            text = _("No book open."),
                        })
                    end
                end,
            },
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
        },
    }
end

function BookSync:showServerSettings()
    local settings = self:getSettings()
    self.settings_dialog = MultiInputDialog:new{
        title = _("Book Sync Server"),
        fields = {
            {
                text = settings.server_url or "",
                hint = _("Server URL"),
            },
            {
                text = settings.username or "",
                hint = _("Username"),
            },
            {
                text = settings.password or "",
                hint = _("Password"),
                text_type = "password",
            },
        },
        buttons = {
            {
                {
                    text = _("Cancel"),
                    id = "close",
                    callback = function()
                        UIManager:close(self.settings_dialog)
                    end,
                },
                {
                    text = _("Test"),
                    callback = function()
                        local fields = self.settings_dialog:getFields()
                        self:saveSetting("server_url", fields[1])
                        self:saveSetting("username", fields[2])
                        self:saveSetting("password", fields[3])
                        local result, err = self:httpGet("/api/kobo/ping")
                        if result then
                            UIManager:show(InfoMessage:new{
                                text = T(_("Connected as %1"), result.username),
                                timeout = 3,
                            })
                        else
                            UIManager:show(InfoMessage:new{
                                text = T(_("Connection failed: %1"), err),
                                timeout = 5,
                            })
                        end
                    end,
                },
                {
                    text = _("Save"),
                    is_enter_default = true,
                    callback = function()
                        local fields = self.settings_dialog:getFields()
                        self:saveSetting("server_url", fields[1])
                        self:saveSetting("username", fields[2])
                        self:saveSetting("password", fields[3])
                        UIManager:close(self.settings_dialog)
                        UIManager:show(InfoMessage:new{
                            text = _("Settings saved."),
                        })
                    end,
                },
            },
        },
    }
    UIManager:show(self.settings_dialog)
end

function BookSync:showSyncIntervalDialog()
    local cur = self:getSetting("sync_interval", 20)
    local spin = SpinWidget:new{
        title_text = _("Page turns between syncs"),
        value = cur,
        value_min = 5,
        value_max = 100,
        value_step = 5,
        ok_text = _("Set"),
        callback = function(spin_widget)
            self:saveSetting("sync_interval", spin_widget.value)
        end,
    }
    UIManager:show(spin)
end

function BookSync:showBooksDirDialog()
    local default_dir = Device.home_dir or "."
    local current = self:getBooksDir()
    self.booksdir_dialog = InputDialog:new{
        title = _("Books directory"),
        description = T(_("Directory to scan for EPUBs.\nPlatform default: %1"), default_dir),
        input = current,
        buttons = {
            {
                {
                    text = _("Cancel"),
                    id = "close",
                    callback = function()
                        UIManager:close(self.booksdir_dialog)
                    end,
                },
                {
                    text = _("Reset"),
                    callback = function()
                        self:saveSetting("books_dir", nil)
                        UIManager:close(self.booksdir_dialog)
                        UIManager:show(InfoMessage:new{
                            text = T(_("Reset to default: %1"), default_dir),
                            timeout = 3,
                        })
                    end,
                },
                {
                    text = _("Save"),
                    is_enter_default = true,
                    callback = function()
                        local dir = self.booksdir_dialog:getInputText()
                        if dir and dir ~= "" then
                            local attr = lfs.attributes(dir, "mode")
                            if attr == "directory" then
                                self:saveSetting("books_dir", dir)
                                UIManager:close(self.booksdir_dialog)
                                UIManager:show(InfoMessage:new{
                                    text = T(_("Books directory set to: %1"), dir),
                                    timeout = 3,
                                })
                            else
                                UIManager:show(InfoMessage:new{
                                    text = T(_("Directory not found: %1"), dir),
                                    timeout = 3,
                                })
                            end
                        end
                    end,
                },
            },
        },
    }
    UIManager:show(self.booksdir_dialog)
end

-- Event handlers

function BookSync:onReaderReady()
    if not self:getSetting("auto_sync", true) then return end
    if not NetworkMgr:isConnected() then return end
    UIManager:scheduleIn(3, function()
        if self.ui.document then
            -- "on_open" flag: show jump toast but respect cooldown
            self:syncCurrentBook("on_open")
        end
    end)
end

function BookSync:onPageUpdate(_pageno)
    if not self:getSetting("auto_sync", true) then return end
    self.page_turn_count = self.page_turn_count + 1
    local interval = self:getSetting("sync_interval", 20)
    if self.page_turn_count >= interval then
        self.page_turn_count = 0
        if NetworkMgr:isConnected() then
            self:syncCurrentBook()
        end
    end
end

function BookSync:onCloseDocument()
    if not self:getSetting("auto_sync", true) then return end
    if not NetworkMgr:isConnected() then return end
    self:syncCurrentBook()
end

function BookSync:onSuspend()
    if not self:getSetting("auto_sync", true) then return end
    if not NetworkMgr:isConnected() then return end
    if self.ui.document then
        self:syncCurrentBook()
    end
end

function BookSync:onNetworkConnected()
    if not self:getSetting("auto_sync", true) then return end
    UIManager:scheduleIn(5, function()
        if NetworkMgr:isConnected() then
            self:syncAll()
        end
    end)
end

function BookSync:onNetworkDisconnecting()
    if not self:getSetting("auto_sync", true) then return end
    if os.time() - self.last_sync_fail_time < 30 then return end
    self:syncAll()
end

function BookSync:onBookSyncAll()
    self:syncAllWithConnect()
end

function BookSync:onBookSyncCurrent()
    if self.ui.document then
        self:syncCurrentBook(true)
    else
        UIManager:show(InfoMessage:new{
            text = _("No book open."),
        })
    end
end

-- Core sync functions

function BookSync:readBookState(filepath)
    local sidecar = DocSettings:open(filepath)
    if not sidecar then return nil end

    local data = sidecar.data or {}
    local summary = data.summary or {}

    local filename = filepath:match("([^/]+)$") or filepath

    -- Compute or retrieve cached MD5 hash of the epub file
    local epub_hash = data.epub_hash
    if not epub_hash then
        local ok, md5 = pcall(require, "ffi/md5")
        if ok then
            epub_hash = md5.sumFile(filepath)
            if epub_hash then
                sidecar:saveSetting("epub_hash", epub_hash)
                sidecar:flush()
            end
        end
    end

    local title = data.doc_props and data.doc_props.title
    local authors = data.doc_props and data.doc_props.authors

    if not title then
        local base = filename:gsub("%.epub$", "")
        local dash_pos = base:find(" %- ")
        if dash_pos then
            authors = authors or base:sub(1, dash_pos - 1)
            title = base:sub(dash_pos + 3)
        else
            title = base
        end
    end

    local status = summary.status
    if not status and data.percent_finished and data.percent_finished > 0 then
        status = "reading"
    end

    return {
        filename = filename,
        epub_hash = epub_hash,
        title = title,
        authors = authors or "",
        reading_status = status,
        progress = data.percent_finished,
        rating = summary.rating,
    }
end

function BookSync:applyServerState(filepath, server)
    local sidecar = DocSettings:open(filepath)
    if not sidecar then return false end

    local data = sidecar.data or {}
    if not data.summary then data.summary = {} end
    local changed = false

    if type(server.reading_status) == "string" then
        local effective_status = data.summary.status
        if not effective_status
            and data.percent_finished and data.percent_finished > 0 then
            effective_status = "reading"
        end
        if effective_status ~= server.reading_status then
            data.summary.status = server.reading_status
            changed = true
        end
    end

    -- Progress: server already computed max, just apply
    if type(server.progress) == "number" then
        local diff = math.abs(
            (server.progress or 0) - (data.percent_finished or 0)
        )
        if diff > 0.0001 then
            data.percent_finished = server.progress
            changed = true
        end
    end

    if type(server.rating) == "number" then
        if data.summary.rating ~= server.rating then
            data.summary.rating = server.rating
            changed = true
        end
    end

    if changed then
        sidecar:saveSetting("percent_finished", data.percent_finished)
        sidecar:saveSetting("summary", data.summary)
        sidecar:flush()
        logger.info("BookSync: applied server state to", filepath)
    end
    return changed
end

-- If the server returned higher progress than the open reader,
-- jump the reader forward.
function BookSync:jumpReaderIfAhead(server_progress)
    if not self.ui.document then return false end
    if type(server_progress) ~= "number" then return false end

    local local_progress = 0
    local ok, pct = pcall(function()
        if self.ui.rolling and self.ui.rolling.getLastPercent then
            return self.ui.rolling:getLastPercent()
        end
    end)
    if ok and type(pct) == "number" then
        local_progress = pct
    end

    if server_progress > local_progress + 0.001 then
        local server_pct = math.floor(server_progress * 100)
        local ConfirmBox = require("ui/widget/confirmbox")
        UIManager:show(ConfirmBox:new{
            text = T(_("Another device is at %1%. Jump ahead?"), server_pct),
            ok_text = _("Jump"),
            cancel_text = _("Stay"),
            ok_callback = function()
                self.ui:handleEvent(Event:new(
                    "GotoPercent", server_progress * 100))
            end,
        })
        return true
    end
    return false
end

function BookSync:httpGetRaw(url)
    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        return nil, "Not configured"
    end

    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local mime = require("mime")
    local socketutil = require("socketutil")

    local response_parts = {}
    local auth = mime.b64(settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "") .. url

    socketutil:set_timeout(5, 10)
    local _, code, _headers = http.request{
        url = full_url,
        method = "GET",
        headers = {
            ["Authorization"] = "Basic " .. auth,
        },
        sink = ltn12.sink.table(response_parts),
    }
    socketutil:reset_timeout()

    if type(code) ~= "number" then
        logger.warn("BookSync: connection failed:", code)
        return nil, tostring(code)
    end
    if code ~= 200 then
        logger.warn("BookSync: HTTP", code, "from", full_url)
        return nil, "HTTP " .. tostring(code)
    end

    return table.concat(response_parts)
end

function BookSync:getPluginDir()
    local src = debug.getinfo(1, "S").source
    if src and src:sub(1, 1) == "@" then
        local dir = src:sub(2):match("(.*/)")
        if dir then return dir:gsub("/$", "") end
    end
    return DataStorage:getDataDir() .. "/plugins/booksync.koplugin"
end

function BookSync:getLocalVersion()
    local dir = self:getPluginDir()
    local path = dir .. "/_meta.lua"
    local f = io.open(path, "r")
    if not f then return 0 end
    local text = f:read("*a")
    f:close()
    local ver = text:match("version%s*=%s*(%d+)")
    return tonumber(ver) or 0
end

function BookSync:checkForUpdate()
    local result, err = self:httpGet("/api/kobo/ping")
    if not result then
        return nil, nil, err
    end
    local remote_ver = result.plugin_version or 0
    local local_ver = self:getLocalVersion()
    return remote_ver, local_ver, nil
end

function BookSync:performUpdate()
    local dir = self:getPluginDir()
    local files = {"_meta.lua", "main.lua"}
    local new_contents = {}

    -- Download all files first
    for _, name in ipairs(files) do
        local content, err = self:httpGetRaw(
            "/api/kobo/plugin/download/" .. name)
        if not content then
            return false, T(_("Download failed for %1: %2"), name, err)
        end
        new_contents[name] = content
    end

    -- Write to .new temp files
    for _, name in ipairs(files) do
        local f, err = io.open(dir .. "/" .. name .. ".new", "w")
        if not f then
            return false, T(_("Cannot write %1.new: %2"), name, err)
        end
        f:write(new_contents[name])
        f:close()
    end

    -- Back up originals and swap
    for _, name in ipairs(files) do
        local orig = dir .. "/" .. name
        local bak = orig .. ".bak"
        local new = orig .. ".new"
        os.rename(orig, bak)
        local ok = os.rename(new, orig)
        if not ok then
            -- Restore from backup on failure
            for _, rname in ipairs(files) do
                local rorig = dir .. "/" .. rname
                local rbak = rorig .. ".bak"
                local rnew = rorig .. ".new"
                if lfs.attributes(rbak, "mode") then
                    os.rename(rbak, rorig)
                end
                os.remove(rnew)
            end
            return false, T(_("Failed to install %1"), name)
        end
    end

    -- Clean up .bak files
    for _, name in ipairs(files) do
        os.remove(dir .. "/" .. name .. ".bak")
    end

    return true
end

function BookSync:promptUpdateCheck()
    local remote_ver, local_ver, err = self:checkForUpdate()
    if err then
        UIManager:show(InfoMessage:new{
            text = T(_("Update check failed: %1"), err),
            timeout = 5,
        })
        return
    end

    if remote_ver <= local_ver then
        UIManager:show(InfoMessage:new{
            text = T(_("Plugin is up to date (v%1)."), local_ver),
            timeout = 3,
        })
        return
    end

    local ConfirmBox = require("ui/widget/confirmbox")
    UIManager:show(ConfirmBox:new{
        text = T(_("Update available: v%1 -> v%2.\nInstall now?"),
            local_ver, remote_ver),
        ok_text = _("Update"),
        cancel_text = _("Later"),
        ok_callback = function()
            local ok, update_err = self:performUpdate()
            if ok then
                UIManager:show(ConfirmBox:new{
                    text = _("Update installed. Restart KOReader to activate."),
                    ok_text = _("Restart"),
                    cancel_text = _("Later"),
                    ok_callback = function()
                        UIManager:broadcastEvent(Event:new("RestartKOReader"))
                    end,
                })
            else
                UIManager:show(InfoMessage:new{
                    text = T(_("Update failed: %1"), update_err),
                    timeout = 5,
                })
            end
        end,
    })
end

function BookSync:httpPost(url, body)
    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        return nil, "Not configured"
    end

    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local mime = require("mime")
    local socketutil = require("socketutil")

    local json_body = json.encode(body)
    local response_parts = {}

    local auth = mime.b64(settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "") .. url

    socketutil:set_timeout(5, 10)
    local _, code, _headers = http.request{
        url = full_url,
        method = "POST",
        headers = {
            ["Content-Type"] = "application/json",
            ["Content-Length"] = tostring(#json_body),
            ["Authorization"] = "Basic " .. auth,
        },
        source = ltn12.source.string(json_body),
        sink = ltn12.sink.table(response_parts),
    }
    socketutil:reset_timeout()

    if type(code) ~= "number" then
        logger.warn("BookSync: connection failed:", code)
        return nil, tostring(code)
    end
    if code ~= 200 then
        logger.warn("BookSync: HTTP", code, "from", full_url)
        return nil, "HTTP " .. tostring(code)
    end

    local response_body = table.concat(response_parts)
    local ok, result = pcall(json.decode, response_body)
    if not ok then
        return nil, "JSON decode error"
    end
    return result
end

function BookSync:httpGet(url)
    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        return nil, "Not configured"
    end

    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local mime = require("mime")
    local socketutil = require("socketutil")

    local response_parts = {}
    local auth = mime.b64(settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "") .. url

    socketutil:set_timeout(5, 10)
    local _, code, _headers = http.request{
        url = full_url,
        method = "GET",
        headers = {
            ["Authorization"] = "Basic " .. auth,
        },
        sink = ltn12.sink.table(response_parts),
    }
    socketutil:reset_timeout()

    if type(code) ~= "number" then
        logger.warn("BookSync: connection failed:", code)
        return nil, tostring(code)
    end
    if code ~= 200 then
        logger.warn("BookSync: HTTP", code, "from", full_url)
        return nil, "HTTP " .. tostring(code)
    end

    local response_body = table.concat(response_parts)
    local ok, result = pcall(json.decode, response_body)
    if not ok then
        return nil, "JSON decode error"
    end
    return result
end

function BookSync:syncCurrentBook(show_toast)
    if self.sync_in_progress then return nil, "Sync already in progress" end
    -- After a failure, back off for 60s on background syncs.
    -- Allow manual sync (true) and book-open sync ("on_open").
    if not show_toast
        and os.time() - self.last_sync_fail_time < 60 then
        return nil, "Cooling down after failure"
    end
    if not self.ui.document then return nil, "No book open" end
    local filepath = self.ui.document.file
    if not filepath then return nil, "No file path" end

    local state = self:readBookState(filepath)
    if not state then return nil, "Cannot read book state" end

    -- Use live reader position, not stale sidecar value.
    -- ReaderRolling (EPUB) exposes getLastPercent().
    local ok, live_progress = pcall(function()
        if self.ui.rolling and self.ui.rolling.getLastPercent then
            return self.ui.rolling:getLastPercent()
        end
    end)
    if ok and type(live_progress) == "number" then
        state.progress = live_progress
    end

    self.sync_in_progress = true
    local result, err = self:httpPost("/api/kobo/sync", {
        books = { state },
    })
    self.sync_in_progress = false
    if not result then
        self.last_sync_fail_time = os.time()
        logger.warn("BookSync: sync failed:", err)
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = T(_("Sync failed: %1"), err),
                timeout = 3,
            })
        end
        return nil, err
    end

    -- Jump on book open or manual sync, not background page-turn syncs
    local jumped = false
    if show_toast and result.books and #result.books > 0 then
        local server = result.books[1]
        if server.book_id then
            jumped = self:jumpReaderIfAhead(server.progress)
        end
    end

    if show_toast == true and not jumped then
        UIManager:show(InfoMessage:new{
            text = _("Synced."),
            timeout = 2,
        })
    end
    return true
end

function BookSync:syncAll(show_toast)
    if self.sync_in_progress then return nil, "Sync already in progress" end
    local books = self:collectAllBooks()
    if #books == 0 then
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = _("No books to sync."),
                timeout = 2,
            })
        end
        return nil, "No books"
    end

    self.sync_in_progress = true
    local result, err = self:httpPost("/api/kobo/sync", {
        books = books,
    })
    self.sync_in_progress = false
    if not result then
        self.last_sync_fail_time = os.time()
        logger.warn("BookSync: sync all failed:", err)
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = T(_("Sync failed: %1"), err),
                timeout = 3,
            })
        end
        return nil, err
    end

    if not result.books then return true end

    local filepath_map = self:buildFilepathMap()

    local matched = 0
    local applied = 0
    for _, server in ipairs(result.books) do
        if server.book_id then
            matched = matched + 1
            local filepath = filepath_map[server.filename]
            if filepath then
                if self:applyServerState(filepath, server) then
                    applied = applied + 1
                end
            end
        end
    end

    local unmatched = #books - matched
    logger.info("BookSync: synced", #books, "books,",
        matched, "matched,", applied, "updated,",
        unmatched, "unmatched")

    if show_toast then
        local msg
        if applied > 0 and unmatched > 0 then
            msg = T(_("Synced. %1 updated, %2 not matched."),
                applied, unmatched)
        elseif applied > 0 then
            msg = T(_("Synced. %1 updated."), applied)
        elseif unmatched > 0 then
            msg = T(_("Synced. %1 not matched."), unmatched)
        else
            msg = _("Synced.")
        end
        UIManager:show(InfoMessage:new{
            text = msg,
            timeout = 3,
        })
    end
    return true
end

function BookSync:syncAllWithConnect()
    if NetworkMgr:isConnected() then
        self:syncAll(true)
    else
        NetworkMgr:turnOnWifiAndWaitForConnection(function()
            self:syncAll(true)
        end)
    end
end

function BookSync:collectAllBooks()
    local books = {}
    local filepath_map = self:buildFilepathMap()

    for filename, filepath in pairs(filepath_map) do
        local state = self:readBookState(filepath)
        if state then
            table.insert(books, state)
        end
    end

    return books
end

function BookSync:buildFilepathMap()
    local map = {}
    local dir = self:getBooksDir()

    local ok, iter, dir_obj = pcall(lfs.dir, dir)
    if not ok then return map end

    for entry in iter, dir_obj do
        if entry:match("%.epub$") then
            local filepath = dir .. "/" .. entry
            local sdr = DocSettings:getSidecarDir(filepath)
            if sdr and lfs.attributes(sdr, "mode") == "directory" then
                map[entry] = filepath
            end
        end
    end

    return map
end

return BookSync
