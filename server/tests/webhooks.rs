mod common;

use axum::body::Bytes;
use axum::http::StatusCode;
use axum::routing::post;
use common::start;
use reqwest::Method;
use serde_json::json;
use std::sync::{Arc, Mutex};

const IMAGE: &[u8] = b"\x89PNG-pretend";

#[derive(Default)]
struct Captured {
    bodies: Mutex<Vec<String>>,
}

// A stand-in webhook target that records what it was sent, and fails on the
// path that spells failure.
async fn stub() -> (String, Arc<Captured>) {
    let captured = Arc::new(Captured::default());
    let sink = captured.clone();
    let app = axum::Router::new()
        .route(
            "/botTOKEN/sendPhoto",
            post(move |body: Bytes| {
                let sink = sink.clone();
                async move {
                    sink.bodies
                        .lock()
                        .unwrap()
                        .push(String::from_utf8_lossy(&body).into_owned());
                    StatusCode::OK
                }
            }),
        )
        .route(
            "/botTOKEN/broken",
            post(|| async { StatusCode::IM_A_TEAPOT }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (url, captured)
}

fn targets(base: &str) -> String {
    json!([
        {
            "name": "Telegram",
            "url": format!("{base}/botTOKEN/sendPhoto"),
            "imageField": "photo",
            "captionField": "caption",
            "extraFields": [{ "key": "chat_id", "value": "7" }]
        },
        {
            "name": "Broken",
            "url": format!("{base}/botTOKEN/broken"),
            "imageField": "photo",
            "captionField": "caption"
        }
    ])
    .to_string()
}

#[tokio::test]
async fn posts_the_stored_asset_with_the_target_fields() {
    let (base, captured) = stub().await;
    let s = start(&[("DM_SCREEN_WEBHOOKS", &targets(&base))]).await;
    let asset = s.upload(IMAGE, "png").await;

    let res = s
        .api(Method::POST, "/api/webhooks/Telegram/send")
        .json(&json!({ "asset": format!("/assets/{asset}"), "caption": "A dragon" }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 204);

    let bodies = captured.bodies.lock().unwrap();
    assert_eq!(bodies.len(), 1);
    let body = &bodies[0];
    assert!(body.contains(r#"name="photo""#), "{body}");
    assert!(body.contains(r#"name="caption""#) && body.contains("A dragon"));
    assert!(body.contains(r#"name="chat_id""#) && body.contains('7'.to_string().as_str()));
    assert!(body.contains("PNG-pretend"));
}

#[tokio::test]
async fn refuses_an_unknown_target_without_calling_anything() {
    let (base, captured) = stub().await;
    let s = start(&[("DM_SCREEN_WEBHOOKS", &targets(&base))]).await;
    let asset = s.upload(IMAGE, "png").await;
    let res = s
        .api(Method::POST, "/api/webhooks/Nope/send")
        .json(&json!({ "asset": format!("/assets/{asset}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 404);
    assert!(captured.bodies.lock().unwrap().is_empty());
}

#[tokio::test]
async fn sends_only_a_stored_asset_and_a_bounded_caption() {
    let (base, _) = stub().await;
    let s = start(&[("DM_SCREEN_WEBHOOKS", &targets(&base))]).await;
    let asset = s.upload(IMAGE, "png").await;

    for body in [
        json!({ "asset": "https://example.com/cat.png" }),
        json!({ "asset": "data:image/png;base64,AA==" }),
        json!({ "asset": format!("/assets/{}.png", "b".repeat(64)) }),
        json!({ "asset": format!("/assets/{asset}"), "caption": "x".repeat(1025) }),
    ] {
        let res = s
            .api(Method::POST, "/api/webhooks/Telegram/send")
            .json(&body)
            .send()
            .await
            .unwrap();
        assert_eq!(res.status(), 400, "{body}");
    }
}

#[tokio::test]
async fn paces_sends_to_one_a_second_per_target() {
    let (base, _) = stub().await;
    let s = start(&[("DM_SCREEN_WEBHOOKS", &targets(&base))]).await;
    let asset = s.upload(IMAGE, "png").await;
    let send = |name: &str| {
        s.api(Method::POST, &format!("/api/webhooks/{name}/send"))
            .json(&json!({ "asset": format!("/assets/{asset}") }))
            .send()
    };
    assert_eq!(send("Telegram").await.unwrap().status(), 204);
    assert_eq!(send("Telegram").await.unwrap().status(), 429);
    // A different target is paced on its own.
    assert_eq!(send("Broken").await.unwrap().status(), 502);
}

#[tokio::test]
async fn reports_an_upstream_refusal_without_its_body_or_url() {
    let (base, _) = stub().await;
    let s = start(&[("DM_SCREEN_WEBHOOKS", &targets(&base))]).await;
    let asset = s.upload(IMAGE, "png").await;
    let res = s
        .api(Method::POST, "/api/webhooks/Broken/send")
        .json(&json!({ "asset": format!("/assets/{asset}") }))
        .send()
        .await
        .unwrap();
    assert_eq!(res.status(), 502);
    let text = res.text().await.unwrap();
    assert!(
        !text.contains("botTOKEN") && !text.contains("127.0.0.1"),
        "{text}"
    );
}
