#!/usr/bin/env python3
"""Tag files already imported into Hydrus from the folder layout they live in.

Each file under --root is matched against --layout, a path template such as
`{artist}/{genre}/{type}/{name}`: every `{namespace}` placeholder turns the
directory at that position into a `namespace:value` tag, and literal segments
must match exactly. On top of the layout:

  - a `Gridded`/`Gridless` folder or a `G_`/`GL_` filename prefix -> grid:gridded / grid:gridless
  - an `NxM` token in the filename (e.g. `30x20`)                  -> grid:30x20
  - a known modifier word in the filename (night, rain, ...)        -> night, rain, ...
  - a `.zip` file                                                   -> type:foundry module + the map's name:

Dry-run by default: prints the planned tags and never contacts Hydrus.
Pass --apply to write them to the tag service.
"""

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request
from pathlib import PurePosixPath

DEFAULT_LAYOUT = "{artist}/{genre}/{type}/{name}"
FOUNDRY_MODULE_TAG = "type:foundry module"
BATCH = 256  # Hydrus caps file_metadata at 256 hashes per request.

MODIFIERS = {
    "day", "night", "sunset", "sunrise", "dawn", "dusk",
    "rain", "fog", "dark", "snow", "snowing",
    "winter", "spring", "summer", "autumn", "fall",
    "lit", "unlit", "natural", "toxic", "blood",
    "fireflies", "stars", "rainbow", "flood", "fire",
    "original", "lava", "drought", "sandstorm",
}

PLACEHOLDER = re.compile(r"^\{([a-z0-9_ -]+)\}$")
GRID_PREFIX = re.compile(r"^(GL|G)_")
# 1-3 digits keeps image resolutions like 1920x1080 out of grid:.
GRID_SIZE = re.compile(r"(?<![a-z0-9])(\d{1,3})x(\d{1,3})(?![a-z0-9])")


# --- pure functions -----------------------------------------------------------

def normalise(value):
    return re.sub(r"\s+", " ", value.replace("_", " ")).strip().lower()


def singular(value):
    # Folders are usually plural ("battlemaps") while tags read better singular.
    if len(value) > 3 and value.endswith("s") and not value.endswith("ss"):
        return value[:-1]
    return value


def words(text):
    text = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", text)
    return [w for w in re.split(r"[^a-z0-9]+", text.lower()) if w]


def parse_layout(layout):
    segments = []
    for seg in PurePosixPath(layout).parts:
        m = PLACEHOLDER.match(seg)
        segments.append((normalise(m.group(1)), None) if m else (None, seg))
    return segments


def layout_tags(dirs, layout):
    # Directories deeper than the template (e.g. `Gridded/` under the map
    # folder) belong to the map and add no layout tags of their own.
    if len(dirs) < len(layout):
        return None
    tags = {}
    for (namespace, literal), seg in zip(layout, dirs):
        if literal is not None:
            if seg != literal:
                return None
            continue
        value = normalise(seg)
        if namespace == "type":
            value = singular(value)
        if value:
            tags[namespace] = value
    return tags


def grid_tags(dirs, filename):
    tags = []
    folders = {d.lower() for d in dirs}
    prefix = GRID_PREFIX.match(filename)
    if "gridded" in folders or (prefix and prefix.group(1) == "G"):
        tags.append("grid:gridded")
    elif "gridless" in folders or (prefix and prefix.group(1) == "GL"):
        tags.append("grid:gridless")
    size = GRID_SIZE.search(PurePosixPath(filename).stem.lower())
    if size:
        tags.append(f"grid:{int(size.group(1))}x{int(size.group(2))}")
    return tags


def strip_name(stem, name):
    # Stems often glue the name together ("NightMarket_Rain"), so letters and
    # digits are compared with separators and case ignored.
    compact = "".join(words(name))
    if not compact:
        return None
    seen = 0
    for i, ch in enumerate(stem):
        if ch.isalnum():
            if ch.lower() != compact[seen]:
                return None
            seen += 1
            if seen == len(compact):
                return stem[i + 1:]
    return None


def variant_tags(filename, name):
    stem = GRID_PREFIX.sub("", PurePosixPath(filename).stem)
    rest = strip_name(stem, name or "")
    # Without a name prefix to cut, "night" in "Night Market" must not count.
    exclude = set() if rest is not None else set(words(name or ""))
    found = []
    for w in words(stem if rest is None else rest):
        if w in MODIFIERS and w not in exclude and w not in found:
            found.append(w)
    return found


def tags_for_path(rel_path, layout):
    path = PurePosixPath(rel_path)
    dirs, filename = list(path.parts[:-1]), path.name
    by_namespace = layout_tags(dirs, layout)
    if by_namespace is None:
        return None
    name = by_namespace.get("name")

    if path.suffix.lower() == ".zip":
        # The plugin finds a map's Foundry module by searching
        # [name:<map name>, type:foundry module]; a second type: tag would also
        # list the zip among the map images, so the layout's type is dropped.
        by_namespace.pop("type", None)
        return [f"{ns}:{v}" for ns, v in by_namespace.items()] + [FOUNDRY_MODULE_TAG]

    tags = [f"{ns}:{v}" for ns, v in by_namespace.items()]
    tags += grid_tags(dirs, filename)
    # Unnamespaced on purpose: the plugin ranks a module's scenes against the
    # map's plain tags and ignores namespaced ones besides name:.
    tags += variant_tags(filename, name)
    return tags


