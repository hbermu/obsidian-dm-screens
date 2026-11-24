use crate::allowlist::is_sha256;
use crate::assets::ext_for_content_type;
use crate::integrations::{http, not_configured, upstream_failed};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
pub struct HydrusRequest {
    hash: String,
}

const KEY_HEADER: &str = "Hydrus-Client-API-Access-Key";

enum Failure {
    Upstream(String),
    Mismatch,
    Unsupported,
    TooLarge,
}

// Streams the file to disk while hashing it; the Hydrus hash is the file's
// SHA-256, so a mismatch means the bytes are not the file that was asked for.
async fn download(
    state: &AppState,
    hash: &str,
) -> Result<(std::path::PathBuf, &'static str), Failure> {
    let res = get(state, &format!("/get_files/file?hash={hash}"), None)
        .await
        .map_err(|e| match e {
            GetError::NotConfigured => Failure::Upstream("not configured".into()),
            GetError::Failed(reason) => Failure::Upstream(reason),
        })?;
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let ext = ext_for_content_type(mime).ok_or(Failure::Unsupported)?;
    let tmp = state.assets.temp_path(&format!("hydrus-{hash}"));
    let mut file = tokio::fs::File::create(&tmp)
        .await
        .map_err(|e| Failure::Upstream(e.to_string()))?;
    let mut hasher = Sha256::new();
    let mut size: u64 = 0;
    let mut body = res.bytes_stream();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| Failure::Upstream(e.without_url().to_string()))?;
        size += chunk.len() as u64;
        if size > state.config.max_asset_bytes {
            drop(file);
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(Failure::TooLarge);
        }
        hasher.update(&chunk);
        file.write_all(&chunk)
            .await
            .map_err(|e| Failure::Upstream(e.to_string()))?;
    }
    file.flush()
        .await
        .map_err(|e| Failure::Upstream(e.to_string()))?;
    if hex::encode(hasher.finalize()) != hash {
        let _ = tokio::fs::remove_file(&tmp).await;
        return Err(Failure::Mismatch);
    }
    Ok((tmp, ext))
}

