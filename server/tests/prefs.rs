mod common;

use common::{VIEW, start};
use reqwest::Method;
use serde_json::{Value, json};

#[tokio::test]
async fn stores_a_known_preference_and_returns_the_document() {
    let s = start(&[]).await;
    assert_eq!(
        s.api(Method::GET, "/api/prefs")
            .send()
            .await
            .unwrap()
            .json::<Value>()
            .await
            .unwrap(),
        json!({})
    );

    let put = s
        .api(Method::PUT, "/api/prefs/hydrusDefaultLoop")
        .json(&json!(false))
        .send()
        .await
        .unwrap();
    assert_eq!(put.status(), 204);
    s.api(Method::PUT, "/api/prefs/hydrusTagServices")
        .json(&json!(["my tags"]))
        .send()
        .await
        .unwrap();

    let doc: Value = s
        .api(Method::GET, "/api/prefs")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(
        doc,
        json!({ "hydrusDefaultLoop": false, "hydrusTagServices": ["my tags"] })
    );
}

#[tokio::test]
async fn refuses_an_unknown_key_and_a_value_of_the_wrong_shape() {
    let s = start(&[]).await;
    let unknown = s
        .api(Method::PUT, "/api/prefs/hydrusApiKey")
        .json(&json!("secret"))
        .send()
        .await
        .unwrap();
    assert_eq!(unknown.status(), 404);

    let wrong = s
        .api(Method::PUT, "/api/prefs/mapDefaultPxPerSquare")
        .json(&json!("140"))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong.status(), 400);

    let doc: Value = s
        .api(Method::GET, "/api/prefs")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(doc, json!({}));
}

#[tokio::test]
async fn keeps_the_view_token_out_of_the_preferences() {
    let s = start(&[]).await;
    let read = s
        .http
        .get(format!("{}/api/prefs", s.base))
        .bearer_auth(VIEW)
        .send()
        .await
        .unwrap();
    assert_eq!(read.status(), 401);
}

#[tokio::test]
async fn survives_a_restart_and_drops_what_it_no_longer_knows() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().to_path_buf();
    {
        let s = common::start_in(&path, &[]).await;
        s.api(Method::PUT, "/api/prefs/ddbInspirationPulse")
            .json(&json!(false))
            .send()
            .await
            .unwrap();
        // The test router has no background writer, so flush by hand.
        dm_screen_server::persist::flush(&s.state);
    }
    // A key this version does not know, as a downgrade would leave behind.
    let state_file = path.join("state/prefs.json");
    let mut doc: serde_json::Map<String, Value> =
        serde_json::from_slice(&std::fs::read(&state_file).unwrap()).unwrap();
    doc.insert("somethingOld".into(), json!(1));
    std::fs::write(&state_file, serde_json::to_vec(&doc).unwrap()).unwrap();

    let again = common::start_in(&path, &[]).await;
    let back: Value = again
        .api(Method::GET, "/api/prefs")
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(back, json!({ "ddbInspirationPulse": false }));
}
