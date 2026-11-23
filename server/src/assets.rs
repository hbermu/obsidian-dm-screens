use crate::allowlist::ASSET_EXTENSIONS;
use crate::auth::{Role, api_token, role_for};
use crate::persist::{load, now_secs, state_dir};
use crate::state::AppState;
use crate::viewers::unauthorized;
use axum::Json;
use axum::body::{Body, Bytes};
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read;
use std::path::{Path as FsPath, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

pub const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
pub const MAX_UPLOADS: usize = 4;
pub const UPLOAD_IDLE_SECS: u64 = 3600;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AssetMeta {
    pub ext: String,
    pub size: u64,
    pub last_used: u64,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct AssetIndex {
    #[serde(default)]
    pub assets: HashMap<String, AssetMeta>,
    // "<size>:<mtime>:<vault path>" → sha256, recorded by uploads that sent one.
    #[serde(default)]
    pub fingerprints: HashMap<String, String>,
}

struct Upload {
    path: PathBuf,
    size: u64,
    ext: String,
    fingerprint: Option<String>,
    received: u64,
    last: u64,
}

pub struct AssetStore {
    data_dir: PathBuf,
    index: Mutex<AssetIndex>,
    uploads: Mutex<HashMap<String, Upload>>,
}

pub fn content_type(ext: &str) -> &'static str {
    match ext {
        "webm" => "video/webm",
        "mp4" => "video/mp4",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        _ => "application/octet-stream",
    }
}

pub fn ext_for_content_type(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim() {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/webp" => Some("webp"),
        "image/gif" => Some("gif"),
        "video/mp4" => Some("mp4"),
        "video/webm" => Some("webm"),
        _ => None,
    }
}

fn is_sha256(s: &str) -> bool {
    s.len() == 64
        && s.bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn fingerprint_key(path: &str, size: u64, mtime: u64) -> String {
    format!("{size}:{mtime}:{path}")
}

fn random_id() -> String {
    let mut bytes = [0u8; 16];
    if std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut bytes))
        .is_err()
    {
        bytes = Sha256::digest(format!(
            "{:?}{}",
            std::time::SystemTime::now(),
            std::process::id()
        ))[..16]
            .try_into()
            .unwrap_or([0; 16]);
    }
    hex::encode(bytes)
}

pub fn sha256_file(path: &FsPath) -> std::io::Result<String> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

// Every /assets/<sha256>.<ext> mentioned in a relay or a map-data write.
pub fn referenced_hashes(text: &str) -> HashSet<String> {
    text.match_indices("/assets/")
        .filter_map(|(i, _)| text.get(i + 8..i + 72))
        .filter(|h| is_sha256(h))
        .map(str::to_string)
        .collect()
}

impl AssetStore {
    pub fn open(data_dir: &FsPath) -> std::io::Result<AssetStore> {
        std::fs::create_dir_all(data_dir.join("assets"))?;
        std::fs::create_dir_all(data_dir.join("uploads"))?;
        // Leftover partial uploads cannot be resumed after a restart.
        for entry in std::fs::read_dir(data_dir.join("uploads"))?.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
        let index: AssetIndex = load(&state_dir(data_dir).join("assets.json"));
        Ok(AssetStore {
            data_dir: data_dir.to_path_buf(),
            index: Mutex::new(index),
            uploads: Mutex::new(HashMap::new()),
        })
    }

