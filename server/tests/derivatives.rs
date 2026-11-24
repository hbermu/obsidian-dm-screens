// Runs the real ffmpeg/ffprobe from the dev image (make server-test).
mod common;

use common::{CONTROL, start};
use std::path::Path;
use std::process::Command;

fn lavfi(out: &Path, source: &str, extra: &[&str]) -> Vec<u8> {
    let status = Command::new("ffmpeg")
        .args(["-y", "-v", "error", "-f", "lavfi", "-i", source])
        .args(extra)
        .arg(out)
        .status()
        .expect("ffmpeg is installed in the dev image");
    assert!(status.success());
    std::fs::read(out).unwrap()
}

fn dimensions(bytes: &[u8], dir: &Path) -> (u32, u32) {
    let file = dir.join("probe.bin");
    std::fs::write(&file, bytes).unwrap();
    let out = Command::new("ffprobe")
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
        .arg(&file)
        .output()
        .unwrap();
    let text = String::from_utf8(out.stdout).unwrap();
    let (w, h) = text.trim().split_once('x').unwrap();
    (w.parse().unwrap(), h.parse().unwrap())
}

#[tokio::test]
async fn serves_a_webp_at_the_rounded_width_and_the_original_when_it_fits() {
    let s = start(&[]).await;
    let work = tempfile::tempdir().unwrap();
    let png = lavfi(
        &work.path().join("in.png"),
        "color=c=red:s=1200x800",
        &["-frames:v", "1"],
    );
    let name = s.upload(&png, "png").await;

    let res = s
        .http
        .get(format!("{}/assets/{name}?w=500&k={CONTROL}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "image/webp");
    let webp = res.bytes().await.unwrap();
    assert_eq!(&webp[..4], b"RIFF");
    assert_eq!(dimensions(&webp, work.path()), (512, 341));

    let big = s
        .http
        .get(format!("{}/assets/{name}?w=4000&k={CONTROL}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(big.headers()["content-type"], "image/png");
    assert_eq!(big.bytes().await.unwrap().len(), png.len());
}

#[tokio::test]
async fn fits_a_video_inside_1080p_and_serves_ranges_of_it() {
    let s = start(&[]).await;
    let work = tempfile::tempdir().unwrap();
    let mp4 = lavfi(
        &work.path().join("in.mp4"),
        "testsrc=size=2560x1440:rate=10",
        &["-t", "1", "-pix_fmt", "yuv420p"],
    );
    let name = s.upload(&mp4, "mp4").await;

    let res = s
        .http
        .get(format!("{}/assets/{name}?w=4096&k={CONTROL}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "video/mp4");
    let video = res.bytes().await.unwrap();
    assert_eq!(dimensions(&video, work.path()), (1920, 1080));

    let part = s
        .http
        .get(format!("{}/assets/{name}?w=4096&k={CONTROL}", s.base))
        .header("Range", "bytes=0-99")
        .send()
        .await
        .unwrap();
    assert_eq!(part.status(), 206);
    assert_eq!(
        part.headers()["content-range"],
        format!("bytes 0-99/{}", video.len()).as_str()
    );
}

#[tokio::test]
async fn never_derives_a_gif() {
    let s = start(&[]).await;
    let work = tempfile::tempdir().unwrap();
    let gif = lavfi(
        &work.path().join("in.gif"),
        "color=c=blue:s=900x900",
        &["-frames:v", "1"],
    );
    let name = s.upload(&gif, "gif").await;
    let res = s
        .http
        .get(format!("{}/assets/{name}?w=256&k={CONTROL}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(res.headers()["content-type"], "image/gif");
}
