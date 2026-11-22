pub mod allowlist;
pub mod assets;
pub mod auth;
pub mod config;
pub mod control;
pub mod derivatives;
pub mod hydrus;
pub mod mapdata;
pub mod persist;
pub mod protocol;
pub mod replay;
pub mod state;
pub mod viewers;

use crate::assets::{AssetStore, CHUNK_SIZE, referenced_hashes};
use crate::auth::{Role, api_token, role_for};
use crate::config::Config;
use crate::protocol::{MAP_CSS, MAP_JS, PLAYER_CSS, PLAYER_JS};
use crate::replay::ReplayCache;
use crate::state::{AppState, Session};
use axum::Router;
use axum::extract::{DefaultBodyLimit, OriginalUri, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post, put};
use std::sync::Arc;
use std::time::Duration;

async fn require_control(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    OriginalUri(uri): OriginalUri,
    req: Request,
    next: Next,
) -> Response {
    let token = api_token(uri.query(), &headers);
    if role_for(
        &token,
        &state.config.view_token,
        &state.config.control_token,
    ) != Some(Role::Control)
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    next.run(req).await
}

// Request logs carry the path only: a query string can hold a token.
async fn log_requests(req: Request, next: Next) -> Response {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let res = next.run(req).await;
    tracing::debug!(%method, path, status = res.status().as_u16(), "request");
    res
}

pub fn open(config: Config) -> std::io::Result<Arc<AppState>> {
    std::fs::create_dir_all(persist::state_dir(&config.data_dir))?;
    let dir = persist::state_dir(&config.data_dir);
    let mut session = Session {
        replay: ReplayCache::from_entries(persist::load(&dir.join("replay.json"))),
        mapdata: persist::load(&dir.join("mapdata.json")),
        ..Default::default()
    };
    // State restored from disk never passed through relay(), so its assets are
    // allowlisted here, as the embedded server does for a seeded cache.
    let restored: Vec<(String, String)> = session
        .replay
        .entries()
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    for (kind, data) in restored {
        if let Ok(msg) = serde_json::from_str::<serde_json::Value>(&data) {
            session.allowlist.observe(
                &kind,
                msg.get("payload").unwrap_or(&serde_json::Value::Null),
            );
        }
    }
    let assets = AssetStore::open(&config.data_dir)?;
    Ok(Arc::new(AppState::new(config, session, assets)))
}

pub fn router(state: Arc<AppState>) -> Router {
    let api = Router::new()
        .route("/api/mapdata", get(mapdata::get_all))
        .route(
            "/api/mapdata/{collection}/{key}",
            put(mapdata::put)
                .delete(mapdata::delete)
                .layer(DefaultBodyLimit::max(mapdata::MAX_MAPDATA_BODY)),
        )
        .route("/api/assets/lookup", post(assets::lookup))
        .route("/api/assets/hydrus", post(hydrus::fetch))
        .route("/api/assets/{sha}", get(assets::get_meta))
        .route("/api/uploads", post(assets::create_upload))
        .route(
            "/api/uploads/{id}",
            put(assets::put_chunk).layer(DefaultBodyLimit::max(CHUNK_SIZE as usize + 1024)),
        )
        .route("/api/uploads/{id}/complete", post(assets::complete))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_control,
        ));

    let file = |body: &'static str, kind: &'static str| {
        move |State(s): State<Arc<AppState>>, OriginalUri(uri): OriginalUri, headers: HeaderMap| async move {
            viewers::static_file(&s, &uri, &headers, body, kind)
        }
    };

    Router::new()
        .route("/", get(viewers::player_page))
        .route("/index.html", get(viewers::player_page))
        .route("/map", get(viewers::map_page))
        .route(
            "/player.js",
            get(file(PLAYER_JS, "application/javascript; charset=utf-8")),
        )
        .route(
            "/player.css",
            get(file(PLAYER_CSS, "text/css; charset=utf-8")),
        )
        .route(
            "/map.js",
            get(file(MAP_JS, "application/javascript; charset=utf-8")),
        )
        .route("/map.css", get(file(MAP_CSS, "text/css; charset=utf-8")))
        .route("/health", get(viewers::health))
        .route("/control", get(control::control))
        .route("/assets/{name}", get(assets::serve))
        .merge(api)
        .fallback(|| async { (StatusCode::NOT_FOUND, "Not found") })
        .layer(middleware::from_fn(log_requests))
        .with_state(state)
}

pub fn collect_garbage(state: &AppState) {
    let referenced = {
        let s = state.session();
        let mut text: String = s
            .replay
            .entries()
            .values()
            .cloned()
            .collect::<Vec<_>>()
            .join("\n");
        text.push_str(&serde_json::to_string(&s.mapdata).unwrap_or_default());
        referenced_hashes(&text)
    };
    let removed = state
        .assets
        .gc(&referenced, state.config.asset_retention_days);
    if removed > 0 {
        tracing::info!(removed, "retention sweep deleted unused assets");
        state.mark_dirty();
    }
}

pub fn spawn_background(state: Arc<AppState>) {
    tokio::spawn(persist::writer(state.clone()));
    let s = state.clone();
    tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(300));
        let mut since_gc = u32::MAX;
        loop {
            tick.tick().await;
            s.assets.sweep_uploads();
            since_gc = since_gc.saturating_add(1);
            if since_gc >= 288 {
                since_gc = 0;
                collect_garbage(&s);
            }
        }
    });
}