    fn index(&self) -> std::sync::MutexGuard<'_, AssetIndex> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn uploads(&self) -> std::sync::MutexGuard<'_, HashMap<String, Upload>> {
        self.uploads.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn asset_path(&self, sha: &str) -> PathBuf {
        self.data_dir.join("assets").join(&sha[..2]).join(sha)
    }

    pub fn temp_path(&self, name: &str) -> PathBuf {
        self.data_dir.join("uploads").join(name)
    }

    pub fn meta(&self, sha: &str) -> Option<AssetMeta> {
        self.index().assets.get(sha).cloned()
    }

    pub fn touch(&self, sha: &str) {
        if let Some(m) = self.index().assets.get_mut(sha) {
            m.last_used = now_secs();
        }
    }

    pub fn touch_referenced(&self, text: &str) {
        let hashes = referenced_hashes(text);
        if hashes.is_empty() {
            return;
        }
        let now = now_secs();
        let mut idx = self.index();
        for h in hashes {
            if let Some(m) = idx.assets.get_mut(&h) {
                m.last_used = now;
            }
        }
    }

    pub fn index_snapshot(&self) -> AssetIndex {
        self.index().clone()
    }

    pub fn lookup(&self, key: &str) -> Option<(String, AssetMeta)> {
        let idx = self.index();
        let sha = idx.fingerprints.get(key)?;
        idx.assets.get(sha).map(|m| (sha.clone(), m.clone()))
    }

    // Moves a fully written temporary file into the store under its hash, or
    // discards it when that content is already stored.
    pub async fn ingest(
        &self,
        tmp: PathBuf,
        ext: &str,
        fingerprint: Option<String>,
    ) -> std::io::Result<String> {
        let path = tmp.clone();
        let sha = tokio::task::spawn_blocking(move || sha256_file(&path))
            .await
            .map_err(std::io::Error::other)??;
        let size = tokio::fs::metadata(&tmp).await?.len();
        let dest = self.asset_path(&sha);
        if self.meta(&sha).is_some() && tokio::fs::try_exists(&dest).await.unwrap_or(false) {
            let _ = tokio::fs::remove_file(&tmp).await;
        } else {
            tokio::fs::create_dir_all(dest.parent().expect("asset paths have a parent")).await?;
            tokio::fs::rename(&tmp, &dest).await?;
        }
        let mut idx = self.index();
        idx.assets.insert(
            sha.clone(),
            AssetMeta {
                ext: ext.to_string(),
                size,
                last_used: now_secs(),
            },
        );
        if let Some(key) = fingerprint {
            idx.fingerprints.insert(key, sha.clone());
        }
        Ok(sha)
    }

    // Deletes assets unused for the retention period that nothing references.
    pub fn gc(&self, referenced: &HashSet<String>, retention_days: u64) -> usize {
        let cutoff = now_secs().saturating_sub(retention_days * 86_400);
        let mut idx = self.index();
        let doomed: Vec<String> = idx
            .assets
            .iter()
            .filter(|(sha, m)| m.last_used < cutoff && !referenced.contains(*sha))
            .map(|(sha, _)| sha.clone())
            .collect();
        for sha in &doomed {
            let _ = std::fs::remove_file(self.asset_path(sha));
            idx.assets.remove(sha);
        }
        let live: HashSet<String> = idx.assets.keys().cloned().collect();
        idx.fingerprints.retain(|_, sha| live.contains(sha));
        doomed.len()
    }

    pub fn sweep_uploads(&self) {
        let cutoff = now_secs().saturating_sub(UPLOAD_IDLE_SECS);
        self.uploads().retain(|id, u| {
            let keep = u.last >= cutoff;
            if !keep {
                tracing::info!(id, "discarding idle upload");
                let _ = std::fs::remove_file(&u.path);
            }
            keep
        });
    }
}

fn api_json<T: Serialize>(status: StatusCode, body: T) -> Response {
    (status, Json(body)).into_response()
}

pub async fn get_meta(State(state): State<Arc<AppState>>, Path(sha): Path<String>) -> Response {
    match state.assets.meta(&sha) {
        Some(m) => {
            state.assets.touch(&sha);
            api_json(
                StatusCode::OK,
                json!({ "sha256": sha, "ext": m.ext, "size": m.size }),
            )
        }
        None => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
pub struct Fingerprint {
    path: String,
    size: u64,
    mtime: u64,
}

pub async fn lookup(State(state): State<Arc<AppState>>, Json(fp): Json<Fingerprint>) -> Response {
    let key = fingerprint_key(&fp.path, fp.size, fp.mtime);
    match state.assets.lookup(&key) {
        Some((sha, m)) if state.assets.asset_path(&sha).exists() => {
            state.assets.touch(&sha);
            api_json(StatusCode::OK, json!({ "sha256": sha, "ext": m.ext }))
        }
        _ => StatusCode::NOT_FOUND.into_response(),
    }
}

#[derive(Deserialize)]
pub struct NewUpload {
    size: u64,
    ext: String,
    fingerprint: Option<Fingerprint>,
}

pub async fn create_upload(
    State(state): State<Arc<AppState>>,
    Json(req): Json<NewUpload>,
) -> Response {
    let ext = req.ext.to_ascii_lowercase();
    if !ASSET_EXTENSIONS.contains(&ext.as_str()) {
        return StatusCode::UNSUPPORTED_MEDIA_TYPE.into_response();
    }
    if req.size > state.config.max_asset_bytes {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let id = random_id();
    let path = state.assets.temp_path(&id);
    {
        let mut uploads = state.assets.uploads();
        if uploads.len() >= MAX_UPLOADS {
            return StatusCode::TOO_MANY_REQUESTS.into_response();
        }
        if std::fs::File::create(&path).is_err() {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
        let fingerprint = req
            .fingerprint
            .map(|f| fingerprint_key(&f.path, f.size, f.mtime));
        uploads.insert(
            id.clone(),
            Upload {
                path,
                size: req.size,
                ext,
                fingerprint,
                received: 0,
                last: now_secs(),
            },
        );
    }
    tracing::info!(id, size = req.size, "upload started");
    api_json(
        StatusCode::CREATED,
        json!({ "id": id, "chunkSize": CHUNK_SIZE }),
    )
}

#[derive(Deserialize)]
pub struct Offset {
    offset: u64,
}

pub async fn put_chunk(
    State(state): State<Arc<AppState>>,
    Path(id): Path<String>,
    Query(q): Query<Offset>,
    body: Bytes,
) -> Response {
    let (path, received, size) = {
        let uploads = state.assets.uploads();
        let Some(u) = uploads.get(&id) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        (u.path.clone(), u.received, u.size)
    };
    if q.offset != received {
        return api_json(StatusCode::CONFLICT, json!({ "received": received }));
    }
    if body.len() as u64 > CHUNK_SIZE || received + body.len() as u64 > size {
        return StatusCode::PAYLOAD_TOO_LARGE.into_response();
    }
    let write = async {
        use tokio::io::AsyncWriteExt;
        let mut f = tokio::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .await?;
        f.write_all(&body).await?;
        f.flush().await
    };
    if write.await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let mut uploads = state.assets.uploads();
    let Some(u) = uploads.get_mut(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    u.received += body.len() as u64;
    u.last = now_secs();
    api_json(StatusCode::OK, json!({ "received": u.received }))
}

pub async fn complete(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    let Some(u) = state.assets.uploads().remove(&id) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if u.received != u.size {
        let _ = tokio::fs::remove_file(&u.path).await;
        return StatusCode::UNPROCESSABLE_ENTITY.into_response();
    }
    match state.assets.ingest(u.path, &u.ext, u.fingerprint).await {
        Ok(sha) => {
            state.mark_dirty();
            tracing::info!(id, sha = &sha[..12], "upload stored");
            api_json(StatusCode::OK, json!({ "sha256": sha, "ext": u.ext }))
        }
        Err(e) => {
            tracing::error!(id, error = %e, "upload ingest failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

#[derive(Deserialize, Default)]
pub struct ServeQuery {
    w: Option<String>,
}

pub fn derivative_width(raw: Option<&str>) -> Option<u32> {
    let w: u64 = raw?.parse().ok()?;
    if w == 0 {
        return None;
    }
    Some((w.div_ceil(256) * 256).min(16_384) as u32)
}

fn parse_range(header: &str, size: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    if spec.contains(',') || size == 0 {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (size.saturating_sub(n), size - 1)
        }
        (s, "") => (s.parse().ok()?, size - 1),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(size - 1)),
    };
    (start <= end && start < size).then_some((start, end))
}

pub async fn serve_file(path: &FsPath, mime: &str, range: Option<&str>) -> Response {
    let Ok(mut file) = tokio::fs::File::open(path).await else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let size = file.metadata().await.map(|m| m.len()).unwrap_or(0);
    let common = |res: &mut Response| {
        let h = res.headers_mut();
        h.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_str(mime)
                .unwrap_or(HeaderValue::from_static("application/octet-stream")),
        );
        h.insert(
            header::CACHE_CONTROL,
            HeaderValue::from_static("public, max-age=3600"),
        );
        h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
        // The controller draws assets into canvases (layer fog editing), which
        // needs CORS; the token in the URL is still what grants access.
        h.insert(
            header::ACCESS_CONTROL_ALLOW_ORIGIN,
            HeaderValue::from_static("*"),
        );
    };
    let (status, start, len) = match range {
        None => (StatusCode::OK, 0, size),
        Some(r) => match parse_range(r, size) {
            Some((s, e)) => (StatusCode::PARTIAL_CONTENT, s, e - s + 1),
            None => {
                let mut res = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
                common(&mut res);
                res.headers_mut().insert(
                    header::CONTENT_RANGE,
                    HeaderValue::from_str(&format!("bytes */{size}")).unwrap(),
                );
                return res;
            }
        },
    };
    if start > 0 && file.seek(std::io::SeekFrom::Start(start)).await.is_err() {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    let stream = tokio_util::io::ReaderStream::new(file.take(len));
    let mut res = Response::new(Body::from_stream(stream));
    *res.status_mut() = status;
    common(&mut res);
    res.headers_mut()
        .insert(header::CONTENT_LENGTH, HeaderValue::from(len));
    if status == StatusCode::PARTIAL_CONTENT {
        res.headers_mut().insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {}-{}/{}", start, start + len - 1, size))
                .unwrap(),
        );
    }
    res
}

pub async fn serve(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    Path(name): Path<String>,
    Query(q): Query<ServeQuery>,
    headers: HeaderMap,
) -> Response {
    let Some(role) = role_for(
        &api_token(uri.query(), &headers),
        &state.config.view_token,
        &state.config.control_token,
    ) else {
        return unauthorized();
    };
    let Some((sha, ext)) = name
        .split_once('.')
        .filter(|(sha, ext)| is_sha256(sha) && ASSET_EXTENSIONS.contains(ext))
    else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if role == Role::View && !state.session().allowlist.is_allowed(&name) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let Some(meta) = state.assets.meta(sha).filter(|m| m.ext == ext) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    state.assets.touch(sha);
    let original = state.assets.asset_path(sha);
    let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
    if let Some(width) = derivative_width(q.w.as_deref())
        && let Some((path, mime)) = state
            .derivatives
            .get(&state.config, &original, sha, &meta.ext, width)
            .await
    {
        return serve_file(&path, mime, range).await;
    }
    serve_file(&original, content_type(&meta.ext), range).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rounds_derivative_widths_like_the_embedded_server() {
        assert_eq!(derivative_width(Some("1")), Some(256));
        assert_eq!(derivative_width(Some("1000")), Some(1024));
        assert_eq!(derivative_width(Some("999999")), Some(16_384));
        assert_eq!(derivative_width(Some("0")), None);
        assert_eq!(derivative_width(Some("-5")), None);
        assert_eq!(derivative_width(Some("1.5")), None);
        assert_eq!(derivative_width(None), None);
    }

    #[test]
    fn parses_single_byte_ranges() {
        assert_eq!(parse_range("bytes=2-5", 10), Some((2, 5)));
        assert_eq!(parse_range("bytes=7-", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=-3", 10), Some((7, 9)));
        assert_eq!(parse_range("bytes=5-100", 10), Some((5, 9)));
        assert_eq!(parse_range("bytes=10-12", 10), None);
        assert_eq!(parse_range("bytes=0-1,4-5", 10), None);
        assert_eq!(parse_range("items=0-1", 10), None);
    }

    #[test]
    fn finds_referenced_hashes_in_any_text() {
        let a = "a".repeat(64);
        let text = format!(r#"{{"url":"/assets/{a}.png","x":"/assets/short.png"}}"#);
        assert_eq!(referenced_hashes(&text), HashSet::from([a]));
    }

    #[tokio::test]
    async fn ingests_by_hash_records_fingerprints_and_collects_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let store = AssetStore::open(dir.path()).unwrap();
        let tmp = store.temp_path("t1");
        std::fs::write(&tmp, b"hello").unwrap();
        let sha = store
            .ingest(tmp, "png", Some(fingerprint_key("a.png", 5, 9)))
            .await
            .unwrap();
        assert_eq!(sha, hex::encode(Sha256::digest(b"hello")));
        assert!(store.asset_path(&sha).exists());
        assert_eq!(
            store.lookup(&fingerprint_key("a.png", 5, 9)).unwrap().0,
            sha
        );

        let again = store.temp_path("t2");
        std::fs::write(&again, b"hello").unwrap();
        assert_eq!(store.ingest(again.clone(), "png", None).await.unwrap(), sha);
        assert!(!again.exists());

        store.index().assets.get_mut(&sha).unwrap().last_used = 0;
        assert_eq!(store.gc(&HashSet::from([sha.clone()]), 1), 0);
        assert_eq!(store.gc(&HashSet::new(), 1), 1);
        assert!(!store.asset_path(&sha).exists());
        assert!(store.lookup(&fingerprint_key("a.png", 5, 9)).is_none());
    }
}
