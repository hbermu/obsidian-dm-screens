mod common;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use common::{sha256_hex, start};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::HashMap;

const KEY: &str = "hydrus-key";
const GOOD: &[u8] = b"a hydrus image";

// A stand-in Hydrus Client API: the right key gets GOOD for its hash, a known
// "lying" hash gets other bytes, anything else is a 500.
async fn stub() -> String {
    let good = sha256_hex(GOOD);
    let liar = "1".repeat(64);
    let app = axum::Router::new().route(
        "/get_files/file",
        get(
            move |headers: HeaderMap, Query(q): Query<HashMap<String, String>>| {
                let (good, liar) = (good.clone(), liar.clone());
                async move {
                    if headers
                        .get("Hydrus-Client-API-Access-Key")
                        .and_then(|v| v.to_str().ok())
                        != Some(KEY)
                    {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    match q.get("hash").map(String::as_str) {
                        Some(h) if h == good => {
                            ([("content-type", "image/png")], GOOD.to_vec()).into_response()
                        }
                        Some(h) if h == liar => {
                            ([("content-type", "image/png")], b"not it".to_vec()).into_response()
                        }
                        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                }
            },
        ),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    url
}

#[tokio::test]
async fn fetches_verifies_and_stores_a_hydrus_file() {
    let url = stub().await;
    let s = start(&[
        ("DM_SCREEN_HYDRUS_URL", &url),
        ("DM_SCREEN_HYDRUS_KEY", KEY),
    ])
    .await;
    let hash = sha256_hex(GOOD);
    let res = s
        .api(Method::POST, "/api/assets/hydrus")
        .json(&json!({ "hash": hash }))
        .send()
        .await
        .unwrap();
    assert_eq!(
        res.json::<Value>().await.unwrap(),
        json!({ "sha256": hash, "ext": "png" })
    );
    let meta = s
        .api(Method::GET, &format!("/api/assets/{hash}"))
        .send()
        .await
        .unwrap();
    assert_eq!(meta.status(), 200);
}

#[tokio::test]
async fn refuses_bytes_that_do_not_hash_to_the_requested_file() {
    let url = stub().await;
    let s = start(&[
        ("DM_SCREEN_HYDRUS_URL", &url),
        ("DM_SCREEN_HYDRUS_KEY", KEY),
    ])
    .await;
    let liar = "1".repeat(64);
    let res = s
        .api(Method::POST, "/api/assets/hydrus")
        .json(&json!({ "hash": liar }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
    assert_eq!(
        s.api(Method::GET, &format!("/api/assets/{liar}"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn reports_an_upstream_failure_as_bad_gateway() {
    let url = stub().await;
    let s = start(&[
        ("DM_SCREEN_HYDRUS_URL", &url),
        ("DM_SCREEN_HYDRUS_KEY", "wrong-key"),
    ])
    .await;
    let res = s
        .api(Method::POST, "/api/assets/hydrus")
        .json(&json!({ "hash": sha256_hex(GOOD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
}

#[tokio::test]
async fn answers_not_implemented_without_hydrus() {
    let s = start(&[]).await;
    let res = s
        .api(Method::POST, "/api/assets/hydrus")
        .json(&json!({ "hash": sha256_hex(GOOD) }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 501);
}