pub async fn fetch(State(state): State<Arc<AppState>>, Json(req): Json<HydrusRequest>) -> Response {
    if state.config.hydrus.is_none() {
        return StatusCode::NOT_IMPLEMENTED.into_response();
    }
    let hash = req.hash.to_ascii_lowercase();
    if !is_sha256(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if let Some(meta) = state
        .assets
        .meta(&hash)
        .filter(|_| state.assets.asset_path(&hash).exists())
    {
        state.assets.touch(&hash);
        return (
            StatusCode::OK,
            Json(json!({ "sha256": hash, "ext": meta.ext })),
        )
            .into_response();
    }
    match download(&state, &hash).await {
        Ok((tmp, ext)) => match state.assets.ingest(tmp, ext, None).await {
            Ok(sha) => {
                state.mark_dirty();
                tracing::info!(sha = &sha[..12], "Hydrus file stored");
                (StatusCode::OK, Json(json!({ "sha256": sha, "ext": ext }))).into_response()
            }
            Err(e) => {
                tracing::error!(error = %e, "Hydrus ingest failed");
                StatusCode::INTERNAL_SERVER_ERROR.into_response()
            }
        },
        Err(f) => {
            let (status, reason) = match f {
                Failure::TooLarge => (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "over the asset limit".to_string(),
                ),
                Failure::Upstream(e) => (StatusCode::BAD_GATEWAY, e),
                Failure::Mismatch => (StatusCode::BAD_GATEWAY, "hash mismatch".into()),
                Failure::Unsupported => {
                    (StatusCode::BAD_GATEWAY, "unsupported content type".into())
                }
            };
            tracing::warn!(hash = &hash[..12], reason, "Hydrus fetch failed");
            status.into_response()
        }
    }
}

// ── Read-only proxy operations ───────────────────────────────────────────

const MAX_SEARCH_TAGS: usize = 64;
const MAX_TAG_LEN: usize = 256;
const MAX_METADATA_HASHES: usize = 1024;
// Hydrus takes the hash list in the query string, and a full page of them is
// tens of kilobytes — past what an HTTP server accepts in a request line. The
// batches are joined back into one answer.
const METADATA_BATCH: usize = 64;
const THUMBNAIL_CACHE_ENTRIES: usize = 256;

struct Upstream {
    url: String,
    key: String,
}

fn upstream(state: &AppState) -> Option<Upstream> {
    state.config.hydrus.as_ref().map(|h| Upstream {
        url: h.url.clone(),
        key: h.key.clone(),
    })
}

// Every route here is the same authenticated GET against the configured
// Hydrus, and the credential is attached in this one place; what each route
// does with a successful answer is the only part that differs. A failure is
// already the response to send: the upstream's own body never travels back,
// because it echoes the request, and the request carried the key.
enum GetError {
    NotConfigured,
    Failed(String),
}

async fn get(
    state: &AppState,
    path: &str,
    range: Option<&str>,
) -> Result<reqwest::Response, GetError> {
    let Some(up) = upstream(state) else {
        return Err(GetError::NotConfigured);
    };
    let mut req = http()
        .get(format!("{}{path}", up.url))
        .header(KEY_HEADER, &up.key);
    if let Some(range) = range {
        req = req.header(reqwest::header::RANGE, range);
    }
    let res = req
        .send()
        .await
        .map_err(|e| GetError::Failed(e.without_url().to_string()))?;
    if !res.status().is_success() {
        return Err(GetError::Failed(format!(
            "status {}",
            res.status().as_u16()
        )));
    }
    Ok(res)
}

// A route reports an absent integration as not-implemented and anything else
// as a bad gateway, naming the operation and never the upstream's own body.
fn report(op: &'static str, e: GetError) -> Response {
    match e {
        GetError::NotConfigured => not_configured(op),
        GetError::Failed(reason) => upstream_failed(op, reason),
    }
}

// Passes the upstream's JSON through: these routes carry no credential in
// their answer, and the plugin already knows how to read Hydrus's shapes.
async fn get_json(state: &AppState, op: &'static str, path: &str) -> Response {
    let res = match get(state, path, None).await {
        Ok(r) => r,
        Err(e) => return report(op, e),
    };
    match res.bytes().await {
        Ok(body) => ([(header::CONTENT_TYPE, "application/json")], body).into_response(),
        Err(e) => upstream_failed(op, e.without_url()),
    }
}

pub async fn verify(State(state): State<Arc<AppState>>) -> Response {
    get_json(&state, "hydrus verify", "/verify_access_key").await
}

pub async fn services(State(state): State<Arc<AppState>>) -> Response {
    get_json(&state, "hydrus services", "/get_services").await
}

#[derive(Deserialize)]
pub struct SearchRequest {
    tags: Vec<String>,
    limit: Option<u32>,
}

pub async fn search(
    State(state): State<Arc<AppState>>,
    Json(req): Json<SearchRequest>,
) -> Response {
    if req.tags.len() > MAX_SEARCH_TAGS || req.tags.iter().any(|t| t.len() > MAX_TAG_LEN) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut tags = req.tags;
    if let Some(limit) = req.limit.filter(|l| *l > 0) {
        tags.push(format!("system:limit={limit}"));
    }
    let qs = serde_urlencoded::to_string([
        (
            "tags",
            serde_json::to_string(&tags).unwrap_or_else(|_| "[]".into()),
        ),
        ("return_hashes", "true".into()),
        ("return_file_ids", "false".into()),
    ])
    .unwrap_or_default();
    get_json(
        &state,
        "hydrus search",
        &format!("/get_files/search_files?{qs}"),
    )
    .await
}

#[derive(Deserialize)]
pub struct MetadataRequest {
    hashes: Vec<String>,
}

pub async fn metadata(
    State(state): State<Arc<AppState>>,
    Json(req): Json<MetadataRequest>,
) -> Response {
    if req.hashes.len() > MAX_METADATA_HASHES || !req.hashes.iter().all(|h| is_sha256(h)) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut rows: Vec<Value> = Vec::with_capacity(req.hashes.len());
    for batch in req.hashes.chunks(METADATA_BATCH) {
        let qs = serde_urlencoded::to_string([
            (
                "hashes",
                serde_json::to_string(batch).unwrap_or_else(|_| "[]".into()),
            ),
            ("include_mimes", "true".into()),
            ("include_sizes", "true".into()),
            ("include_known_urls", "false".into()),
            ("include_notes", "false".into()),
        ])
        .unwrap_or_default();
        let body = match fetch_json(
            &state,
            "hydrus metadata",
            &format!("/get_files/file_metadata?{qs}"),
        )
        .await
        {
            Ok(body) => body,
            Err(res) => return *res,
        };
        match body.get("metadata").and_then(Value::as_array) {
            Some(list) => rows.extend(list.iter().cloned()),
            None => return upstream_failed("hydrus metadata", "no metadata array"),
        }
    }
    axum::Json(json!({ "metadata": rows })).into_response()
}

// The same call, parsed, for an operation that joins several answers.
async fn fetch_json(
    state: &AppState,
    op: &'static str,
    path: &str,
) -> Result<Value, Box<Response>> {
    get(state, path, None)
        .await
        .map_err(|e| Box::new(report(op, e)))?
        .json()
        .await
        .map_err(|e| Box::new(upstream_failed(op, e.without_url())))
}

#[derive(Deserialize)]
pub struct TagQuery {
    search: String,
    service: Option<String>,
}

pub async fn tags(State(state): State<Arc<AppState>>, Query(q): Query<TagQuery>) -> Response {
    if q.search.len() > MAX_TAG_LEN {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut params = vec![("search", q.search)];
    if let Some(service) = q.service.filter(|s| !s.is_empty()) {
        params.push(("tag_service_key", service));
    }
    let qs = serde_urlencoded::to_string(&params).unwrap_or_default();
    get_json(
        &state,
        "hydrus tags",
        &format!("/add_tags/search_tags?{qs}"),
    )
    .await
}

// A grid of tiles asks for many thumbnails at once and again on every
// re-render, so they are worth keeping; they are small and not secret.
#[derive(Default)]
pub struct ThumbnailCache {
    entries: std::sync::Mutex<indexmap::IndexMap<String, (bytes::Bytes, String)>>,
}

impl ThumbnailCache {
    fn get(&self, hash: &str) -> Option<(bytes::Bytes, String)> {
        self.entries
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(hash)
            .cloned()
    }

    fn put(&self, hash: &str, body: bytes::Bytes, mime: String) {
        let mut e = self.entries.lock().unwrap_or_else(|e| e.into_inner());
        e.insert(hash.to_string(), (body, mime));
        while e.len() > THUMBNAIL_CACHE_ENTRIES {
            e.shift_remove_index(0);
        }
    }
}

pub async fn thumbnail(State(state): State<Arc<AppState>>, Path(hash): Path<String>) -> Response {
    if !is_sha256(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let serve = |body: bytes::Bytes, mime: String| {
        (
            [
                (header::CONTENT_TYPE, mime),
                (header::CACHE_CONTROL, "private, max-age=3600".to_string()),
            ],
            body,
        )
            .into_response()
    };
    if let Some((body, mime)) = state.thumbnails.get(&hash) {
        return serve(body, mime);
    }
    let res = match get(&state, &format!("/get_files/thumbnail?hash={hash}"), None).await {
        Ok(r) => r,
        Err(e) => return report("hydrus thumbnail", e),
    };
    let mime = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("image/jpeg")
        .to_string();
    match res.bytes().await {
        Ok(body) => {
            state.thumbnails.put(&hash, body.clone(), mime.clone());
            serve(body, mime)
        }
        Err(e) => upstream_failed("hydrus thumbnail", e.without_url()),
    }
}

// Ranged reads: the Foundry module reader pulls a few entries out of a large
// archive instead of downloading all of it.
pub async fn file(
    State(state): State<Arc<AppState>>,
    Path(hash): Path<String>,
    headers: HeaderMap,
) -> Response {
    if !is_sha256(&hash) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let res = match get(
        &state,
        &format!("/get_files/file?hash={hash}"),
        headers.get(header::RANGE).and_then(|v| v.to_str().ok()),
    )
    .await
    {
        Ok(r) => r,
        Err(e) => return report("hydrus file", e),
    };
    let status = StatusCode::from_u16(res.status().as_u16()).unwrap_or(StatusCode::OK);
    let mut out_headers = axum::http::HeaderMap::new();
    for name in [
        reqwest::header::CONTENT_TYPE,
        reqwest::header::CONTENT_RANGE,
    ] {
        if let Some(v) = res.headers().get(&name)
            && let Ok(v) = axum::http::HeaderValue::from_bytes(v.as_bytes())
            && let Ok(n) = axum::http::HeaderName::from_bytes(name.as_str().as_bytes())
        {
            out_headers.insert(n, v);
        }
    }
    match res.bytes().await {
        Ok(body) => {
            let mut response = (status, body).into_response();
            response.headers_mut().extend(out_headers);
            response
        }
        Err(e) => upstream_failed("hydrus file", e.without_url()),
    }
}
