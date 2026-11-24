use crate::state::{AppState, Outbound};
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use indexmap::IndexMap;
use serde_json::{Value, json};
use std::sync::Arc;

pub const MAX_PREFS_BODY: usize = 64 * 1024;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Shape {
    Bool,
    Number,
    Text,
    TextList,
}

// The session preferences a controller may set. Only the shape is checked
// here: an unset key falls back to the plugin's own default, so the defaults
// live in one language instead of two.
const KNOWN: [(&str, Shape); 8] = [
    ("hydrusTagServices", Shape::TextList),
    ("hydrusIgnoredTagPatterns", Shape::TextList),
    ("hydrusDefaultSearchTags", Shape::Text),
    ("hydrusDefaultLoop", Shape::Bool),
    ("hydrusDefaultMuted", Shape::Bool),
    ("mapDefaultPxPerSquare", Shape::Number),
    ("mapFogTvOpacity", Shape::Number),
    ("ddbInspirationPulse", Shape::Bool),
];

pub type Prefs = IndexMap<String, Value>;

fn shape_of(key: &str) -> Option<Shape> {
    KNOWN.iter().find(|(k, _)| *k == key).map(|(_, s)| *s)
}

fn fits(shape: Shape, value: &Value) -> bool {
    match shape {
        Shape::Bool => value.is_boolean(),
        Shape::Number => value.as_f64().is_some_and(f64::is_finite),
        Shape::Text => value.is_string(),
        Shape::TextList => value
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)),
    }
}

// Drops anything a previous version stored that this one does not know, so a
// downgrade cannot feed the plugin a key of the wrong shape.
pub fn sanitize(prefs: Prefs) -> Prefs {
    prefs
        .into_iter()
        .filter(|(k, v)| shape_of(k).is_some_and(|s| fits(s, v)))
        .collect()
}

fn broadcast(state: &AppState) {
    let s = state.session();
    let msg = json!({ "type": "prefs", "payload": { "prefs": s.prefs } }).to_string();
    for c in s.controls.values() {
        let _ = c.tx.send(Outbound::Text(msg.clone()));
    }
}

pub async fn get_all(State(state): State<Arc<AppState>>) -> Response {
    axum::Json(state.session().prefs.clone()).into_response()
}

pub async fn put(
    State(state): State<Arc<AppState>>,
    Path(key): Path<String>,
    body: Bytes,
) -> Response {
    let Some(shape) = shape_of(&key) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&body) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !fits(shape, &value) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.session().prefs.insert(key, value);
    broadcast(&state);
    state.mark_dirty();
    StatusCode::NO_CONTENT.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_value_of_the_declared_shape_only() {
        assert!(fits(Shape::Bool, &json!(true)));
        assert!(!fits(Shape::Bool, &json!("yes")));
        assert!(fits(Shape::Number, &json!(1.5)));
        assert!(!fits(Shape::Number, &json!("140")));
        assert!(fits(Shape::TextList, &json!(["a", "b"])));
        assert!(!fits(Shape::TextList, &json!(["a", 2])));
        assert!(fits(Shape::Text, &json!("")));
    }

    #[test]
    fn knows_only_the_listed_keys() {
        assert_eq!(shape_of("ddbInspirationPulse"), Some(Shape::Bool));
        assert_eq!(shape_of("hydrusApiKey"), None);
    }

    #[test]
    fn sanitize_drops_unknown_keys_and_wrong_shapes() {
        let mut p = Prefs::new();
        p.insert("hydrusDefaultLoop".into(), json!(false));
        p.insert("hydrusDefaultMuted".into(), json!("nope"));
        p.insert("somethingElse".into(), json!(1));
        let out = sanitize(p);
        assert_eq!(out.keys().collect::<Vec<_>>(), ["hydrusDefaultLoop"]);
    }
}
