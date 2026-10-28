# Table TV start page (Fully Kiosk)

A start page for an Android / Google TV that shows the DM Screen map. It lists the computers that may run the DM Screen server, probes them every few seconds, and after a 10-second countdown opens the map screen of the first one that answers. Any key on the remote stops the countdown: ↑ ↓ choose a server and OK opens it. The last row lets you type one extra server (IP, port, token) with the remote; the TV remembers it.

`install.sh` puts the page on the TV over ADB, so you only touch the TV for the one-time steps below.

## What you need

- The TV with **Fully Kiosk Browser** installed from the Play Store.
- `adb` (Android platform-tools) on your computer.
- For each computer that will serve the map: its IP on the LAN and the token from its Map Screen link (the `k=` value of the link the DM panel copies). A fixed IP (a DHCP reservation in your router) keeps the list valid.

## One-time steps on the TV

1. Turn on developer options: Settings → System → About → press OK on **Android TV OS build** seven times.
2. In Developer options, turn on **USB debugging**. Some TVs then also accept ADB over the network on port 5555 (`install.sh --tv <ip>`); otherwise turn on **Wireless debugging**, pair once with `adb pair <ip>:<pairing port>` and the code it shows under "Pair device with pairing code", then pass the address and port of the main Wireless debugging screen (`--tv <ip>:<port>`).
3. Find the TV's IP in Settings → Network.

## Install

```bash
./install.sh --tv 192.0.2.50 \
  --server "Living room PC=192.0.2.20:3000:0123456789abcdef0123456789abcdef" \
  --server "Laptop=192.0.2.21:0123456789abcdef0123456789abcdef"
```

- The first run shows a debugging prompt on the TV: accept it (tick "Always allow from this computer" to skip it next time).
- `--server` takes `LABEL=HOST[:PORT]:TOKEN`; the port defaults to 3000. The order of the flags is the order the TV tries them.
- Re-run the script whenever the list or a token changes; it overwrites the page.

The script enables Fully if it was disabled, grants it read access to storage (Fully refuses `file://` pages without it), writes the page into Fully's own files directory and opens it.

## Fully settings

Set these once in Fully (Menu key on the remote, or a long press on Back → Settings; the search box finds each one):

| Setting | Value | Why |
|---|---|---|
| Start URL | `file:///sdcard/Android/data/de.ozerov.fully/files/start.html` | the page the script installs |
| Enable Text Input | on | with it off, Fully keeps every key from the remote away from the page |
| Launch on Boot | on | the TV opens straight into the page |
| Keep Screen On | on | no screensaver in the middle of a fight |
| Auto Reload on Screen On | on | turning the TV off and on goes back to the server list |
| Autoplay Videos | on | animated maps start without a click |
| Show Menu Hint on Start | off | the hint covers the bottom of the map |

With a Fully PLUS licence, turn on Remote Administration, give it a password, restart Fully, and pass `--fully-password <password>` to `install.sh`: it then applies all of the above over Fully's REST API, and also sets the page as Fully's error page, so a computer that stops serving sends the TV back to the list.

## When you are done

Network ADB lets anyone on the LAN who gets the prompt accepted control the TV. When you no longer need it: Developer options → **Revoke USB debugging authorisations**, turn USB debugging off, and restart the TV.
