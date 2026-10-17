# Self-hosting Hydrus for DM Screen

DM Screen's Hydrus features (the **Media from Hydrus** explorer, `hydrus://` note references, and Foundry wall import for Hydrus maps) need a [Hydrus Network](https://hydrusnetwork.github.io/hydrus/) client with its Client API turned on. This folder is an optional, ready-made setup for that:

- `docker-compose.yml` — Hydrus (GUI in the browser via noVNC, plus the Client API) and [Hydrui](https://github.com/hydrui/hydrui), a web front-end for browsing the library.
- `init-hydrus-api.sh` — a first-boot bootstrap that enables the Client API and registers your access key, so you never have to click through the Hydrus GUI to get an API key.
- `enrich.py` — tags files you already imported from the folders they live in (`artist/genre/type/name`), including the tags the plugin's Foundry wall import looks for.

If you already run Hydrus, you only need [Connecting the plugin](#connecting-the-plugin) and, optionally, [enrich.py](#tagging-from-folders-with-enrichpy).

## Quick start

Requirements: Docker with Compose, and internet access on the first boot (the bootstrap installs `sqlite` inside the container).

```sh
cd hydrus
cp .env.example .env
openssl rand -hex 32   # paste as HYDRUS_API_KEY in .env
openssl rand -hex 32   # paste as HYDRUI_SECRET in .env

# Hydrui login (pick your own user and password)
mkdir -p hydrui
docker run --rm httpd:alpine htpasswd -nbB dm 'choose-a-password' > hydrui/htpasswd

docker compose up -d
```

The first boot creates the database, enables the Client API and stores your key; it takes about 40 seconds before the API answers. Then check the key:

```sh
curl -H "Hydrus-Client-API-Access-Key: <your HYDRUS_API_KEY>" http://localhost:45869/verify_access_key
```

The answer should include `"permits_everything": true`. A `403` means the key does not match.

`db/` (the whole library, media included) and `imports/` are created next to the compose file. Both are git-ignored, as are `.env` and `hydrui/htpasswd`.

### Ports

| Port | Service | What for |
|---|---|---|
| `5800` | Hydrus | The full Hydrus GUI in your browser (noVNC): imports, tag editing, settings |
| `45869` | Hydrus | Client API, used by the plugin, Hydrui and `enrich.py` |
| `8080` | Hydrui | Web front-end; log in with a user from `hydrui/htpasswd` |

All three are published on every interface of the host. The Client API is plain HTTP and the key permits everything, so keep these ports on a network you trust and never expose them to the internet. Bind them to `127.0.0.1` in `docker-compose.yml` if only this machine needs them.

Hydrui is published for amd64 only; on Apple Silicon Docker runs it under emulation, which works but is slower to start.

### About the key

- `HYDRUS_API_KEY` is written into Hydrus on the **first boot only** (a `db/.initialized` marker skips the bootstrap afterwards). Changing it in `.env` later has no effect on Hydrus — add another key from the GUI instead (see below). Hydrui reads the same variable, so if you switch keys, update `.env` to the key Hydrus actually has.
- The bootstrap refuses to start if `HYDRUS_API_KEY` is not exactly 64 lowercase hex characters.

## Bringing an existing library

Stop your old client and copy its database folder (the one with `client.db`, `client.*.db` and `client_files/`) into `hydrus/db/` before the first `docker compose up -d`. Hydrus runs as uid/gid `1000` inside the container and the bootstrap only fixes the ownership of `db/` itself, so on Linux make the copy readable and writable by it: `sudo chown -R 1000:1000 db`.

When `db/` already contains a `client.db`, the bootstrap leaves the Client API untouched — overwriting it would wipe that library's existing keys — and prints `Existing client.db found: Client API left untouched, enable it from the GUI`. Turn the API on and create a key by hand as described next.

## Enabling the Client API by hand

Use this for an existing library, to add a second key, or if the bootstrap ever fails on a newer Hydrus version. Open the GUI at `http://localhost:5800`.

1. **services → manage services** → open the **client api** service. Set the port to `45869`, tick **allow non-local connections** (the plugin, Hydrui and `enrich.py` reach Hydrus from outside the container) and **support CORS**, leave https off. Apply.
2. **services → review services** → **local** → **client api** → **add → manually**. Give the key a name, tick the permissions you want (for the plugin plus `enrich.py`: everything is simplest), and copy the 64-hex access key.
3. Put that key in the plugin settings and, if you use Hydrui or `enrich.py`, in `.env` as `HYDRUS_API_KEY`; then `docker compose up -d` to recreate Hydrui with it.

The [Client API docs](https://hydrusnetwork.github.io/hydrus/client_api.html) cover this screen in more detail.

## Importing files

Hydrus keeps its own copy of everything it imports, so the source folder only matters at import time. `imports/` is mounted read-only into the container at `/imports`.

1. Put your maps, scenes and Foundry module zips under `imports/`. If you plan to use `enrich.py`, follow its folder layout, e.g. `imports/Czepeku/Fantasy/Battlemaps/Night Market/…`.
2. In the GUI (`:5800`), either import once with **file → import files** and pick `/imports`, or watch the folder with **file → import and export folders → manage import folders**, pointing it at `/imports`.

Zip files are imported as files like any other; the plugin's explorer never lists them (it only shows images and videos), but the Foundry wall import finds them by tag.

## Connecting the plugin

Open **Settings → DM Screen → Hydrus Library**:

1. **Enable Hydrus integration** — turns on the **Media from Hydrus** button in the DM Control Panel.
2. **API URL** — `http://localhost:45869` if Hydrus runs on the same machine as Obsidian, otherwise `http://<LAN IP of the Docker host>:45869`. Plain `http` is accepted only for `localhost`, private IPv4 addresses (`10.x`, `172.16–31.x`, `192.168.x`) and single-label `.local` names; anything else must be `https` (put a reverse proxy in front).
3. **API key** — your `HYDRUS_API_KEY`. Click **Test connection**; you should see `Hydrus OK: …`.
4. **Tag services** — click **Fetch services** and tick the services the search box should suggest tags from (`my tags` is where `enrich.py` writes by default). Searches and the tags shown on tiles cover every tag service.

Optional settings in the same section:

- **Default search tags** — pre-filled in the explorer's search box, e.g. `type:battlemap`.
- **Ignored tag patterns** — one regex per line, matched against the whole tag. Matching tags are hidden from the tile menu, the preview, **Copy tags** and the search suggestions. The defaults hide `rating:` tags and the marker tags two common AI auto-taggers add; add your own, e.g. `grid:.*` or `artist:.*`, if those tags are just noise to you while browsing.
- **Cache base folder**, **Cache TTL (days)**, **Loop background media**, **Mute background media** — where downloaded files are cached in the vault, how long unused ones stay, and how videos play as backgrounds.

The plugin only reads from Hydrus; it never adds or removes tags.

## Recommended tags

Hydrus tags are free-form; these are the ones the plugin actually reads, plus a few that make browsing easier. `enrich.py` writes all of them from the folder layout.

| Tag | Example | What the plugin does with it |
|---|---|---|
| `name:` | `name:night market` | Labels a Hydrus image when you **Add as image layer** and the link text of **Copy image reference**. When a Hydrus file is **set as map**, the plugin searches for a Foundry module with the same `name:` to offer a wall import, and uses its words to pick the right scene inside that module. |
| `type:foundry module` | `type:foundry module` | Marks a Foundry VTT module zip. The wall import searches exactly `name:<map name>` + `type:foundry module`; give the zip no other `type:` tag. |
| `type:` (other values) | `type:battlemap`, `type:scene` | Search/browse only — e.g. a default search tag of `type:battlemap`. |
| `artist:` | `artist:czepeku` | Search/browse only. |
| `genre:` | `genre:fantasy` | Search/browse only. |
| `grid:` | `grid:gridless`, `grid:30x20` | Search/browse only. The plugin takes the grid from a Foundry import or from calibration, not from this tag. |
| plain variant tags | `night`, `rain`, `snow` | When a module holds several scenes of the same room (day, night, rain…), the scene picker scores each scene by the map's `name:` words and its **unnamespaced** tags; namespaced tags other than `name:` are ignored there. That is why `enrich.py` writes variants without a namespace. |

Everything else (AI tags, `rating:`, your own namespaces) is searchable and shows on tiles unless you hide it with **Ignored tag patterns**.

## Tagging from folders with enrich.py

`enrich.py` walks a folder, maps each file's path onto a layout template and adds the resulting tags to files Hydrus already has. It needs only Python 3 (standard library).

Default layout `{artist}/{genre}/{type}/{name}`, so with

```
imports/Czepeku/Fantasy/Battlemaps/Night Market/Gridded/G_NightMarket_Rain_30x20.jpg
imports/Czepeku/Fantasy/Battlemaps/Night Market/Gridless/GL_NightMarket.jpg
imports/Czepeku/Fantasy/Foundry Modules/Night Market/night-market.zip
imports/stray/x.png
```

a dry run prints:

```
Czepeku/Fantasy/Battlemaps/Night Market/Gridded/G_NightMarket_Rain_30x20.jpg
    artist:czepeku, genre:fantasy, type:battlemap, name:night market, grid:gridded, grid:30x20, rain
Czepeku/Fantasy/Battlemaps/Night Market/Gridless/GL_NightMarket.jpg
    artist:czepeku, genre:fantasy, type:battlemap, name:night market, grid:gridless
Czepeku/Fantasy/Foundry Modules/Night Market/night-market.zip
    artist:czepeku, genre:fantasy, name:night market, type:foundry module

3 files to tag, 1 skipped (path does not fit {artist}/{genre}/{type}/{name})
dry-run: pass --apply to write these tags to Hydrus
```

The rules:

- Each `{namespace}` in the layout turns the folder at that position into `namespace:value`; values are lowercased, `_` becomes a space, and `type:` values are singularised (`Battlemaps` → `battlemap`). Literal segments (no braces) must match exactly or the file is skipped, as are files whose path is shorter than the layout. Folders deeper than `{name}` belong to that map.
- A `Gridded`/`Gridless` folder or a `G_`/`GL_` filename prefix adds `grid:gridded`/`grid:gridless`; a `NxM` token of up to three digits per side in the filename adds `grid:NxM`.
- A known modifier word in the filename (`day`, `night`, `rain`, `fog`, `snow`, `winter`, `lit`, `unlit`, `fire`, …) adds a plain variant tag, but not when the word is part of the map's name (`Night Market` alone gets no `night`).
- A `.zip` gets `type:foundry module` and the map's `name:`, replacing the layout's `type:`.

Use your own layout with `--layout`, e.g. `--layout "maps/{artist}/{name}"`. Run `python3 enrich.py --help` for every option (`--root`, `--api-url`, `--api-key`, `--service`, `--limit`, `--apply`).

Run it from `hydrus/`, after Hydrus has finished importing the files:

```sh
python3 enrich.py                                  # dry run: never contacts Hydrus
HYDRUS_API_KEY=<key> python3 enrich.py --apply     # write the tags
```

With `--apply` it hashes every planned file and only tags files Hydrus already has; the summary line counts the ones that are not in Hydrus yet (import them, then run again). Tags you deleted in Hydrus are never added back (see [Gotchas](#gotchas)). Running it again is safe.

No Python on the host? Use a throwaway container:

```sh
# Dry run
docker run --rm -v "$PWD:/w" -w /w python:3-alpine python enrich.py

# Apply, Linux
docker run --rm --network host -v "$PWD:/w" -w /w -e HYDRUS_API_KEY python:3-alpine python enrich.py --apply

# Apply, Docker Desktop (macOS / Windows)
docker run --rm -v "$PWD:/w" -w /w -e HYDRUS_API_KEY python:3-alpine \
  python enrich.py --apply --api-url http://host.docker.internal:45869
```

`-e HYDRUS_API_KEY` passes the variable from your shell, so `export HYDRUS_API_KEY=<key>` first.

The unit tests run the same way: `docker run --rm -v "$PWD:/w" -w /w python:3-alpine python -m unittest -v`.

## Upgrading

Both images are pinned in `docker-compose.yml`. To upgrade:

1. Back up `db/` first ([Backups](#backups)). Hydrus migrates its database schema forward on the first start of a new version, and an older version cannot open a migrated database: the backup is your only way back.
2. Change the `image:` tag of `hydrus` (and/or `hydrui`) to the new version.
3. `docker compose pull && docker compose up -d`.

The first start after a Hydrus bump can take several minutes before the Client API answers while the migration runs; follow it with `docker compose logs -f hydrus` and don't stop the container halfway. The compose file deliberately has no API healthcheck for Hydrus, so nothing restarts it mid-migration. Read the [Hydrus changelog](https://hydrusnetwork.github.io/hydrus/changelog.html) before jumping many versions.

## Backups

`db/` is the whole library: the databases plus every imported file under `db/client_files/`. Copy it while Hydrus is stopped, so the SQLite files are consistent:

```sh
docker compose stop hydrus
tar -czf hydrus-db-$(date +%F).tar.gz db
docker compose start hydrus
```

Restore by putting that `db/` back in place before starting the container. Keep `.env` and `hydrui/htpasswd` somewhere safe too; they are not in the repo.

## Gotchas

- **Deleted tags leave a tombstone.** Removing a tag in Hydrus keeps a "deleted" record on the file. The plugin reads only current tags, so deleted tags disappear from the explorer, and `enrich.py` skips any tag that has a tombstone on that file instead of adding it back. To get such a tag back, add it by hand in Hydrus.
- **Re-importing undoes tag cleanups.** If an import (manual or an import folder) has filename-to-tag parsing turned on, importing the same files again re-adds the tags you cleaned up. Clean tags after your last import of those files, or turn that parsing off.
- **Changing `HYDRUS_API_KEY` after the first boot does nothing** for Hydrus; add a key from the GUI. Deleting `db/` (and with it the whole library) is the only way to re-run the bootstrap.
- **Hydrui's healthcheck skips Hydrus on purpose.** The image's built-in check also asks whether Hydrus answers, which marks a healthy Hydrui as unhealthy whenever Hydrus is slow or migrating. The compose file replaces it with a check of Hydrui alone.
- **The plugin refuses `http://` to public hosts.** Use a LAN IP, `localhost` or a `.local` name, or `https`.
- **The first boot needs internet** (the bootstrap installs `sqlite` with `apk`). Later boots don't.
