# Map Screen — Table TV Start Page

> An Android / Google TV running Fully Kiosk Browser opens a local start page instead of a fixed map URL. The page lists the computers that may run the DM Screen server, probes them, and opens the map screen of the first that answers after a countdown, or of the one chosen with the remote. `install.sh` writes the page onto the TV over ADB, so the TV needs no typing beyond Fully's own settings.

## Source files

- `tv-kiosk/start.html` — the start page; `{{SERVERS}}` is the only placeholder
- `tv-kiosk/install.sh` — ADB installer: argument parsing, JSON escaping, Fully permissions, push, optional Fully Remote Admin configuration
- `tv-kiosk/README.md` — user steps on the TV and the Fully settings table

## Settings used

- none (the page carries its own server list; the custom entry lives in the TV's `localStorage` under `dmCustomServer`)

## Requirements

1. `install.sh` shall take `--tv HOST[:PORT]` (port 5555 by default), one or more `--server LABEL=HOST[:PORT]:TOKEN` (port 3000 by default, listed in probe order), and an optional `--fully-password`; it shall refuse a missing TV, no server, a malformed server or a non-numeric port before touching ADB.
2. `install.sh` shall `adb connect` the TV, wait up to 60 seconds for the device to be authorised, fail when Fully (`de.ozerov.fully`) is not installed, enable Fully for user 0, and grant it `READ_MEDIA_IMAGES`, `READ_MEDIA_VIDEO`, `READ_MEDIA_AUDIO` and `READ_EXTERNAL_STORAGE`, because Fully refuses `file://` start pages without read access to shared storage.
3. `install.sh` shall replace the single `{{SERVERS}}` placeholder of `start.html` with a JSON array of `{ label, host, port, token }`, escaping `\`, `"` and `<` in every string so no value can break out of the inline script, and shall fail when the template does not hold exactly one placeholder.
4. `install.sh` shall push the page to `/sdcard/Android/data/de.ozerov.fully/files/start.html`, Fully's own files directory, whose `file://` URL is the start URL.
5. When `--fully-password` is given, `install.sh` shall check Fully's Remote Admin on `<tv>:2323`, set `startURL` and `errorURL` to the page and `softKeyboard`, `launchOnBoot`, `keepScreenOn`, `reloadOnScreenOn` and `autoplayVideos` to true and `showMenuHint` to false, then load the start URL; otherwise it shall open the page with a `VIEW` intent and print the same settings for the user to set by hand. `softKeyboard` is Fully's "Enable Text Input": with it off Fully keeps every remote key away from the WebView.
6. The page shall probe `http://<host>:<port>/health` of every server every 3 seconds with a 2-second timeout and a `no-cors` fetch, and show each one as "available" or "—".
7. When a probe round finds an available server and no key has been pressed, the page shall select it and count down 10 seconds, then open `http://<host>:<port>/map?k=<token>` with `location.replace`.
8. When any key arrives (keydown or keyup) during the countdown, the page shall stop the countdown for good and keep probing. The page shall move its own selection with the arrow keys over the server rows and the last row, and open the selected row on Enter or keyCode 23, instead of relying on the WebView's spatial navigation.
9. The last row shall open a form (IP, port, token); saving it with an IP and a token shall store `{ host, port, token }` in `localStorage` (`dmCustomServer`) and list it as "Custom" after the fixed servers; saving it with an empty IP or token shall remove it. Escape or Back shall close the form.
10. All page text shall be in English and built with DOM APIs and text nodes; `innerHTML` is used only to clear the list.

## Tests covering this

- Manual: `install.sh` against an Android 14 Google TV with Fully 1.61: the generated page lists three servers, counts down, opens the first that answers, and the remote's arrows and OK choose another; the custom entry persists across Fully restarts.

## Non-goals

- Importing Fully settings from a JSON file. The Play Store build of Fully does not hold the all-files permission it would need to read `fully-once-settings.json` from shared storage.
- Discovering servers on the network. The list is explicit; mDNS names from a TV resolve intermittently, so fixed IPs are the supported form.
