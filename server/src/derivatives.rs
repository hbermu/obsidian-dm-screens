use crate::config::Config;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::process::Command;
use tokio::sync::OnceCell;

pub const VIDEO_MAX_LONG_SIDE: f64 = 1920.0;
pub const VIDEO_MAX_SHORT_SIDE: f64 = 1080.0;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Image,
    Video,
}

pub fn kind(ext: &str) -> Option<Kind> {
    match ext {
        "jpg" | "jpeg" | "png" | "webp" => Some(Kind::Image),
        "mp4" | "webm" => Some(Kind::Video),
        _ => None,
    }
}

// src/map/transform.ts videoTargetSize: fit inside 1920×1080 (portrait
// swapped) and the requested width, even sides, or None when already fits.
pub fn video_target_size(nw: f64, nh: f64, max_width: f64) -> Option<(u32, u32)> {
    // Also rejects NaN, which the plugin's finiteOr maps to 0.
    if nw.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
        || nh.partial_cmp(&0.0) != Some(std::cmp::Ordering::Greater)
    {
        return None;
    }
    let (box_w, box_h) = if nw >= nh {
        (VIDEO_MAX_LONG_SIDE, VIDEO_MAX_SHORT_SIDE)
    } else {
        (VIDEO_MAX_SHORT_SIDE, VIDEO_MAX_LONG_SIDE)
    };
    let scale = 1f64.min(box_w / nw).min(box_h / nh).min(max_width / nw);
    if scale >= 1.0 {
        return None;
    }
    let even = |v: f64| ((v / 2.0).floor() * 2.0).max(2.0) as u32;
    Some((even(nw * scale), even(nh * scale)))
}

type Slot = Arc<OnceCell<Option<PathBuf>>>;

// Encoded derivatives on disk, least recently used evicted past the budget;
// concurrent requests for one derivative share one encode.
pub struct DerivativeCache {
    dir: PathBuf,
    budget: u64,
    inflight: Mutex<HashMap<String, Slot>>,
    lru: Mutex<Vec<(String, u64)>>,
}

async fn probe(cfg: &Config, src: &Path) -> Option<(f64, f64)> {
    let out = Command::new(&cfg.ffprobe)
        .args([
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
        ])
        .arg(src)
        .output()
        .await
        .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let (w, h) = text.trim().lines().next()?.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

async fn encode(cfg: &Config, src: &Path, dest: &Path, kind: Kind, width: u32) -> Option<()> {
    let (nw, nh) = probe(cfg, src).await?;
    let mut cmd = Command::new(&cfg.ffmpeg);
    cmd.args(["-y", "-v", "error", "-i"]).arg(src);
    match kind {
        Kind::Image => {
            if nw <= width as f64 {
                return None;
            }
            let height = ((nh * width as f64) / nw).round().max(1.0) as u32;
            cmd.args([
                "-vf",
                &format!("scale={width}:{height}"),
                "-c:v",
                "libwebp",
                "-quality",
                "90",
                "-f",
                "webp",
            ]);
        }
        Kind::Video => {
            let (w, h) = video_target_size(nw, nh, width as f64)?;
            cmd.args([
                "-an",
                "-vf",
                &format!("scale={w}:{h}"),
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "20",
            ]);
            cmd.args([
                "-pix_fmt",
                "yuv420p",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
            ]);
        }
    }
    let status = cmd.arg(dest).status().await.ok()?;
    status.success().then_some(())
}

impl DerivativeCache {
    pub fn new(config: &Config) -> Self {
        let dir = config.data_dir.join("derivatives");
        let _ = std::fs::create_dir_all(&dir);
        let mut lru: Vec<(String, u64)> = std::fs::read_dir(&dir)
            .map(|rd| {
                rd.flatten()
                    .filter_map(|e| {
                        Some((
                            e.file_name().to_string_lossy().into_owned(),
                            e.metadata().ok()?.len(),
                        ))
                    })
                    .collect()
            })
            .unwrap_or_default();
        lru.sort();
        DerivativeCache {
            dir,
            budget: config.derivative_cache_bytes,
            inflight: Mutex::new(HashMap::new()),
            lru: Mutex::new(lru),
        }
    }

    fn used(&self, name: &str, size: u64) {
        let mut lru = self.lru.lock().unwrap_or_else(|e| e.into_inner());
        lru.retain(|(n, _)| n != name);
        lru.push((name.to_string(), size));
        let mut total: u64 = lru.iter().map(|(_, s)| s).sum();
        while total > self.budget && lru.len() > 1 {
            let (old, s) = lru.remove(0);
            let _ = std::fs::remove_file(self.dir.join(&old));
            total -= s;
        }
    }

    // None means "serve the original": it already fits, or encoding failed.
    pub async fn get(
        &self,
        cfg: &Config,
        src: &Path,
        sha: &str,
        ext: &str,
        width: u32,
    ) -> Option<(PathBuf, &'static str)> {
        let kind = kind(ext)?;
        let (suffix, mime) = match kind {
            Kind::Image => ("webp", "image/webp"),
            Kind::Video => ("mp4", "video/mp4"),
        };
        let name = format!("{sha}-{width}.{suffix}");
        let path = self.dir.join(&name);
        if let Ok(meta) = tokio::fs::metadata(&path).await {
            self.used(&name, meta.len());
            return Some((path, mime));
        }
        let slot: Slot = self
            .inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .entry(name.clone())
            .or_default()
            .clone();
        let result = slot
            .get_or_init(|| async {
                let tmp = self.dir.join(format!(".{name}.tmp"));
                let done = encode(cfg, src, &tmp, kind, width).await;
                if done.is_some() && tokio::fs::rename(&tmp, &path).await.is_ok() {
                    tracing::debug!(name, "derivative encoded");
                    Some(path.clone())
                } else {
                    let _ = tokio::fs::remove_file(&tmp).await;
                    None
                }
            })
            .await
            .clone();
        self.inflight
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&name);
        let path = result?;
        let size = tokio::fs::metadata(&path)
            .await
            .map(|m| m.len())
            .unwrap_or(0);
        self.used(&name, size);
        Some((path, mime))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mirrors_the_plugin_video_box() {
        assert_eq!(
            video_target_size(3840.0, 2160.0, 16_384.0),
            Some((1920, 1080))
        );
        assert_eq!(
            video_target_size(2160.0, 3840.0, 16_384.0),
            Some((1080, 1920))
        );
        assert_eq!(video_target_size(3840.0, 2160.0, 1024.0), Some((1024, 576)));
        assert_eq!(video_target_size(1280.0, 720.0, 4096.0), None);
        assert_eq!(video_target_size(1001.0, 3.0, 500.0), Some((500, 2)));
        assert_eq!(video_target_size(0.0, 720.0, 4096.0), None);
    }

    #[test]
    fn only_still_images_and_videos_get_derivatives() {
        assert_eq!(kind("png"), Some(Kind::Image));
        assert_eq!(kind("webm"), Some(Kind::Video));
        assert_eq!(kind("gif"), None);
    }
}
