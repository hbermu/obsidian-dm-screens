use crate::allowlist::is_sha256;
use crate::assets::content_type;
use crate::config::WebhookTarget;
use crate::integrations::{http, upstream_failed};
use crate::state::AppState;
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const MAX_CAPTION: usize = 1024;
const MIN_GAP: Duration = Duration::from_secs(1);
const WINDOW: Duration = Duration::from_secs(60);
const MAX_PER_WINDOW: usize = 20;

// A webhook is the one integration that writes somewhere public, so each
// target is paced: one send a second and twenty a minute.
#[derive(Default)]
pub struct SendLimiter {
    sends: Mutex<HashMap<String, Vec<Instant>>>,
}

impl SendLimiter {
    fn allow(&self, name: &str) -> bool {
        let now = Instant::now();
        let mut map = self.sends.lock().unwrap_or_else(|e| e.into_inner());
        let hits = map.entry(name.to_string()).or_default();
        hits.retain(|t| now.duration_since(*t) < WINDOW);
        if hits
            .last()
            .is_some_and(|t| now.duration_since(*t) < MIN_GAP)
            || hits.len() >= MAX_PER_WINDOW
        {
            return false;
        }
        hits.push(now);
        true
    }
}

#[derive(Deserialize)]
pub struct SendRequest {
    asset: String,
    #[serde(default)]
    caption: String,
}

fn target<'a>(state: &'a AppState, name: &str) -> Option<&'a WebhookTarget> {
    state.config.webhooks.iter().find(|t| t.name == name)
}

// Only an asset the server already stores: the route posts an image, never
// arbitrary bytes a caller supplies.
fn asset_parts(asset: &str) -> Option<(String, String)> {
    let name = asset.strip_prefix("/assets/")?;
    let (sha, ext) = name.split_once('.')?;
    is_sha256(sha).then(|| (sha.to_string(), ext.to_string()))
}

pub async fn send(
    State(state): State<Arc<AppState>>,
    Path(name): Path<String>,
    Json(req): Json<SendRequest>,
) -> Response {
    let Some(target) = target(&state, &name).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    if req.caption.len() > MAX_CAPTION {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let Some((sha, ext)) = asset_parts(&req.asset) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    let Some(meta) = state.assets.meta(&sha).filter(|m| m.ext == ext) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !state.limiter.allow(&name) {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    }
    let Ok(bytes) = tokio::fs::read(state.assets.asset_path(&sha)).await else {
        return StatusCode::BAD_REQUEST.into_response();
    };

    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(format!("{}.{}", &sha[..12], meta.ext))
        .mime_str(content_type(&meta.ext))
        .unwrap_or_else(|_| reqwest::multipart::Part::text(""));
    let mut form = reqwest::multipart::Form::new().part(target.image_field.clone(), part);
    if !req.caption.is_empty() {
        form = form.text(target.caption_field.clone(), req.caption);
    }
    for field in &target.extra_fields {
        form = form.text(field.key.clone(), field.value.clone());
    }

    match http().post(&target.url).multipart(form).send().await {
        Ok(res) if res.status().is_success() => {
            tracing::info!(target = %name, "webhook sent");
            StatusCode::NO_CONTENT.into_response()
        }
        // The target URL holds the bot token and the body echoes the request,
        // so only the name and the status are reported.
        Ok(res) => upstream_failed(
            "webhook send",
            format!("{name}: status {}", res.status().as_u16()),
        ),
        Err(e) => upstream_failed("webhook send", format!("{name}: {}", e.without_url())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_stored_asset_url() {
        let sha = "a".repeat(64);
        assert_eq!(
            asset_parts(&format!("/assets/{sha}.png")),
            Some((sha.clone(), "png".into()))
        );
        assert!(asset_parts("/assets/short.png").is_none());
        assert!(asset_parts("https://example.com/x.png").is_none());
        assert!(asset_parts("data:image/png;base64,AA==").is_none());
    }

    #[test]
    fn paces_each_target_separately() {
        let l = SendLimiter::default();
        assert!(l.allow("telegram"));
        assert!(!l.allow("telegram"));
        assert!(l.allow("discord"));
    }

    #[test]
    fn stops_a_target_at_twenty_a_minute() {
        let l = SendLimiter::default();
        let now = Instant::now();
        // Twenty sends already in this minute, the last one well in the past.
        l.sends.lock().unwrap().insert(
            "t".into(),
            (0..20).map(|i| now - Duration::from_secs(50 - i)).collect(),
        );
        assert!(!l.allow("t"));
    }
}
