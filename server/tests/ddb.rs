mod common;

use axum::extract::Path;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::{get, post};
use common::start;
use reqwest::Method;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const COBALT: &str = "cobalt-cookie";

#[derive(Default)]
struct Stub {
    refreshes: AtomicUsize,
    // Serve one 401 so the retry path is exercised.
    unauthorized_once: AtomicUsize,
}

async fn stub() -> (String, Arc<Stub>) {
    let state = Arc::new(Stub::default());
    let auth_state = state.clone();
    let enc_state = state.clone();
    let app = axum::Router::new()
        .route(
            "/v1/cobalt-token",
            post(move |headers: HeaderMap| {
                let s = auth_state.clone();
                async move {
                    let cookie = headers
                        .get(axum::http::header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("");
                    if cookie != format!("CobaltSession={COBALT}") {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    let n = s.refreshes.fetch_add(1, Ordering::SeqCst) + 1;
                    axum::Json(json!({ "token": format!("token-{n}"), "ttl": 60 })).into_response()
                }
            }),
        )
        .route(
            "/v1/encounters",
            get(|headers: HeaderMap| async move {
                match headers.get(axum::http::header::AUTHORIZATION) {
                    Some(_) => axum::Json(json!({ "data": [{ "id": "enc-1", "name": "Crypt" }] }))
                        .into_response(),
                    None => StatusCode::UNAUTHORIZED.into_response(),
                }
            }),
        )
        .route(
            "/v1/encounters/{id}",
            get(move |Path(id): Path<String>| {
                let s = enc_state.clone();
                async move {
                    // The first call answers 401, so the caller must refresh
                    // its token and come back.
                    if s.unauthorized_once.fetch_add(1, Ordering::SeqCst) == 0 {
                        return StatusCode::UNAUTHORIZED.into_response();
                    }
                    axum::Json(json!({
                        "data": { "id": id, "roundNum": 2, "players": [{ "id": 11 }] }
                    }))
                    .into_response()
                }
            }),
        )
        .route(
            "/character/v5/character/{id}",
            get(|Path(id): Path<i64>| async move {
                axum::Json(json!({ "data": { "id": id, "name": "Aria" } }))
            }),
        )
        .route(
            "/v1/Monster/{id}",
            get(|Path(id): Path<i64>| async move {
                // Plain http, so the server must refuse to store it.
                axum::Json(
                    json!({ "data": [{ "id": id, "avatarUrl": "http://cdn.example/a.png" }] }),
                )
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, state)
}

async fn configured() -> (common::Server, Arc<Stub>) {
    let (base, stub) = stub().await;
    let s = start(&[
        ("DM_SCREEN_DDB_COBALT", COBALT),
        ("DM_SCREEN_DDB_BASE", &base),
    ])
    .await;
    (s, stub)
}

#[tokio::test]
async fn trades_the_cookie_for_a_token_once_and_reuses_it() {
    let (s, stub) = configured().await;
    let valid: Value = s
        .api(Method::GET, "/api/ddb/validate")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(valid, json!({ "valid": true }));

    let list: Value = s
        .api(Method::GET, "/api/ddb/encounters")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(list["data"][0]["id"], "enc-1");
    // validate refreshes on purpose; the encounter list reused that token.
    assert_eq!(stub.refreshes.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn refreshes_the_token_once_when_a_call_answers_401() {
    let (s, stub) = configured().await;
    let enc: Value = s
        .api(Method::GET, "/api/ddb/encounters/enc-1")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(enc["data"]["roundNum"], 2);
    // One refresh for the first token, one after the 401.
    assert_eq!(stub.refreshes.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn reports_a_bad_cookie_as_invalid_rather_than_an_error() {
    let (base, _) = stub().await;
    let s = start(&[
        ("DM_SCREEN_DDB_COBALT", "wrong"),
        ("DM_SCREEN_DDB_BASE", &base),
    ])
    .await;
    let valid: Value = s
        .api(Method::GET, "/api/ddb/validate")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(valid, json!({ "valid": false }));
}

#[tokio::test]
async fn validates_ids_before_calling_upstream() {
    let (s, stub) = configured().await;
    for id in ["../secrets", &"a".repeat(65), ""] {
        let res = s
            .api(Method::GET, &format!("/api/ddb/encounters/{id}"))
            .send()
            .await
            .unwrap();
        assert!(
            res.status() == 400 || res.status() == 404,
            "{id}: {}",
            res.status()
        );
    }
    assert_eq!(stub.refreshes.load(Ordering::SeqCst), 0);

    let many: Vec<i64> = (0..200).collect();
    let res = s
        .api(Method::POST, "/api/ddb/characters")
        .json(&json!({ "ids": many }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);
}

#[tokio::test]
async fn resolves_characters_by_id() {
    let (s, _) = configured().await;
    let body: Value = s
        .api(Method::POST, "/api/ddb/characters")
        .json(&json!({ "ids": [11] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body["11"]["data"]["name"], "Aria");
}

#[tokio::test]
async fn refuses_to_fetch_an_avatar_that_is_not_https() {
    let (s, _) = configured().await;
    let body: Value = s
        .api(Method::POST, "/api/ddb/monster-images")
        .json(&json!({ "ids": [5] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(body, json!({}));
}

#[tokio::test]
async fn tracks_one_encounter_at_a_time_and_stops_on_request() {
    let (s, _) = configured().await;
    let track = |body: Value| s.api(Method::POST, "/api/ddb/track").json(&body).send();

    assert_eq!(
        track(json!({ "encounterId": "enc-1" }))
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(s.state.ddb_tracking.tracked().as_deref(), Some("enc-1"));

    assert_eq!(
        track(json!({ "encounterId": "enc-2" }))
            .await
            .unwrap()
            .status(),
        204
    );
    assert_eq!(s.state.ddb_tracking.tracked().as_deref(), Some("enc-2"));

    assert_eq!(
        track(json!({ "encounterId": "../x" }))
            .await
            .unwrap()
            .status(),
        400
    );

    assert_eq!(
        track(json!({ "encounterId": null }))
            .await
            .unwrap()
            .status(),
        204
    );
    assert!(s.state.ddb_tracking.tracked().is_none());
}

#[tokio::test]
async fn remembers_the_last_poll_for_a_controller_that_joins_later() {
    let (s, _) = configured().await;
    s.api(Method::POST, "/api/ddb/track")
        .json(&json!({ "encounterId": "enc-1" }))
        .send()
        .await
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    while s.state.ddb_tracking.last_state().is_none() && std::time::Instant::now() < deadline {
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    let last = s.state.ddb_tracking.last_state().expect("a poll ran");
    let msg: Value = serde_json::from_str(&last).unwrap();
    assert_eq!(msg["type"], "ddb-state");
    assert_eq!(msg["payload"]["encounter"]["data"]["roundNum"], 2);
    assert_eq!(msg["payload"]["characters"]["11"]["data"]["name"], "Aria");
    s.state.ddb_tracking.stop();
}

#[tokio::test]
async fn answers_not_implemented_without_a_cookie() {
    let s = start(&[]).await;
    for (method, path) in [
        (Method::GET, "/api/ddb/validate"),
        (Method::GET, "/api/ddb/encounters"),
        (Method::GET, "/api/ddb/encounters/enc-1"),
    ] {
        assert_eq!(
            s.api(method, path).send().await.unwrap().status(),
            501,
            "{path}"
        );
    }
    let res = s
        .api(Method::POST, "/api/ddb/track")
        .json(&json!({ "encounterId": "enc-1" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 501);
}
