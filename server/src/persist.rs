use crate::assets::AssetIndex;
use crate::mapdata::MapData;
use crate::prefs::Prefs;
use crate::state::AppState;
use indexmap::IndexMap;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

pub struct Snapshot {
    pub replay: IndexMap<String, String>,
    pub mapdata: MapData,
    pub prefs: Prefs,
    pub assets: AssetIndex,
}

pub fn state_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("state")
}

pub fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// A file that fails to parse is moved aside rather than overwritten, so a bad
// write never silently erases a session.
pub fn load<T: DeserializeOwned + Default>(path: &Path) -> T {
    let Ok(bytes) = std::fs::read(path) else {
        return T::default();
    };
    match serde_json::from_slice(&bytes) {
        Ok(v) => v,
        Err(e) => {
            let aside = path.with_extension(format!("json.corrupt-{}", now_secs()));
            tracing::warn!(file = %path.display(), error = %e, "state file unreadable; moved aside");
            let _ = std::fs::rename(path, aside);
            T::default()
        }
    }
}

pub fn write_atomic<T: Serialize>(path: &Path, value: &T) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec(value)?)?;
    std::fs::rename(tmp, path)
}

pub fn flush(state: &AppState) {
    let snap = state.snapshot();
    let dir = state_dir(&state.config.data_dir);
    for (name, result) in [
        (
            "replay.json",
            write_atomic(&dir.join("replay.json"), &snap.replay),
        ),
        (
            "mapdata.json",
            write_atomic(&dir.join("mapdata.json"), &snap.mapdata),
        ),
        (
            "prefs.json",
            write_atomic(&dir.join("prefs.json"), &snap.prefs),
        ),
        (
            "assets.json",
            write_atomic(&dir.join("assets.json"), &snap.assets),
        ),
    ] {
        if let Err(e) = result {
            tracing::error!(file = name, error = %e, "state write failed");
        }
    }
}

// Coalesces changes: at most one write per second, whatever the relay rate.
pub async fn writer(state: Arc<AppState>) {
    loop {
        state.dirty.notified().await;
        tokio::time::sleep(Duration::from_secs(1)).await;
        let s = state.clone();
        let _ = tokio::task::spawn_blocking(move || flush(&s)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moves_a_corrupt_file_aside_and_starts_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("replay.json");
        std::fs::write(&path, b"{not json").unwrap();
        let loaded: IndexMap<String, String> = load(&path);
        assert!(loaded.is_empty());
        assert!(!path.exists());
        let moved = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .any(|e| e.file_name().to_string_lossy().contains("corrupt-"));
        assert!(moved);
    }

    #[test]
    fn round_trips_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("x.json");
        let mut m = IndexMap::new();
        m.insert("b".to_string(), "1".to_string());
        m.insert("a".to_string(), "2".to_string());
        write_atomic(&path, &m).unwrap();
        let back: IndexMap<String, String> = load(&path);
        assert_eq!(back.keys().collect::<Vec<_>>(), ["b", "a"]);
        assert!(!dir.path().join("x.json.tmp").exists());
    }
}
