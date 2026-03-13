# Local KOReader Patches

Patches applied directly to KOReader on the Kobo device. These must be re-applied
after KOReader updates.

## wifi_was_on persistence on connection abort

**File on Kobo**: `/mnt/onboard/.adds/koreader/frontend/ui/network/manager.lua`

**Function**: `NetworkMgr:_abortWifiConnection()` (near line 40)

**Problem**: When `restoreWifiAsync` times out (45s with no WiFi available),
`_abortWifiConnection` clears `wifi_was_on = false`. This permanently disables
`auto_restore_wifi` until the user manually toggles WiFi back on. If you take the
Kobo somewhere without WiFi and open/close it a few times, WiFi will never
auto-restore again even after returning to a known network.

**Patch**: Comment out the two lines that clear `wifi_was_on`:

```lua
-- In _abortWifiConnection(), comment out:
    -- self.wifi_was_on = false
    -- G_reader_settings:makeFalse("wifi_was_on")
```

**Applied**: 2026-03-04