def plan(paths, layout):
    planned, skipped = {}, []
    for rel in paths:
        tags = tags_for_path(rel, layout)
        if tags:
            planned[rel] = tags
        else:
            skipped.append(rel)
    return planned, skipped


def group_by_tags(hash_to_tags):
    # add_tags takes one tag list per request, so files sharing one share a call.
    groups = {}
    for h, tags in hash_to_tags.items():
        groups.setdefault(tuple(tags), []).append(h)
    return groups


def withhold_deleted(hash_to_tags, deleted):
    # add_tags would resurrect a tag the user deleted on every run, so its
    # tombstone wins over the layout. Hashes missing from `deleted` are unknown.
    kept, withheld = {}, 0
    for h, tags in hash_to_tags.items():
        if h not in deleted:
            continue
        remaining = [t for t in tags if t not in deleted[h]]
        withheld += len(tags) - len(remaining)
        if remaining:
            kept[h] = remaining
    return kept, withheld


# --- I/O ----------------------------------------------------------------------

def walk(root):
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith("."))
        for f in sorted(filenames):
            if not f.startswith("."):
                yield os.path.relpath(os.path.join(dirpath, f), root).replace(os.sep, "/")


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class Hydrus:
    def __init__(self, url, key):
        self.url, self.key = url.rstrip("/"), key

    def call(self, path, params=None, body=None):
        url = self.url + path + ("?" + urllib.parse.urlencode(params) if params else "")
        headers = {"Hydrus-Client-API-Access-Key": self.key}
        data = None
        if body is not None:
            data = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        with urllib.request.urlopen(urllib.request.Request(url, data, headers)) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}

    def service_key(self, name):
        services = self.call("/get_services").get("services", {})
        return next((k for k, s in services.items() if s.get("name") == name), None)

    def deleted_tags(self, hashes, service_key):
        meta = self.call("/get_files/file_metadata", {"hashes": json.dumps(hashes)})
        # Unknown hashes still come back, with a null file_id. Status "2" holds
        # the tombstones of tags the user deleted on that service.
        return {
            m["hash"]: set(m.get("tags", {}).get(service_key, {}).get("storage_tags", {}).get("2", []))
            for m in meta.get("metadata", [])
            if m.get("file_id") is not None
        }

    def add_tags(self, service_key, hashes, tags):
        self.call("/add_tags/add_tags", body={
            "hashes": hashes,
            "service_keys_to_actions_to_tags": {service_key: {"0": list(tags)}},
        })


def apply(planned, args):
    client = Hydrus(args.api_url, args.api_key)
    service_key = client.service_key(args.service)
    if service_key is None:
        sys.exit(f"tag service {args.service!r} not found in Hydrus")

    hash_to_tags = {}
    for rel, tags in planned.items():
        hash_to_tags[sha256(os.path.join(args.root, rel))] = tags
    hashes = list(hash_to_tags)
    deleted = {}
    for i in range(0, len(hashes), BATCH):
        deleted.update(client.deleted_tags(hashes[i:i + BATCH], service_key))
    to_tag, withheld = withhold_deleted(hash_to_tags, deleted)

    for tags, group in group_by_tags(to_tag).items():
        for i in range(0, len(group), BATCH):
            client.add_tags(service_key, group[i:i + BATCH], tags)
    print(f"tagged {len(to_tag)} files, {len(hashes) - len(deleted)} not in Hydrus (import them first), "
          f"{withheld} tags withheld because they were deleted in Hydrus")


def parse_args(argv):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", default="./imports", help="folder to walk (default: %(default)s)")
    p.add_argument("--layout", default=DEFAULT_LAYOUT, help="path template under --root (default: %(default)s)")
    p.add_argument("--api-url", default="http://localhost:45869", help="Hydrus Client API (default: %(default)s)")
    p.add_argument("--api-key", default=os.environ.get("HYDRUS_API_KEY"), help="access key (default: $HYDRUS_API_KEY)")
    p.add_argument("--service", default="my tags", help="tag service to write to (default: %(default)s)")
    p.add_argument("--limit", type=int, help="stop after this many matching files")
    p.add_argument("--apply", action="store_true", help="write the tags; without it nothing leaves this machine")
    args = p.parse_args(argv)
    if args.apply and not args.api_key:
        p.error("--apply needs --api-key or HYDRUS_API_KEY")
    if not os.path.isdir(args.root):
        p.error(f"--root {args.root!r} is not a directory")
    return args


def main(argv=None):
    args = parse_args(argv)
    planned, skipped = plan(walk(args.root), parse_layout(args.layout))
    if args.limit is not None:
        planned = dict(list(planned.items())[:args.limit])

    for rel, tags in planned.items():
        print(f"{rel}\n    {', '.join(tags)}")
    print(f"\n{len(planned)} files to tag, {len(skipped)} skipped (path does not fit {args.layout})")

    if args.apply:
        apply(planned, args)
    else:
        print("dry-run: pass --apply to write these tags to Hydrus")


if __name__ == "__main__":
    main()
