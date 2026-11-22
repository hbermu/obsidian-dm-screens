use crate::protocol::{Channel, message_channel};
use indexmap::IndexMap;

pub const MAX_REPLAY_CACHE_UNITS: usize = 2 * 1024 * 1024;

// The embedded server's ReplayCache (src/server.ts): one serialised message
// per type, first-insertion order kept across overwrites, channel-scoped
// purges, and a size budget measured in UTF-16 code units like JS `length`.
#[derive(Debug, Default, Clone)]
pub struct ReplayCache {
    entries: IndexMap<String, String>,
}

fn units(s: &str) -> usize {
    s.encode_utf16().count()
}

impl ReplayCache {
    pub fn from_entries(entries: IndexMap<String, String>) -> Self {
        ReplayCache { entries }
    }

    pub fn entries(&self) -> &IndexMap<String, String> {
        &self.entries
    }

    pub fn get(&self, kind: &str) -> Option<&String> {
        self.entries.get(kind)
    }

    pub fn record(&mut self, kind: &str, data: String) {
        let channel = message_channel(kind);
        match kind {
            "clear" => self.entries.retain(|k, _| message_channel(k) != channel),
            "map-clear" => self
                .entries
                .retain(|k, _| message_channel(k) != channel || k == "map-calibration"),
            "hide-background-media" => {
                self.entries.shift_remove("show-background-media");
            }
            _ => {
                self.entries.insert(kind.to_string(), data);
                self.trim();
            }
        }
    }

    pub fn of_channel(&self, channel: Channel) -> impl Iterator<Item = &String> {
        self.entries
            .iter()
            .filter(move |(k, _)| message_channel(k) == channel)
            .map(|(_, v)| v)
    }

    fn trim(&mut self) {
        let mut total: usize = self.entries.values().map(|v| units(v)).sum();
        while total > MAX_REPLAY_CACHE_UNITS && self.entries.len() > 1 {
            let (key, len) = self
                .entries
                .iter()
                .map(|(k, v)| (k.clone(), units(v)))
                .fold((String::new(), 0usize), |best, cur| {
                    if cur.1 > best.1 { cur } else { best }
                });
            self.entries.shift_remove(&key);
            total -= len;
            tracing::warn!(evicted = %key, units = len, "replay cache over budget");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(c: &ReplayCache) -> Vec<&str> {
        c.entries().keys().map(String::as_str).collect()
    }

    #[test]
    fn overwrites_in_place_keeping_first_insertion_order() {
        let mut c = ReplayCache::default();
        c.record("image-layers-sync", "1".into());
        c.record("image-layers-geometry", "2".into());
        c.record("image-layers-sync", "3".into());
        assert_eq!(keys(&c), ["image-layers-sync", "image-layers-geometry"]);
        assert_eq!(c.get("image-layers-sync").unwrap(), "3");
    }

    #[test]
    fn purges_by_channel() {
        let mut c = ReplayCache::default();
        for k in [
            "combat-scale",
            "map-calibration",
            "map-view",
            "show-background-media",
        ] {
            c.record(k, "x".into());
        }
        c.record("hide-background-media", String::new());
        assert_eq!(keys(&c), ["combat-scale", "map-calibration", "map-view"]);
        c.record("map-clear", String::new());
        assert_eq!(keys(&c), ["combat-scale", "map-calibration"]);
        c.record("clear", String::new());
        assert_eq!(keys(&c), ["map-calibration"]);
    }

    #[test]
    fn evicts_the_largest_entry_but_never_the_last() {
        let mut c = ReplayCache::default();
        c.record("a", "x".repeat(900_000));
        c.record("b", "x".repeat(1_000_000));
        c.record("c", "x".repeat(800_000));
        assert_eq!(keys(&c), ["a", "c"]);
        let mut solo = ReplayCache::default();
        solo.record("a", "x".repeat(3_000_000));
        assert_eq!(keys(&solo), ["a"]);
    }

    #[test]
    fn measures_the_budget_in_utf16_units() {
        assert_eq!(units("é😀"), 3);
    }
}
