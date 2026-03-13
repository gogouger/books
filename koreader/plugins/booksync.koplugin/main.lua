--[[
BookSync plugin for KOReader.

Syncs reading progress, status, and ratings with a Books server
via POST /api/kobo/sync (JSON, Basic Auth).

Progress is forward-only: server and plugin always keep the
higher progress value. Progress resets when status leaves "reading".

All HTTP calls run in forked subprocesses to avoid blocking the
UI thread. Results are returned via pipe and polled by UIManager.
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
local ffiutil = require("ffi/util")
local logger = require("logger")
local json = require("json")
local lfs = require("libs/libkoreader-lfs")
local _ = require("gettext")
local T = ffiutil.template

-- Force glibc to re-read /etc/resolv.conf.
-- Needed after sleep/wake cycles where dhcpcd rewrites resolv.conf
-- but the long-running KOReader process has stale resolver state.
local ffi = require("ffi")
pcall(ffi.cdef, "int __res_init(void);")

local function resetDNSResolver()
    -- __res_init is glibc-only; Android uses Bionic which lacks it.
    if Device:isAndroid() then return end
    pcall(ffi.C.__res_init)
end

local function friendlyError(err)
    if not err then return _("Unknown error") end
    local s = tostring(err):lower()
    if s:find("host not found") or s:find("getaddrinfo")
        or s:find("name or service not known")
        or s:find("no address") then
        return _("Network not ready -- wait a moment and retry")
    elseif s:find("timeout") or s:find("timed out") then
        return _("Connection timed out -- server may be unreachable")
    elseif s:find("connection refused") then
        return _("Connection refused -- server may be down")
    elseif s:find("network is unreachable") then
        return _("Network unreachable -- check WiFi connection")
    end
    return err
end

local BookSync = WidgetContainer:extend{
    name = "booksync",
    is_doc_only = false,
    page_turn_count = 0,
    sync_in_progress = false,
    last_sync_fail_time = 0,
    last_sync_all_time = 0,
    cached_epub_hash = nil,
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
                        self:syncCurrentBookWithConnect()
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
                        self:httpGet("/api/kobo/ping", function(result, err)
                            if result then
                                UIManager:show(InfoMessage:new{
                                    text = T(_("Connected as %1"),
                                        result.username),
                                    timeout = 3,
                                })
                            else
                                UIManager:show(InfoMessage:new{
                                    text = T(_("Connection failed: %1"), friendlyError(err)),
                                    timeout = 5,
                                })
                            end
                        end)
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
    -- Cache epub_hash in memory so syncCurrentBook never reads disk.
    -- doc_settings is already loaded by KOReader at this point.
    self.cached_epub_hash = nil
    if self.ui.doc_settings then
        self.cached_epub_hash = self.ui.doc_settings:readSetting(
            "epub_hash")
    end
    if not self.cached_epub_hash and self.ui.document then
        local ok, md5 = pcall(require, "ffi/md5")
        if ok and self.ui.document.file then
            self.cached_epub_hash = md5.sumFile(self.ui.document.file)
            if self.cached_epub_hash and self.ui.doc_settings then
                self.ui.doc_settings:saveSetting(
                    "epub_hash", self.cached_epub_hash)
                self.ui.doc_settings:flush()
            end
        end
    end

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
        -- Defer to after the current event cycle so the page renders
        -- before any sync overhead runs.
        UIManager:nextTick(function()
            if NetworkMgr:isConnected() then
                self:syncCurrentBook()
            end
        end)
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
    if not self.ui.document then return end
    self:syncCurrentBookSync()
end

function BookSync:onResume()
    if not self:getSetting("auto_sync", true) then return end
    resetDNSResolver()
    UIManager:scheduleIn(2, function()
        if not NetworkMgr:isConnected() then return end
        if not self.ui.document then return end
        -- Skip if onNetworkConnected already synced recently
        if os.time() - self.last_sync_all_time < 30 then return end
        self:syncCurrentBook("on_open")
    end)
end

function BookSync:onNetworkConnected()
    if not self:getSetting("auto_sync", true) then return end
    -- Phones toggle network state frequently; skip if synced recently.
    if os.time() - self.last_sync_all_time < 60 then return end
    resetDNSResolver()
    UIManager:scheduleIn(5, function()
        if NetworkMgr:isConnected() then
            self:syncAll()
        end
    end)
end

function BookSync:onNetworkDisconnecting()
    if not self:getSetting("auto_sync", true) then return end
    if os.time() - self.last_sync_fail_time < 30 then return end
    if os.time() - self.last_sync_all_time < 60 then return end
    self:syncAll()
end

function BookSync:onBookSyncAll()
    self:syncAllWithConnect()
end

function BookSync:onBookSyncCurrent()
    if self.ui.document then
        self:syncCurrentBookWithConnect()
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

-- Build current-book state entirely from live memory.
-- No disk I/O: uses doc_props, doc_settings cache, and rolling progress.
function BookSync:readCurrentBookState()
    if not self.ui.document then return nil end
    local filepath = self.ui.document.file
    if not filepath then return nil end

    local filename = filepath:match("([^/]+)$") or filepath

    local title = self.ui.doc_props and self.ui.doc_props.display_title
    local authors = self.ui.doc_props and self.ui.doc_props.authors

    if not title or title == "" then
        local base = filename:gsub("%.epub$", "")
        local dash_pos = base:find(" %- ")
        if dash_pos then
            authors = (not authors or authors == "")
                and base:sub(1, dash_pos - 1) or authors
            title = base:sub(dash_pos + 3)
        else
            title = base
        end
    end

    -- Status and rating from in-memory doc_settings cache
    local summary = self.ui.doc_settings
        and self.ui.doc_settings:readSetting("summary") or {}
    local status = summary.status

    -- Live progress from the reader engine
    local progress = nil
    local ok, pct = pcall(function()
        if self.ui.rolling and self.ui.rolling.getLastPercent then
            return self.ui.rolling:getLastPercent()
        end
    end)
    if ok and type(pct) == "number" then
        progress = pct
    end

    if not status and progress and progress > 0 then
        status = "reading"
    end

    return {
        filename = filename,
        epub_hash = self.cached_epub_hash,
        title = title,
        authors = authors or "",
        reading_status = status,
        progress = progress,
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

-- Async HTTP helpers.
-- All network I/O runs in a forked subprocess so the UI thread
-- never blocks on DNS resolution or socket timeouts.

function BookSync:asyncHttp(method, path, body_str, callback, silent)
    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        UIManager:nextTick(function()
            callback(nil, "Not configured")
        end)
        return
    end

    local mime = require("mime")
    local auth_header = "Basic " .. mime.b64(
        settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "") .. path

    -- Android: fork() is unreliable, run HTTP synchronously.
    -- silent=true (page turns): deferred, no UI indicator.
    -- silent=false: show "Syncing..." toast while HTTP runs.
    if Device:isAndroid() then
        local progress_msg
        if not silent then
            progress_msg = InfoMessage:new{
                text = _("Syncing..."),
            }
            UIManager:show(progress_msg)
        end

        UIManager:scheduleIn(0.1, function()
            local ok, err = pcall(function()
                local http = require("socket.http")
                local ltn12 = require("ltn12")
                local socketutil = require("socketutil")

                local response_parts = {}
                local req = {
                    url = full_url,
                    method = method,
                    headers = {
                        ["Authorization"] = auth_header,
                    },
                    sink = ltn12.sink.table(response_parts),
                }
                if body_str then
                    req.headers["Content-Type"] = "application/json"
                    req.headers["Content-Length"] = tostring(
                        #body_str)
                    req.source = ltn12.source.string(body_str)
                end

                socketutil:set_timeout(2, 3)
                local _, code = http.request(req)
                socketutil:reset_timeout()

                if type(code) ~= "number" then
                    resetDNSResolver()
                    response_parts = {}
                    req.sink = ltn12.sink.table(response_parts)
                    if body_str then
                        req.source = ltn12.source.string(body_str)
                    end
                    socketutil:set_timeout(2, 3)
                    _, code = http.request(req)
                    socketutil:reset_timeout()
                end

                if progress_msg then
                    UIManager:close(progress_msg)
                end

                if type(code) == "number" and code == 200 then
                    callback(table.concat(response_parts), nil)
                elseif type(code) == "number" then
                    callback(nil, "HTTP " .. tostring(code))
                else
                    logger.warn("BookSync: connection failed:",
                        tostring(code))
                    callback(nil, tostring(code))
                end
            end)
            if not ok then
                if progress_msg then
                    UIManager:close(progress_msg)
                end
                logger.warn("BookSync: Android sync error:", err)
                callback(nil, tostring(err))
            end
        end)
        return
    end

    local pid, parent_read_fd = ffiutil.runInSubProcess(
        function(_pid, write_fd)
            resetDNSResolver()

            local http = require("socket.http")
            local ltn12 = require("ltn12")
            local socketutil = require("socketutil")

            local response_parts = {}
            local req = {
                url = full_url,
                method = method,
                headers = {
                    ["Authorization"] = auth_header,
                },
                sink = ltn12.sink.table(response_parts),
            }
            if body_str then
                req.headers["Content-Type"] = "application/json"
                req.headers["Content-Length"] = tostring(#body_str)
                req.source = ltn12.source.string(body_str)
            end

            socketutil:set_timeout(5, 10)
            local _, code = http.request(req)
            socketutil:reset_timeout()

            -- DNS retry: resolver may be stale after sleep/wake
            if type(code) ~= "number" then
                resetDNSResolver()
                response_parts = {}
                req.sink = ltn12.sink.table(response_parts)
                if body_str then
                    req.source = ltn12.source.string(body_str)
                end
                socketutil:set_timeout(5, 10)
                _, code = http.request(req)
                socketutil:reset_timeout()
            end

            local envelope
            if type(code) == "number" then
                envelope = json.encode({
                    code = code,
                    body = table.concat(response_parts),
                })
            else
                envelope = json.encode({
                    code = 0,
                    err = tostring(code),
                })
            end
            ffiutil.writeToFD(write_fd, envelope, true)
        end, true, false)

    if not pid then
        UIManager:nextTick(function()
            callback(nil, tostring(parent_read_fd))
        end)
        return
    end

    local check
    check = function()
        if ffiutil.isSubProcessDone(pid) then
            local data = ffiutil.readAllFromFD(parent_read_fd)
            local ok, envelope = pcall(json.decode, data or "")
            if ok and envelope then
                if envelope.code == 200 then
                    callback(envelope.body, nil)
                elseif envelope.err then
                    logger.warn("BookSync: connection failed:",
                        envelope.err)
                    callback(nil, envelope.err)
                else
                    logger.warn("BookSync: HTTP", envelope.code,
                        "from", full_url)
                    callback(nil, "HTTP " .. tostring(envelope.code))
                end
            else
                callback(nil, "Subprocess communication error")
            end
        else
            UIManager:scheduleIn(0.25, check)
        end
    end
    UIManager:scheduleIn(0.25, check)
end

function BookSync:httpPost(path, body, callback, silent)
    self:asyncHttp("POST", path, json.encode(body),
        function(response_body, err)
            if err then
                callback(nil, err)
                return
            end
            local ok, result = pcall(json.decode, response_body)
            if ok then
                callback(result, nil)
            else
                callback(nil, "JSON decode error")
            end
        end, silent)
end

function BookSync:httpGet(path, callback, silent)
    self:asyncHttp("GET", path, nil,
        function(response_body, err)
            if err then
                callback(nil, err)
                return
            end
            local ok, result = pcall(json.decode, response_body)
            if ok then
                callback(result, nil)
            else
                callback(nil, "JSON decode error")
            end
        end, silent)
end

function BookSync:httpGetRaw(path, callback, silent)
    self:asyncHttp("GET", path, nil, callback, silent)
end

-- Plugin self-update

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

function BookSync:promptUpdateCheck()
    self:httpGet("/api/kobo/ping", function(result, err)
        if not result then
            UIManager:show(InfoMessage:new{
                text = T(_("Update check failed: %1"), friendlyError(err)),
                timeout = 5,
            })
            return
        end

        local remote_ver = result.plugin_version or 0
        local local_ver = self:getLocalVersion()

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
                self:performUpdate(function(ok, update_err)
                    if ok then
                        UIManager:show(ConfirmBox:new{
                            text = _("Update installed. Restart KOReader to activate."),
                            ok_text = _("Restart"),
                            cancel_text = _("Later"),
                            ok_callback = function()
                                UIManager:broadcastEvent(
                                    Event:new("RestartKOReader"))
                            end,
                        })
                    else
                        UIManager:show(InfoMessage:new{
                            text = T(_("Update failed: %1"), update_err),
                            timeout = 5,
                        })
                    end
                end)
            end,
        })
    end)
end

-- Download plugin files in a subprocess, then install in the parent.
function BookSync:performUpdate(callback)
    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        UIManager:nextTick(function()
            callback(false, "Not configured")
        end)
        return
    end

    local mime = require("mime")
    local auth_header = "Basic " .. mime.b64(
        settings.username .. ":" .. (settings.password or ""))
    local base_url = settings.server_url:gsub("/$", "")
    local files = {"_meta.lua", "main.lua"}
    local dir = self:getPluginDir()

    -- Download files (subprocess on Kobo, synchronous on Android)
    local function downloadFiles()
        resetDNSResolver()

        local http = require("socket.http")
        local ltn12 = require("ltn12")
        local socketutil = require("socketutil")

        local new_contents = {}
        for _, name in ipairs(files) do
            local response_parts = {}
            local req = {
                url = base_url
                    .. "/api/kobo/plugin/download/" .. name,
                method = "GET",
                headers = {
                    ["Authorization"] = auth_header,
                },
                sink = ltn12.sink.table(response_parts),
            }
            socketutil:set_timeout(5, 10)
            local _, code = http.request(req)
            socketutil:reset_timeout()

            if type(code) ~= "number" then
                resetDNSResolver()
                response_parts = {}
                req.sink = ltn12.sink.table(response_parts)
                socketutil:set_timeout(5, 10)
                _, code = http.request(req)
                socketutil:reset_timeout()
            end

            if type(code) ~= "number" or code ~= 200 then
                local err_msg = type(code) == "number"
                    and ("HTTP " .. tostring(code))
                    or tostring(code)
                return nil, name .. ": " .. err_msg
            end
            new_contents[name] = table.concat(response_parts)
        end
        return new_contents, nil
    end

    local function installFiles(new_contents)
        -- Write to .new temp files
        for _, name in ipairs(files) do
            local f, write_err = io.open(
                dir .. "/" .. name .. ".new", "w")
            if not f then
                return false, T(
                    _("Cannot write %1.new: %2"),
                    name, write_err)
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
            local rename_ok = os.rename(new, orig)
            if not rename_ok then
                for _, rname in ipairs(files) do
                    local rorig = dir .. "/" .. rname
                    local rbak = rorig .. ".bak"
                    local rnew = rorig .. ".new"
                    if lfs.attributes(rbak, "mode") then
                        os.rename(rbak, rorig)
                    end
                    os.remove(rnew)
                end
                return false, T(
                    _("Failed to install %1"), name)
            end
        end

        -- Clean up .bak files
        for _, name in ipairs(files) do
            os.remove(dir .. "/" .. name .. ".bak")
        end
        return true, nil
    end

    -- Android: fork() is unreliable, download synchronously
    if Device:isAndroid() then
        local new_contents, dl_err = downloadFiles()
        if not new_contents then
            UIManager:nextTick(function()
                callback(false, dl_err or "Download failed")
            end)
            return
        end
        local ok, inst_err = installFiles(new_contents)
        UIManager:nextTick(function()
            callback(ok, inst_err)
        end)
        return
    end

    local pid, parent_read_fd = ffiutil.runInSubProcess(
        function(_pid, write_fd)
            local new_contents, dl_err = downloadFiles()
            if not new_contents then
                ffiutil.writeToFD(write_fd, json.encode({
                    ok = false,
                    err = dl_err,
                }), true)
                return
            end
            ffiutil.writeToFD(write_fd, json.encode({
                ok = true,
                files = new_contents,
            }), true)
        end, true, false)

    if not pid then
        UIManager:nextTick(function()
            callback(false, tostring(parent_read_fd))
        end)
        return
    end

    local check
    check = function()
        if ffiutil.isSubProcessDone(pid) then
            local data = ffiutil.readAllFromFD(parent_read_fd)
            local parse_ok, envelope = pcall(json.decode, data or "")
            if not parse_ok or not envelope then
                callback(false, "Download communication error")
                return
            end
            if not envelope.ok then
                callback(false, envelope.err or "Download failed")
                return
            end
            local ok, inst_err = installFiles(envelope.files)
            callback(ok, inst_err)
        else
            UIManager:scheduleIn(0.25, check)
        end
    end
    UIManager:scheduleIn(0.25, check)
end

-- Sync operations

-- Blocking sync for use during suspend. Runs HTTP directly in the
-- main process (no subprocess fork) so the request completes before
-- the OS suspends the device. Acceptable because the UI is not
-- interactive during suspend and the timeout is only 5 seconds.
function BookSync:syncCurrentBookSync()
    local state = self:readCurrentBookState()
    if not state then return end

    local settings = self:getSettings()
    if not settings.server_url or not settings.username then return end

    resetDNSResolver()

    local mime = require("mime")
    local http = require("socket.http")
    local ltn12 = require("ltn12")
    local socketutil = require("socketutil")

    local auth_header = "Basic " .. mime.b64(
        settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "")
        .. "/api/kobo/sync"
    local body_str = json.encode({ books = { state } })

    local response_parts = {}
    local req = {
        url = full_url,
        method = "POST",
        headers = {
            ["Authorization"] = auth_header,
            ["Content-Type"] = "application/json",
            ["Content-Length"] = tostring(#body_str),
        },
        source = ltn12.source.string(body_str),
        sink = ltn12.sink.table(response_parts),
    }

    socketutil:set_timeout(5, 5)
    local _, code = http.request(req)
    socketutil:reset_timeout()

    -- DNS retry on non-numeric error (stale resolver after wake)
    if type(code) ~= "number" then
        resetDNSResolver()
        response_parts = {}
        req.sink = ltn12.sink.table(response_parts)
        req.source = ltn12.source.string(body_str)
        socketutil:set_timeout(5, 5)
        _, code = http.request(req)
        socketutil:reset_timeout()
    end

    if type(code) == "number" and code == 200 then
        logger.info("BookSync: suspend sync completed")
    else
        local err = type(code) == "number"
            and ("HTTP " .. tostring(code)) or tostring(code)
        logger.warn("BookSync: suspend sync failed:", err)
    end
end

function BookSync:syncCurrentBook(show_toast)
    if self.sync_in_progress then return end
    -- After a failure, back off for 60s on background syncs.
    -- Allow manual sync (true) and book-open sync ("on_open").
    if not show_toast
        and os.time() - self.last_sync_fail_time < 60 then
        return
    end
    if not self.ui.document then return end

    -- Build state from live memory -- no disk I/O.
    local state = self:readCurrentBookState()
    if not state then return end

    self.sync_in_progress = true
    -- silent on page turns (show_toast is falsy) to avoid UI pause
    self:httpPost("/api/kobo/sync", { books = { state } },
        function(result, err)
            self.sync_in_progress = false
            if not result then
                self.last_sync_fail_time = os.time()
                logger.warn("BookSync: sync failed:", err)
                if show_toast then
                    UIManager:show(InfoMessage:new{
                        text = T(_("Sync failed: %1"), friendlyError(err)),
                        timeout = 3,
                    })
                end
                return
            end

            -- Jump on book open or manual sync, not background syncs
            local jumped = false
            if show_toast and result.books
                and #result.books > 0 then
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
        end, not show_toast)
end

-- syncAll runs all I/O (directory scan, sidecar reads, HTTP) in a
-- forked subprocess so the UI thread does zero blocking work.
function BookSync:syncAll(show_toast)
    if self.sync_in_progress then return end

    local settings = self:getSettings()
    if not settings.server_url or not settings.username then
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = _("Not configured."),
                timeout = 2,
            })
        end
        return
    end

    local books_dir = self:getBooksDir()

    local mime = require("mime")
    local auth_header = "Basic " .. mime.b64(
        settings.username .. ":" .. (settings.password or ""))
    local full_url = settings.server_url:gsub("/$", "")
        .. "/api/kobo/sync"

    self.sync_in_progress = true
    self.last_sync_all_time = os.time()

    -- Scan books directory and collect metadata from sidecars.
    local function collectBooks()
        local scan_lfs = require("libs/libkoreader-lfs")
        local scan_DocSettings = require("docsettings")
        local books = {}
        local ok_dir, iter, dir_obj = pcall(scan_lfs.dir, books_dir)
        if ok_dir then
            for entry in iter, dir_obj do
                if entry:match("%.epub$") then
                    local filepath = books_dir .. "/" .. entry
                    local sdr = scan_DocSettings:getSidecarDir(
                        filepath)
                    if sdr
                        and scan_lfs.attributes(sdr, "mode")
                            == "directory" then
                        local sidecar = scan_DocSettings:open(
                            filepath)
                        if sidecar then
                            local data = sidecar.data or {}
                            local summary = data.summary or {}
                            local filename = entry

                            local epub_hash = data.epub_hash
                            if not epub_hash then
                                local hash_ok, md5 = pcall(
                                    require, "ffi/md5")
                                if hash_ok then
                                    epub_hash = md5.sumFile(
                                        filepath)
                                    if epub_hash then
                                        sidecar:saveSetting(
                                            "epub_hash", epub_hash)
                                        sidecar:flush()
                                    end
                                end
                            end

                            local title = data.doc_props
                                and data.doc_props.title
                            local authors = data.doc_props
                                and data.doc_props.authors

                            if not title then
                                local base = filename:gsub(
                                    "%.epub$", "")
                                local dash = base:find(" %- ")
                                if dash then
                                    authors = authors
                                        or base:sub(1, dash - 1)
                                    title = base:sub(dash + 3)
                                else
                                    title = base
                                end
                            end

                            local status = summary.status
                            if not status
                                and data.percent_finished
                                and data.percent_finished > 0 then
                                status = "reading"
                            end

                            table.insert(books, {
                                filename = filename,
                                epub_hash = epub_hash,
                                title = title,
                                authors = authors or "",
                                reading_status = status,
                                progress = data.percent_finished,
                                rating = summary.rating,
                            })
                        end
                    end
                end
            end
        end
        return books
    end

    -- POST books payload and return (response_body, err).
    local function postBooks(books)
        resetDNSResolver()
        local http = require("socket.http")
        local ltn12 = require("ltn12")
        local socketutil = require("socketutil")

        local body_str = json.encode({ books = books })
        local response_parts = {}
        local req = {
            url = full_url,
            method = "POST",
            headers = {
                ["Authorization"] = auth_header,
                ["Content-Type"] = "application/json",
                ["Content-Length"] = tostring(#body_str),
            },
            source = ltn12.source.string(body_str),
            sink = ltn12.sink.table(response_parts),
        }

        socketutil:set_timeout(5, 10)
        local _, code = http.request(req)
        socketutil:reset_timeout()

        if type(code) ~= "number" then
            resetDNSResolver()
            response_parts = {}
            req.sink = ltn12.sink.table(response_parts)
            req.source = ltn12.source.string(body_str)
            socketutil:set_timeout(5, 10)
            _, code = http.request(req)
            socketutil:reset_timeout()
        end

        if type(code) == "number" and code == 200 then
            return table.concat(response_parts), nil
        elseif type(code) == "number" then
            return nil, "HTTP " .. tostring(code)
        else
            return nil, tostring(code)
        end
    end

    -- Apply server response and show result toast.
    local function handleSyncResult(total, response_body)
        local resp_ok, result = pcall(json.decode,
            response_body or "")
        if not resp_ok or not result or not result.books then
            if show_toast then
                UIManager:show(InfoMessage:new{
                    text = _("Synced."),
                    timeout = 2,
                })
            end
            return
        end

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

        local unmatched = total - matched
        logger.info("BookSync: synced", total, "books,",
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
    end

    -- Android: run everything synchronously with progress toast.
    if Device:isAndroid() then
        local progress_msg = InfoMessage:new{
            text = _("Syncing all books..."),
        }
        UIManager:show(progress_msg)
        UIManager:scheduleIn(0.1, function()
            local sync_ok, sync_err = pcall(function()
                local books = collectBooks()
                UIManager:close(progress_msg)

                if #books == 0 then
                    self.sync_in_progress = false
                    if show_toast then
                        UIManager:show(InfoMessage:new{
                            text = _("No books to sync."),
                            timeout = 2,
                        })
                    end
                    return
                end

                local response_body, err = postBooks(books)
                self.sync_in_progress = false
                if not response_body then
                    self.last_sync_fail_time = os.time()
                    logger.warn("BookSync: sync all failed:", err)
                    if show_toast then
                        UIManager:show(InfoMessage:new{
                            text = T(_("Sync failed: %1"),
                                friendlyError(err)),
                            timeout = 3,
                        })
                    end
                    return
                end
                handleSyncResult(#books, response_body)
            end)
            if not sync_ok then
                UIManager:close(progress_msg)
                self.sync_in_progress = false
                logger.warn("BookSync: Android sync all error:",
                    sync_err)
                if show_toast then
                    UIManager:show(InfoMessage:new{
                        text = T(_("Sync failed: %1"),
                            tostring(sync_err)),
                        timeout = 3,
                    })
                end
            end
        end)
        return
    end

    -- Kobo/other: run in forked subprocess.
    local pid, parent_read_fd = ffiutil.runInSubProcess(
        function(_pid, write_fd)
            local books = collectBooks()

            if #books == 0 then
                ffiutil.writeToFD(write_fd, json.encode({
                    phase = "empty",
                }), true)
                return
            end

            local response_body, err = postBooks(books)
            if response_body then
                ffiutil.writeToFD(write_fd, json.encode({
                    phase = "done",
                    total = #books,
                    body = response_body,
                }), true)
            else
                ffiutil.writeToFD(write_fd, json.encode({
                    phase = "error",
                    err = err,
                }), true)
            end
        end, true, false)

    if not pid then
        self.sync_in_progress = false
        if show_toast then
            UIManager:show(InfoMessage:new{
                text = T(_("Sync failed: %1"), tostring(parent_read_fd)),
                timeout = 3,
            })
        end
        return
    end

    local check
    check = function()
        if not ffiutil.isSubProcessDone(pid) then
            UIManager:scheduleIn(0.25, check)
            return
        end

        self.sync_in_progress = false
        local data = ffiutil.readAllFromFD(parent_read_fd)
        local parse_ok, envelope = pcall(json.decode, data or "")

        if not parse_ok or not envelope then
            self.last_sync_fail_time = os.time()
            logger.warn("BookSync: sync all subprocess error")
            if show_toast then
                UIManager:show(InfoMessage:new{
                    text = _("Sync failed: subprocess error"),
                    timeout = 3,
                })
            end
            return
        end

        if envelope.phase == "empty" then
            if show_toast then
                UIManager:show(InfoMessage:new{
                    text = _("No books to sync."),
                    timeout = 2,
                })
            end
            return
        end

        if envelope.phase == "error" then
            self.last_sync_fail_time = os.time()
            logger.warn("BookSync: sync all failed:", envelope.err)
            if show_toast then
                UIManager:show(InfoMessage:new{
                    text = T(_("Sync failed: %1"),
                        friendlyError(envelope.err)),
                    timeout = 3,
                })
            end
            return
        end

        handleSyncResult(envelope.total or 0, envelope.body)
    end
    UIManager:scheduleIn(0.25, check)
end

function BookSync:syncCurrentBookWithConnect()
    if NetworkMgr:isConnected() then
        self:syncCurrentBook(true)
    else
        NetworkMgr:turnOnWifiAndWaitForConnection(function()
            self:syncCurrentBook(true)
        end)
    end
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
