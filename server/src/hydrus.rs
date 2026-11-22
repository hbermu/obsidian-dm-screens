use crate::assets::ext_for_content_type;
use crate::state::AppState;
use axum::Json;
use axum::extract::State;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;

#[derive(Deserialize)]
pub struct HydrusRequest {
    hash: String,
}

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
    let hydrus = state.config.hydrus.as_ref().expect("checked by the caller");
    let url = format!("{}/get_files/file?hash={hash}", hydrus.url);
    let res = reqwest::Client::new()
        .get(&url)
        .header("Hydrus-Client-API-Access-Key", &hydrus.key)
        .send()
        .await
        .map_err(|e| Failure::Upstream(e.without_url().to_string()))?;
    if !res.status().is_success() {
        return Err(Failure::Upstream(format!(
            "status {}",
            res.status().as_u16()
        )));
    }
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
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
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
        Err(Failure::TooLarge) => StatusCode::PAYLOAD_TOO_LARGE.into_response(),
        Err(f) => {
            let reason = match f {
                Failure::Upstream(e) => e,
                Failure::Mismatch => "hash mismatch".into(),
                Failure::Unsupported => "unsupported content type".into(),
                Failure::TooLarge => unreachable!(),
            };
            tracing::warn!(hash = &hash[..12], reason, "Hydrus fetch failed");
            StatusCode::BAD_GATEWAY.into_response()
        }
    }
}
