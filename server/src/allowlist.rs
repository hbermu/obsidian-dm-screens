use serde_json::Value;
use std::collections::HashSet;

pub const ASSET_EXTENSIONS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "mp4", "webm"];

// Lowercase only: every hash the server mints comes from hex::encode, and a
// case-insensitive check would let two names address one asset.
pub fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

// `/assets/<sha256>.<ext>` → `<sha256>.<ext>`; anything else is not an asset.
pub fn asset_name(url: &Value) -> Option<String> {
    let name = url.as_str()?.strip_prefix("/assets/")?;
    let (hash, ext) = name.split_once('.')?;
    (is_sha256(hash) && ASSET_EXTENSIONS.contains(&ext)).then(|| name.to_string())
}

// The embedded VaultServeAllowlist over /assets/ names, plus the map fog mask,
// which in remote mode is an asset too.
#[derive(Debug, Default)]
pub struct Allowlist {
    background: Option<String>,
    map: Option<String>,
    fog: Option<String>,
    layers: HashSet<String>,
}

impl Allowlist {
    pub fn observe(&mut self, kind: &str, payload: &Value) {
        let field = |name: &str| asset_name(payload.get(name).unwrap_or(&Value::Null));
        match kind {
            "show-background-media" => self.background = field("url"),
            "hide-background-media" => self.background = None,
            "map-show" => self.map = field("url"),
            "map-fog" => self.fog = field("dataUrl"),
            "map-clear" => {
                self.map = None;
                self.fog = None;
            }
            "image-layers-sync" => {
                self.layers = payload
                    .get("layers")
                    .and_then(Value::as_array)
                    .map(|layers| {
                        layers
                            .iter()
                            .flat_map(|l| [l.get("dataUrl"), l.get("fogDataUrl")])
                            .flatten()
                            .filter_map(asset_name)
                            .collect()
                    })
                    .unwrap_or_default();
            }
            "clear" => {
                self.background = None;
                self.layers.clear();
            }
            _ => {}
        }
    }

    pub fn is_allowed(&self, name: &str) -> bool {
        [&self.background, &self.map, &self.fog]
            .iter()
            .any(|slot| slot.as_deref() == Some(name))
            || self.layers.contains(name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn a(n: u8) -> String {
        format!("/assets/{}.png", hex::encode([n; 32]))
    }

    #[test]
    fn accepts_only_a_lowercase_sha256() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"A".repeat(64)));
        assert!(!is_sha256(&"a".repeat(63)));
        assert!(!is_sha256("g".repeat(64).as_str()));
    }

    #[test]
    fn recognises_only_well_formed_asset_urls() {
        assert!(asset_name(&json!(a(1))).is_some());
        assert!(asset_name(&json!("/assets/abc.png")).is_none());
        assert!(asset_name(&json!(format!("/assets/{}.svg", hex::encode([1; 32])))).is_none());
        assert!(asset_name(&json!("/vault/x.png")).is_none());
        assert!(asset_name(&json!(7)).is_none());
    }

    #[test]
    fn tracks_each_slot_independently() {
        let mut al = Allowlist::default();
        let name = |u: String| u.trim_start_matches("/assets/").to_string();
        al.observe("show-background-media", &json!({ "url": a(1) }));
        al.observe("map-show", &json!({ "url": a(2) }));
        al.observe("map-fog", &json!({ "dataUrl": a(3) }));
        al.observe("image-layers-sync", &json!({ "layers": [{ "dataUrl": a(4), "fogDataUrl": a(5) }, { "dataUrl": "data:image/png;base64,AA==" }] }));
        for n in 1..=5 {
            assert!(al.is_allowed(&name(a(n))), "{n}");
        }
        al.observe("clear", &json!({}));
        assert!(!al.is_allowed(&name(a(1))) && !al.is_allowed(&name(a(4))));
        assert!(al.is_allowed(&name(a(2))) && al.is_allowed(&name(a(3))));
        al.observe("map-clear", &json!({}));
        assert!(!al.is_allowed(&name(a(2))) && !al.is_allowed(&name(a(3))));
    }

    #[test]
    fn a_non_asset_background_clears_the_slot() {
        let mut al = Allowlist::default();
        al.observe("show-background-media", &json!({ "url": a(1) }));
        al.observe(
            "show-background-media",
            &json!({ "url": "data:image/png;base64,AA==" }),
        );
        assert!(!al.is_allowed(a(1).trim_start_matches("/assets/")));
    }
}
