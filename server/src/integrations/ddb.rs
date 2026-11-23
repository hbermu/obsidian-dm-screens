use crate::integrations::{http, not_configured, upstream_failed};
use crate::state::{AppState, Outbound};
use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

// The upstream bases the plugin's own client uses; overridable so the tests
// can point them at a stub.
pub struct Endpoints {
    pub auth: String,
    pub encounter: String,
    pub character: String,
    pub monster: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Endpoints {
            auth: "https://auth-service.dndbeyond.com/v1/cobalt-token".into(),
            encounter: "https://encounter-service.dndbeyond.com/v1/encounters".into(),
            character: "https://character-service.dndbeyond.com/character/v5/character".into(),
            monster: "https://monster-service.dndbeyond.com/v1/Monster".into(),
        }
    }
}

impl Endpoints {
    pub fn with_base(base: Option<&str>) -> Endpoints {
        let mut e = Endpoints::default();
        if let Some(base) = base.filter(|b| !b.is_empty()) {
            let base = base.trim_end_matches('/').to_string();
            e.auth = format!("{base}/v1/cobalt-token");
            e.encounter = format!("{base}/v1/encounters");
            e.character = format!("{base}/character/v5/character");
            e.monster = format!("{base}/v1/Monster");
        }
        e
    }
}

#[derive(Default)]
pub struct DdbSession {
    token: Mutex<Option<(String, Instant)>>,
}

impl DdbSession {
    fn cached(&self) -> Option<String> {
        let t = self.token.lock().unwrap_or_else(|e| e.into_inner());
        t.as_ref()
            .filter(|(_, exp)| *exp > Instant::now())
            .map(|(v, _)| v.clone())
    }

