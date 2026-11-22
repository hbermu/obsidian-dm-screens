#![allow(dead_code)]

use dm_screen_server::config::Config;
use std::collections::HashMap;
use std::sync::Arc;

pub const VIEW: &str = "view0123456789abcdef0123456789abcdef";
pub const CONTROL: &str = "ctrl0123456789abcdef0123456789abcdef";

pub struct Server {
    pub base: String,
    pub state: Arc<dm_screen_server::state::AppState>,
    pub dir: tempfile::TempDir,
    pub http: reqwest::Client,
}

pub async fn start(extra: &[(&str, &str)]) -> Server {
    let dir = tempfile::tempdir().unwrap();
    let mut env: HashMap<String, String> = HashMap::from([
        ("DM_SCREEN_VIEW_TOKEN".into(), VIEW.into()),
        ("DM_SCREEN_CONTROL_TOKEN".into(), CONTROL.into()),
        (
            "DM_SCREEN_DATA_DIR".into(),
            dir.path().display().to_string(),
        ),
    ]);
    for (k, v) in extra {
        env.insert(k.to_string(), v.to_string());
    }
    let config = Config::from_lookup(|k| env.get(k).cloned()).unwrap();
    let state = dm_screen_server::open(config).unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let app = dm_screen_server::router(state.clone());
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    Server {
        base,
        state,
        dir,
        http: reqwest::Client::new(),
    }
}

impl Server {
    pub fn api(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        self.http
            .request(method, format!("{}{path}", self.base))
            .bearer_auth(CONTROL)
    }

    pub async fn upload(&self, bytes: &[u8], ext: &str) -> String {
        let created: serde_json::Value = self
            .api(reqwest::Method::POST, "/api/uploads")
            .json(&serde_json::json!({ "size": bytes.len(), "ext": ext }))
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        let id = created["id"].as_str().unwrap().to_string();
        let put = self
            .api(reqwest::Method::PUT, &format!("/api/uploads/{id}?offset=0"))
            .body(bytes.to_vec())
            .send()
            .await
            .unwrap();
        assert_eq!(put.status(), 200);
        let done: serde_json::Value = self
            .api(
                reqwest::Method::POST,
                &format!("/api/uploads/{id}/complete"),
            )
            .send()
            .await
            .unwrap()
            .json()
            .await
            .unwrap();
        format!(
            "{}.{}",
            done["sha256"].as_str().unwrap(),
            done["ext"].as_str().unwrap()
        )
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    hex::encode(sha2::Sha256::digest(bytes))
}
