mod common;

use axum::extract::Query;
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use axum::routing::get;
use common::{sha256_hex, start};
use reqwest::Method;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

const KEY: &str = "hydrus-key";
const GOOD: &[u8] = b"a hydrus image";

// A stand-in Hydrus Client API: the right key gets GOOD for its hash, a known
// "lying" hash gets other bytes, anything else is a 500. The read routes
// answer canned shapes and count their calls.
#[derive(Default)]
pub struct Calls {
    pub thumbnails: AtomicUsize,
    pub metadata: AtomicUsize,
    pub longest_query: AtomicUsize,
}

async fn stub() -> String {
    stub_counting().await.0
}

async fn stub_counting() -> (String, Arc<Calls>) {
    let good = sha256_hex(GOOD);
    let liar = "1".repeat(64);
    let calls = Arc::new(Calls::default());
    let thumb_calls = calls.clone();
    let meta_calls = calls.clone();
    let key_ok = |headers: &HeaderMap| {
        headers
            .get("Hydrus-Client-API-Access-Key")
            .and_then(|v| v.to_str().ok())
            == Some(KEY)
    };
    let app = axum::Router::new()
        .route(
            "/get_files/file",
            get(move |headers: HeaderMap, Query(q): Query<HashMap<String, String>>| {
                let (good, liar) = (good.clone(), liar.clone());
                async move {
                    if !key_ok(&headers) {
                        return StatusCode::FORBIDDEN.into_response();
                    }
                    let ranged = headers.contains_key(axum::http::header::RANGE);
                    match q.get("hash").map(String::as_str) {
                        Some(h) if h == good && ranged => (
                            StatusCode::PARTIAL_CONTENT,
                            [
                                ("content-type", "image/png"),
                                ("content-range", "bytes 0-3/14"),
                            ],
                            GOOD[..4].to_vec(),
                        )
                            .into_response(),
                        Some(h) if h == good => {
                            ([("content-type", "image/png")], GOOD.to_vec()).into_response()
                        }
                        Some(h) if h == liar => {
                            ([("content-type", "image/png")], b"not it".to_vec()).into_response()
                        }
                        _ => StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                    }
                }
            }),
        )
        .route(
            "/verify_access_key",
            get(move |headers: HeaderMap| async move {
                if key_ok(&headers) {
                    axum::Json(json!({ "basic_permissions": [0] })).into_response()
                } else {
                    StatusCode::FORBIDDEN.into_response()
                }
            }),
        )
        .route(
            "/get_services",
            get(|| async { axum::Json(json!({ "services_v2": [{ "name": "my tags", "service_key": "abc", "type": 0 }] })) }),
        )
        .route(
            "/get_files/search_files",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                axum::Json(json!({ "hashes": [q.get("tags").cloned().unwrap_or_default()] }))
            }),
        )
        .route(
            "/get_files/file_metadata",
            get(move |Query(q): Query<HashMap<String, String>>| {
                let calls = meta_calls.clone();
                async move {
                    let raw = q.get("hashes").cloned().unwrap_or_default();
                    calls.metadata.fetch_add(1, Ordering::SeqCst);
                    calls.longest_query.fetch_max(raw.len(), Ordering::SeqCst);
                    let hashes: Vec<String> = serde_json::from_str(&raw).unwrap_or_default();
                    let rows: Vec<Value> = hashes
                        .into_iter()
                        .map(|h| json!({ "hash": h, "mime": "image/png" }))
                        .collect();
                    axum::Json(json!({ "metadata": rows }))
                }
            }),
        )
        .route(
            "/add_tags/search_tags",
            get(|Query(q): Query<HashMap<String, String>>| async move {
                axum::Json(json!({ "tags": [{ "value": q.get("search").cloned().unwrap_or_default() }] }))
            }),
        )
        .route(
            "/get_files/thumbnail",
            get(move || {
                let calls = thumb_calls.clone();
                async move {
                    calls.thumbnails.fetch_add(1, Ordering::SeqCst);
                    ([("content-type", "image/jpeg")], b"thumb".to_vec())
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, calls)
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

// ── Read-only proxy operations ───────────────────────────────────────────

async fn proxying() -> (common::Server, Arc<Calls>) {
    let (url, calls) = stub_counting().await;
    let s = start(&[
        ("DM_SCREEN_HYDRUS_URL", &url),
        ("DM_SCREEN_HYDRUS_KEY", KEY),
    ])
    .await;
    (s, calls)
}

#[tokio::test]
async fn passes_the_read_operations_through_with_the_key() {
    let (s, _) = proxying().await;
    let verify: Value = s
        .api(Method::GET, "/api/hydrus/verify")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(verify["basic_permissions"][0], 0);

    let services: Value = s
        .api(Method::GET, "/api/hydrus/services")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(services["services_v2"][0]["name"], "my tags");

    let search: Value = s
        .api(Method::POST, "/api/hydrus/search")
        .json(&json!({ "tags": ["dragon"], "limit": 10 }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    // The server forwards the tag list and appends the limit as Hydrus wants it.
    assert_eq!(search["hashes"][0], r#"["dragon","system:limit=10"]"#);

    let hash = sha256_hex(GOOD);
    let meta: Value = s
        .api(Method::POST, "/api/hydrus/metadata")
        .json(&json!({ "hashes": [hash] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(
        meta["metadata"][0]["hash"]
            .as_str()
            .unwrap()
            .contains(&sha256_hex(GOOD))
    );

    let tags: Value = s
        .api(Method::GET, "/api/hydrus/tags?search=dra")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(tags["tags"][0]["value"], "dra");
}

#[tokio::test]
async fn serves_a_thumbnail_once_and_then_from_its_cache() {
    let (s, calls) = proxying().await;
    let hash = sha256_hex(GOOD);
    for _ in 0..3 {
        let res = s
            .api(Method::GET, &format!("/api/hydrus/thumbnail/{hash}"))
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
        assert_eq!(res.headers()["cache-control"], "private, max-age=3600");
        assert_eq!(res.bytes().await.unwrap().as_ref(), b"thumb");
    }
    assert_eq!(calls.thumbnails.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn forwards_a_range_so_a_zip_can_be_read_in_pieces() {
    let (s, _) = proxying().await;
    let hash = sha256_hex(GOOD);
    let res = s
        .api(Method::GET, &format!("/api/hydrus/file/{hash}"))
        .header("Range", "bytes=0-3")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 206);
    assert_eq!(res.headers()["content-range"], "bytes 0-3/14");
    assert_eq!(res.bytes().await.unwrap().as_ref(), &GOOD[..4]);
}

#[tokio::test]
async fn validates_hashes_and_bounds_the_batches() {
    let (s, _) = proxying().await;
    for path in ["/api/hydrus/thumbnail/nope", "/api/hydrus/file/nope"] {
        assert_eq!(
            s.api(Method::GET, path).send().await.unwrap().status(),
            400,
            "{path}"
        );
    }
    // A full explorer page must pass; only something far larger is refused.
    let page: Vec<String> = (0..1000).map(|_| sha256_hex(GOOD)).collect();
    let ok = s
        .api(Method::POST, "/api/hydrus/metadata")
        .json(&json!({ "hashes": page }))
        .send()
        .await
        .unwrap();
    assert_eq!(ok.status(), 200);

    let absurd: Vec<String> = (0..2000).map(|_| sha256_hex(GOOD)).collect();
    let res = s
        .api(Method::POST, "/api/hydrus/metadata")
        .json(&json!({ "hashes": absurd }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 400);

    let bad = s
        .api(Method::POST, "/api/hydrus/metadata")
        .json(&json!({ "hashes": ["not-a-hash"] }))
        .send()
        .await
        .unwrap();
    assert_eq!(bad.status(), 400);

    let long = s
        .api(Method::POST, "/api/hydrus/search")
        .json(&json!({ "tags": ["x".repeat(300)] }))
        .send()
        .await
        .unwrap();
    assert_eq!(long.status(), 400);
}

#[tokio::test]
async fn says_not_implemented_for_every_operation_without_hydrus() {
    let s = start(&[]).await;
    let hash = sha256_hex(GOOD);
    for (method, path) in [
        (Method::GET, "/api/hydrus/verify".to_string()),
        (Method::GET, "/api/hydrus/services".to_string()),
        (Method::GET, "/api/hydrus/tags?search=a".to_string()),
        (Method::GET, format!("/api/hydrus/thumbnail/{hash}")),
        (Method::GET, format!("/api/hydrus/file/{hash}")),
    ] {
        assert_eq!(
            s.api(method, &path).send().await.unwrap().status(),
            501,
            "{path}"
        );
    }
}

#[tokio::test]
async fn reports_an_upstream_refusal_without_its_body() {
    let (url, _) = stub_counting().await;
    let s = start(&[
        ("DM_SCREEN_HYDRUS_URL", &url),
        ("DM_SCREEN_HYDRUS_KEY", "wrong-key"),
    ])
    .await;
    let res = s
        .api(Method::GET, "/api/hydrus/verify")
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
    let text = res.text().await.unwrap();
    assert!(
        !text.contains("wrong-key") && !text.contains("127.0.0.1"),
        "{text}"
    );
}

#[tokio::test]
async fn asks_upstream_for_metadata_in_batches_and_joins_the_answers() {
    let (s, calls) = proxying().await;
    // A full explorer page: as one query this is tens of kilobytes, which an
    // HTTP server refuses in a request line.
    let page: Vec<String> = (0..200u32).map(|i| format!("{i:064x}")).collect();
    let body: Value = s
        .api(Method::POST, "/api/hydrus/metadata")
        .json(&json!({ "hashes": page.clone() }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();

    let rows = body["metadata"].as_array().unwrap();
    assert_eq!(rows.len(), 200);
    assert_eq!(rows[0]["hash"], page[0]);
    assert_eq!(rows[199]["hash"], page[199]);
    // 200 hashes in batches of 64.
    assert_eq!(calls.metadata.load(Ordering::SeqCst), 4);
    assert!(calls.longest_query.load(Ordering::SeqCst) < 8192);
}