    fn store(&self, token: String, ttl: u64) {
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) =
            Some((token, Instant::now() + Duration::from_secs(ttl)));
    }

    fn clear(&self) {
        *self.token.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

// The cookie buys a short-lived token; the token is what every call carries.
// A failure here reports its status only, because the auth endpoint's body
// can echo the cookie back.
async fn refresh(state: &AppState) -> Result<String, String> {
    let cobalt = state
        .config
        .ddb
        .as_ref()
        .ok_or("not configured")?
        .cobalt
        .clone();
    let res = http()
        .post(&state.ddb_endpoints.auth)
        .header(reqwest::header::COOKIE, format!("CobaltSession={cobalt}"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body("")
        .send()
        .await
        .map_err(|e| e.without_url().to_string())?;
    if !res.status().is_success() {
        return Err(format!("auth status {}", res.status().as_u16()));
    }
    let body: Value = res.json().await.map_err(|e| e.without_url().to_string())?;
    let token = body
        .get("token")
        .and_then(Value::as_str)
        .ok_or("auth response has no token")?;
    let ttl = body.get("ttl").and_then(Value::as_u64).unwrap_or(60);
    state
        .ddb_session
        .store(token.to_string(), ttl.saturating_sub(5).max(1));
    Ok(token.to_string())
}

async fn token(state: &AppState) -> Result<String, String> {
    match state.ddb_session.cached() {
        Some(t) => Ok(t),
        None => refresh(state).await,
    }
}

// One retry on 401: the token can expire between the check and the call.
pub async fn authed_get(state: &AppState, url: &str) -> Result<Value, String> {
    for attempt in 0..2 {
        let token = token(state).await?;
        let res = http()
            .get(url)
            .bearer_auth(&token)
            .header(reqwest::header::ACCEPT, "application/json")
            .send()
            .await
            .map_err(|e| e.without_url().to_string())?;
        if res.status() == reqwest::StatusCode::UNAUTHORIZED && attempt == 0 {
            state.ddb_session.clear();
            continue;
        }
        if !res.status().is_success() {
            return Err(format!("status {}", res.status().as_u16()));
        }
        return res.json().await.map_err(|e| e.without_url().to_string());
    }
    Err("session expired".into())
}

fn configured(state: &AppState, op: &'static str) -> Option<Response> {
    state.config.ddb.is_none().then(|| not_configured(op))
}

fn valid_encounter_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

pub async fn validate(State(state): State<Arc<AppState>>) -> Response {
    if let Some(r) = configured(&state, "ddb validate") {
        return r;
    }
    match refresh(&state).await {
        Ok(_) => axum::Json(json!({ "valid": true })).into_response(),
        Err(e) => {
            tracing::warn!(error = %e, "ddb validate failed");
            axum::Json(json!({ "valid": false })).into_response()
        }
    }
}

async fn relay(state: &AppState, op: &'static str, url: String) -> Response {
    match authed_get(state, &url).await {
        Ok(body) => axum::Json(body).into_response(),
        Err(e) => upstream_failed(op, e),
    }
}

pub async fn encounters(State(state): State<Arc<AppState>>) -> Response {
    if let Some(r) = configured(&state, "ddb encounters") {
        return r;
    }
    let url = format!("{}?skip=0&take=100", state.ddb_endpoints.encounter);
    relay(&state, "ddb encounters", url).await
}

pub async fn encounter(State(state): State<Arc<AppState>>, Path(id): Path<String>) -> Response {
    if let Some(r) = configured(&state, "ddb encounter") {
        return r;
    }
    if !valid_encounter_id(&id) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let url = format!("{}/{id}", state.ddb_endpoints.encounter);
    relay(&state, "ddb encounter", url).await
}

#[derive(Deserialize)]
pub struct Ids {
    ids: Vec<i64>,
}

const MAX_IDS: usize = 128;

pub async fn characters(State(state): State<Arc<AppState>>, Json(req): Json<Ids>) -> Response {
    if let Some(r) = configured(&state, "ddb characters") {
        return r;
    }
    if req.ids.len() > MAX_IDS {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut out = serde_json::Map::new();
    for id in req.ids {
        let url = format!("{}/{id}", state.ddb_endpoints.character);
        match authed_get(&state, &url).await {
            Ok(body) => {
                out.insert(id.to_string(), body);
            }
            Err(e) => tracing::warn!(id, error = %e, "ddb character failed"),
        }
    }
    axum::Json(Value::Object(out)).into_response()
}

// The avatars become ordinary assets, so the device never fetches a D&D
// Beyond URL and the player screen serves them like anything else.
pub async fn monster_images(State(state): State<Arc<AppState>>, Json(req): Json<Ids>) -> Response {
    if let Some(r) = configured(&state, "ddb monster images") {
        return r;
    }
    if req.ids.len() > MAX_IDS {
        return StatusCode::BAD_REQUEST.into_response();
    }
    let mut out = serde_json::Map::new();
    for id in req.ids {
        let url = format!("{}/{id}", state.ddb_endpoints.monster);
        let Ok(body) = authed_get(&state, &url).await else {
            continue;
        };
        let Some(avatar) = body
            .get("data")
            .and_then(|d| d.get(0).or(Some(d)))
            .and_then(|m| m.get("avatarUrl"))
            .and_then(Value::as_str)
            .filter(|u| u.starts_with("https://"))
        else {
            continue;
        };
        match crate::assets::store_remote(&state, avatar).await {
            Ok(asset) => {
                out.insert(id.to_string(), Value::String(asset));
            }
            Err(e) => tracing::warn!(id, error = %e, "ddb avatar fetch failed"),
        }
    }
    state.mark_dirty();
    axum::Json(Value::Object(out)).into_response()
}

// ── Polling ──────────────────────────────────────────────────────────────

pub const CYCLE_MIN_MS: u64 = 2000;
pub const CYCLE_MAX_MS: u64 = 8000;
pub const BREAKER_THRESHOLD: u32 = 3;
pub const BREAKER_PAUSE_MS: u64 = 30_000;

#[derive(Default)]
pub struct Tracking {
    inner: Mutex<Option<TrackState>>,
}

struct TrackState {
    encounter_id: String,
    handle: tokio::task::JoinHandle<()>,
    last: Option<String>,
}

impl Tracking {
    pub fn tracked(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .map(|t| t.encounter_id.clone())
    }

    // The state a controller connecting mid-combat should see at once.
    pub fn last_state(&self) -> Option<String> {
        self.inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_ref()
            .and_then(|t| t.last.clone())
    }

    fn remember(&self, message: String) {
        if let Some(t) = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .as_mut()
        {
            t.last = Some(message);
        }
    }

    pub fn stop(&self) {
        if let Some(t) = self.inner.lock().unwrap_or_else(|e| e.into_inner()).take() {
            t.handle.abort();
            tracing::info!(encounter = %t.encounter_id, "ddb tracking stopped");
        }
    }

    fn start(&self, encounter_id: String, handle: tokio::task::JoinHandle<()>) {
        let previous = self
            .inner
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .replace(TrackState {
                encounter_id,
                handle,
                last: None,
            });
        if let Some(t) = previous {
            t.handle.abort();
        }
    }
}

fn jitter(base: u64, ratio: f64) -> u64 {
    let span = (base as f64 * ratio) as u64;
    base.saturating_sub(span / 2) + fastrand_u64(span.max(1))
}

// A tiny uniform source: the cadence only needs to be irregular, not secure.
fn fastrand_u64(bound: u64) -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0);
    (nanos as u64).wrapping_mul(6364136223846793005) % bound.max(1)
}

pub fn send_to_controls(state: &AppState, message: String) {
    let s = state.session();
    for c in s.controls.values() {
        let _ = c.tx.send(Outbound::Text(message.clone()));
    }
}

async fn poll_once(state: &Arc<AppState>, encounter_id: &str) -> Result<Value, String> {
    let url = format!("{}/{encounter_id}", state.ddb_endpoints.encounter);
    let encounter = authed_get(state, &url).await?;
    let ids: Vec<i64> = encounter
        .get("data")
        .and_then(|d| d.get("players"))
        .and_then(Value::as_array)
        .map(|players| {
            players
                .iter()
                .filter_map(|p| p.get("id").and_then(Value::as_i64))
                .collect()
        })
        .unwrap_or_default();
    let mut characters = serde_json::Map::new();
    for id in ids.into_iter().take(MAX_IDS) {
        let url = format!("{}/{id}", state.ddb_endpoints.character);
        if let Ok(body) = authed_get(state, &url).await {
            characters.insert(id.to_string(), body);
        }
    }
    Ok(json!({ "encounter": encounter, "characters": characters }))
}

fn poll_loop(state: Arc<AppState>, encounter_id: String) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut failures: u32 = 0;
        loop {
            let message = match poll_once(&state, &encounter_id).await {
                Ok(payload) => {
                    failures = 0;
                    json!({ "type": "ddb-state", "payload": payload }).to_string()
                }
                Err(e) => {
                    failures += 1;
                    tracing::warn!(error = %e, failures, "ddb poll failed");
                    json!({ "type": "ddb-state", "payload": { "error": e } }).to_string()
                }
            };
            state.ddb_tracking.remember(message.clone());
            send_to_controls(&state, message);
            let pause = if failures >= BREAKER_THRESHOLD {
                jitter(BREAKER_PAUSE_MS, 0.2)
            } else {
                CYCLE_MIN_MS + fastrand_u64(CYCLE_MAX_MS - CYCLE_MIN_MS)
            };
            tokio::time::sleep(Duration::from_millis(pause)).await;
        }
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackRequest {
    encounter_id: Option<String>,
}

pub async fn track(State(state): State<Arc<AppState>>, Json(req): Json<TrackRequest>) -> Response {
    if let Some(r) = configured(&state, "ddb track") {
        return r;
    }
    match req.encounter_id {
        None => {
            state.ddb_tracking.stop();
            StatusCode::NO_CONTENT.into_response()
        }
        Some(id) if valid_encounter_id(&id) => {
            tracing::info!(encounter = %id, "ddb tracking started");
            state
                .ddb_tracking
                .start(id.clone(), poll_loop(state.clone(), id));
            StatusCode::NO_CONTENT.into_response()
        }
        Some(_) => StatusCode::BAD_REQUEST.into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_a_plausible_encounter_id() {
        assert!(valid_encounter_id("abc-123"));
        assert!(!valid_encounter_id(""));
        assert!(!valid_encounter_id("../etc"));
        assert!(!valid_encounter_id(&"a".repeat(65)));
    }

    #[test]
    fn a_base_override_rewrites_every_endpoint() {
        let e = Endpoints::with_base(Some("http://stub/"));
        assert_eq!(e.auth, "http://stub/v1/cobalt-token");
        assert_eq!(e.encounter, "http://stub/v1/encounters");
    }

    #[test]
    fn the_cached_token_expires() {
        let s = DdbSession::default();
        assert!(s.cached().is_none());
        s.store("t".into(), 60);
        assert_eq!(s.cached().as_deref(), Some("t"));
        s.clear();
        assert!(s.cached().is_none());
    }
}
