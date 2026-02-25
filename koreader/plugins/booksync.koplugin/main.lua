--[[
BookSync plugin for KOReader.

Syncs reading progress, status, and ratings with a Books server
via POST /api/kobo/sync (JSON, Basic Auth).
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
    books_dir = "/mnt/onboard/books",
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
                        local result, err = self:httpPost("/api/kobo/sync", { books = {} })
                        if result then
                            UIManager:show(InfoMessage:new{
                                text = _("Connection successful!"),
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

-- Event handlers

function BookSync:onReaderReady()
    if not self:getSetting("auto_sync", true) then return end
    if not NetworkMgr:isConnected() then return end
    -- Slight delay to let reader settle
    UIManager:scheduleIn(2, function()
        self:syncCurrentBook(true)
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
    -- Delay to let DHCP/DNS settle after WiFi connects
    UIManager:scheduleIn(5, function()
        if NetworkMgr:isConnected() then
            self:syncAll()
        end
    end)
end

function BookSync:onNetworkDisconnecting()
    if not self:getSetting("auto_sync", true) then return end
    self:syncAll()
end

function BookSync:onBookSyncAll()
    self:syncAllWithConnect()
end

-- Core sync functions

function BookSync:readBookState(filepath)
    local sidecar = DocSettings:open(filepath)
    if not sidecar then return nil end

    local data = sidecar.data or {}
    local summary = data.summary or {}

    -- Extract filename from path
    local filename = filepath:match("([^/]+)$") or filepath

    -- Get title/authors from sidecar or filename
    local title = data.doc_props and data.doc_props.title
    local authors = data.doc_props and data.doc_props.authors

    -- If no doc_props, try to parse "Author - Title.epub"
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

    -- If book has progress but no explicit status, it's being read
    local status = summary.status
    if not status and data.percent_finished and data.percent_finished > 0 then
        status = "reading"
    end

    -- Always use current time; sidecar's summary.modified only updates on
    -- status/rating changes, not page turns, so it's unreliable for sync
    local modified = os.date("!%Y-%m-%dT%H:%M:%SZ")

    return {
        filename = filename,
        title = title,
        authors = authors or "",
        reading_status = status,
        progress = data.percent_finished,
        rating = summary.rating,
        modified = modified,
    }
end

function BookSync:applyServerState(filepath, server)
    local sidecar = DocSettings:open(filepath)
    if not sidecar then return false end

    local data = sidecar.data or {}
    if not data.summary then data.summary = {} end
    local changed = false

    -- Apply reading status
    if server.reading_status then
        if data.summary.status ~= server.reading_status then
            data.summary.status = server.reading_status
            changed = true
        end
    end

    -- Apply progress
    if server.progress and server.progress ~= data.percent_finished then
        data.percent_finished = server.progress
        changed = true
    end

    -- Apply rating
    if server.rating then
        if data.summary.rating ~= server.rating then
            data.summary.rating = server.rating
            changed = true
        end
    end

    if changed then
        if server.modified then
            data.summary.modified = server.modified
        end
        sidecar:saveSetting("percent_finished", data.percent_finished)
        sidecar:saveSetting("summary", data.summary)
        sidecar:flush()
        logger.info("BookSync: applied server state to", filepath)
    end
    return changed
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

    socketutil:set_timeout(10, 30)
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

function BookSync:offerJumpAhead(server_books)
    if not self.ui.document then return end
    if not self.ui.document.getProgress then return end
    local current_file = self.ui.document.file
    if not current_file then return end

    local current_filename = current_file:match("([^/]+)$")
    for _, server in ipairs(server_books) do
        if server.filename == current_filename
            and server.book_id
            and server.progress then
            local local_progress = self.ui.document:getProgress()
            if server.progress > local_progress + 0.001 then
                local pct = math.floor(server.progress * 100)
                local ConfirmBox = require("ui/widget/confirmbox")
                UIManager:show(ConfirmBox:new{
                    text = T(_("Server has further progress (%1%%). Jump ahead?"), pct),
                    ok_text = _("Jump"),
                    ok_callback = function()
                        self.ui:handleEvent(Event:new("GotoPercentage", server.progress * 100))
                    end,
                })
            end
            break
        end
    end
end

function BookSync:syncCurrentBook(show_toast)
    if not self.ui.document then return nil, "No book open" end
    local filepath = self.ui.document.file
    if not filepath then return nil, "No file path" end

    local state = self:readBookState(filepath)
    if not state then return nil, "Cannot read book state" end

    local result, err = self:httpPost("/api/kobo/sync", {
        books = { state },
    })
    if not result then
        logger.warn("BookSync: sync failed:", err)
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = T(_("Sync failed: %1"), err),
                timeout = 3,
            })
        end
        return nil, err
    end

    -- Server already did conflict resolution; always apply response
    local applied = false
    if result.books and #result.books > 0 then
        local server = result.books[1]
        if server.book_id then
            applied = self:applyServerState(filepath, server)
        end
    end

    -- If server has further progress for this book, offer to jump
    if result.books then
        self:offerJumpAhead(result.books)
    end

    if show_toast then
        if applied then
            UIManager:show(InfoMessage:new{
                text = _("Synced. Updated from server."),
                timeout = 2,
            })
        else
            UIManager:show(InfoMessage:new{
                text = _("Synced."),
                timeout = 2,
            })
        end
    end
    return true
end

function BookSync:syncAll(show_toast)
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

    local result, err = self:httpPost("/api/kobo/sync", {
        books = books,
    })
    if not result then
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

    -- Build filename -> filepath map for applying responses
    local filepath_map = self:buildFilepathMap()

    -- Server already did conflict resolution; always apply responses
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

    -- If the currently-open book was updated with further progress, offer to jump
    self:offerJumpAhead(result.books)

    logger.info("BookSync: synced", #books, "books,", applied, "updated from server")

    if show_toast then
        UIManager:show(InfoMessage:new{
            text = T(_("Synced %1 books (%2 matched, %3 updated)."),
                #books, matched, applied),
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
    -- Find all books with .sdr sidecar directories
    local map = {}
    local dir = self.books_dir

    local ok, iter, dir_obj = pcall(lfs.dir, dir)
    if not ok then return map end

    for entry in iter, dir_obj do
        if entry:match("%.epub$") then
            local filepath = dir .. "/" .. entry
            -- Only include if sidecar exists (has been opened)
            local sdr = DocSettings:getSidecarDir(filepath)
            if sdr and lfs.attributes(sdr, "mode") == "directory" then
                map[entry] = filepath
            end
        end
    end

    return map
end

return BookSync
