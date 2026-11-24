mod common;

use common::{VIEW, sha256_hex, start};
use reqwest::Method;
use serde_json::{Value, json};

#[tokio::test]
async fn stores_an_upload_by_hash_and_finds_it_again_by_fingerprint() {
    let s = start(&[]).await;
    let fp = json!({ "path": "Maps/a.png", "size": 5, "mtime": 42 });
    let created: Value = s
        .api(Method::POST, "/api/uploads")
        .json(&json!({ "size": 5, "ext": "PNG", "fingerprint": fp }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(created["chunkSize"], 8 * 1024 * 1024);
    let id = created["id"].as_str().unwrap();
    for (offset, chunk) in [(0, &b"hel"[..]), (3, &b"lo"[..])] {
        let res = s
            .api(Method::PUT, &format!("/api/uploads/{id}?offset={offset}"))
            .body(chunk.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 200);
    }
    let done: Value = s
        .api(Method::POST, &format!("/api/uploads/{id}/complete"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let sha = sha256_hex(b"hello");
    assert_eq!(done, json!({ "sha256": sha, "ext": "png" }));

    let meta: Value = s
        .api(Method::GET, &format!("/api/assets/{sha}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(meta, json!({ "sha256": sha, "ext": "png", "size": 5 }));
    let hit = s
        .api(Method::POST, "/api/assets/lookup")
        .json(&fp)
        .send()
        .await
        .unwrap();
    assert_eq!(
        hit.json::<Value>().await.unwrap(),
        json!({ "sha256": sha, "ext": "png" })
    );
    let miss = s
        .api(Method::POST, "/api/assets/lookup")
        .json(&json!({ "path": "Maps/a.png", "size": 5, "mtime": 43 }))
        .send()
        .await
        .unwrap();
    assert_eq!(miss.status(), 404);
}

#[tokio::test]
async fn answers_the_offset_it_has_on_a_wrong_chunk_and_resumes() {
    let s = start(&[]).await;
    let created: Value = s
        .api(Method::POST, "/api/uploads")
        .json(&json!({ "size": 4, "ext": "png" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    s.api(Method::PUT, &format!("/api/uploads/{id}?offset=0"))
        .body(b"ab".to_vec())
        .send()
        .await
        .unwrap();
    let wrong = s
        .api(Method::PUT, &format!("/api/uploads/{id}?offset=0"))
        .body(b"ab".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 409);
    assert_eq!(
        wrong.json::<Value>().await.unwrap(),
        json!({ "received": 2 })
    );
    let ok = s
        .api(Method::PUT, &format!("/api/uploads/{id}?offset=2"))
        .body(b"cd".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(ok.json::<Value>().await.unwrap(), json!({ "received": 4 }));
}

#[tokio::test]
async fn discards_an_upload_whose_size_does_not_match() {
    let s = start(&[]).await;
    let created: Value = s
        .api(Method::POST, "/api/uploads")
        .json(&json!({ "size": 10, "ext": "png" }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let id = created["id"].as_str().unwrap();
    s.api(Method::PUT, &format!("/api/uploads/{id}?offset=0"))
        .body(b"short".to_vec())
        .send()
        .await
        .unwrap();
    assert_eq!(
        s.api(Method::POST, &format!("/api/uploads/{id}/complete"))
            .send()
            .await
            .unwrap()
            .status(),
        422
    );
    assert_eq!(
        s.api(Method::POST, &format!("/api/uploads/{id}/complete"))
            .send()
            .await
            .unwrap()
            .status(),
        404
    );
}

#[tokio::test]
async fn enforces_extension_size_and_concurrency_limits() {
    let s = start(&[("DM_SCREEN_MAX_ASSET_MB", "1")]).await;
    let create = |size: u64, ext: &str| {
        s.api(Method::POST, "/api/uploads")
            .json(&json!({ "size": size, "ext": ext }))
            .send()
    };
    assert_eq!(create(1, "svg").await.unwrap().status(), 415);
    assert_eq!(create(2 * 1024 * 1024, "png").await.unwrap().status(), 413);
    for _ in 0..4 {
        assert_eq!(create(1, "png").await.unwrap().status(), 201);
    }
    assert_eq!(create(1, "png").await.unwrap().status(), 429);
}

#[tokio::test]
async fn keeps_the_api_and_unlisted_assets_away_from_the_view_token() {
    let s = start(&[]).await;
    let name = s.upload(b"secret", "png").await;
    let api = s
        .http
        .get(format!("{}/api/mapdata", s.base))
        .bearer_auth(VIEW)
        .send()
        .await
        .unwrap();
    assert_eq!(api.status(), 401);
    let viewer = s
        .http
        .get(format!("{}/assets/{name}?k={VIEW}", s.base))
        .send()
        .await
        .unwrap();
    assert_eq!(viewer.status(), 404);
    let controller = s
        .http
        .get(format!("{}/assets/{name}?k={}", s.base, common::CONTROL))
        .send()
        .await
        .unwrap();
    assert_eq!(controller.status(), 200);
    assert_eq!(controller.bytes().await.unwrap().as_ref(), b"secret");
}

#[tokio::test]
async fn a_retention_sweep_spares_what_the_cache_references() {
    let s = start(&[("DM_SCREEN_ASSET_RETENTION_DAYS", "0")]).await;
    let kept = s.upload(b"kept", "png").await;
    let gone = s.upload(b"gone", "png").await;
    let msg = json!({ "type": "map-show", "payload": { "url": format!("/assets/{kept}") } });
    s.state.relay(&msg).unwrap();
    std::thread::sleep(std::time::Duration::from_millis(1100));
    dm_screen_server::collect_garbage(&s.state);
    let status = |name: String| {
        s.api(Method::GET, &format!("/api/assets/{}", &name[..64]))
            .send()
    };
    assert_eq!(status(kept).await.unwrap().status(), 200);
    assert_eq!(status(gone).await.unwrap().status(), 404);
}
