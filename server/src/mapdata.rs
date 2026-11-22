use crate::state::AppState;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Arc;

pub const MAX_MAPDATA_BODY: usize = 1024 * 1024;

// The four per-map stores the plugin keeps in settings and sidecars in
// embedded mode, keyed the same way (map URL, or screen key for profiles).
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct MapData {
    #[serde(default)]
    pub configs: IndexMap<String, Value>,
    #[serde(default)]
    pub profiles: IndexMap<String, Value>,
    #[serde(default)]
    pub fog: IndexMap<String, Value>,
    #[serde(default)]
    pub walls: IndexMap<String, Value>,
}

impl MapData {
    fn collection(&mut self, name: &str) -> Option<&mut IndexMap<String, Value>> {
        match name {
            "configs" => Some(&mut self.configs),
            "profiles" => Some(&mut self.profiles),
            "fog" => Some(&mut self.fog),
            "walls" => Some(&mut self.walls),
            _ => None,
        }
    }
}

pub async fn get_all(State(state): State<Arc<AppState>>) -> Response {
    axum::Json(state.session().mapdata.clone()).into_response()
}

pub async fn put(
    State(state): State<Arc<AppState>>,
    Path((collection, key)): Path<(String, String)>,
    body: Bytes,
) -> Response {
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    {
        let mut s = state.session();
        let Some(map) = s.mapdata.collection(&collection) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        map.insert(key, value);
    }
    state
        .assets
        .touch_referenced(&String::from_utf8_lossy(&body));
    state.mark_dirty();
    StatusCode::NO_CONTENT.into_response()
}

pub async fn delete(
    State(state): State<Arc<AppState>>,
    Path((collection, key)): Path<(String, String)>,
) -> Response {
    {
        let mut s = state.session();
        let Some(map) = s.mapdata.collection(&collection) else {
            return StatusCode::NOT_FOUND.into_response();
        };
        map.shift_remove(&key);
    }
    state.mark_dirty();
    StatusCode::NO_CONTENT.into_response()
}
