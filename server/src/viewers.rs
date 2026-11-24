use crate::auth::{Role, request_token, role_for};
use crate::protocol::{self, Channel, PROTOCOL_VERSION};
use crate::state::{AppState, Outbound, Tx, Viewer};
use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::mpsc;

pub const MAX_VIEWER_FRAME: usize = 64 * 1024;
pub const MAX_VIEWER_MESSAGES_PER_SECOND: u32 = 20;

type Upgrade = Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>;

pub fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
        "Unauthorized",
    )
        .into_response()
}

pub fn viewer_role(state: &AppState, uri: &axum::http::Uri, headers: &HeaderMap) -> Option<Role> {
    role_for(
        &request_token(uri.query(), headers),
        &state.config.view_token,
        &state.config.control_token,
    )
}

// WebSockets are exempt from CORS, so a page on any origin could otherwise
// open one from inside a player's browser. A missing Origin (non-browser
// clients) passes; a present one must match Host.
pub fn origin_ok(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return true;
    };
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin_host = url::Url::parse(origin)
        .ok()
        .map(|u| match (u.host_str(), u.port()) {
            (Some(h), Some(p)) => format!("{h}:{p}"),
            (Some(h), None) => h.to_string(),
            _ => String::new(),
        });
    !host.is_empty() && origin_host.as_deref() == Some(host)
}

pub async fn close_with(mut socket: WebSocket, code: u16, reason: &str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}

// After the server sends Close, keep reading until the client answers it (two
// seconds at most): a socket dropped with unread input is reset by the kernel,
// and the client then never sees the close code.
pub async fn drain(stream: &mut futures_util::stream::SplitStream<WebSocket>) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
        while let Some(Ok(msg)) = stream.next().await {
            if matches!(msg, Message::Close(_)) {
                break;
            }
        }
    })
    .await;
}

// Forwards queued frames to the socket until the queue closes or a Close goes out.
pub fn spawn_writer(
    mut sink: futures_util::stream::SplitSink<WebSocket, Message>,
) -> (Tx, tokio::task::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<Outbound>();
    let handle = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let (msg, done) = match out {
                Outbound::Text(t) => (Message::Text(t.into()), false),
                Outbound::Close(code, reason) => (
                    Message::Close(Some(CloseFrame {
                        code,
                        reason: reason.into(),
                    })),
                    true,
                ),
            };
            if sink.send(msg).await.is_err() || done {
                break;
            }
        }
    });
    (tx, handle)
}

pub struct RateWindow {
    start: Instant,
    count: u32,
    limit: u32,
}

impl RateWindow {
    pub fn new(limit: u32) -> Self {
        RateWindow {
            start: Instant::now(),
            count: 0,
            limit,
        }
    }

    // Fixed one-second windows, as websocket-protocol.md requirement 13 counts them.
    pub fn exceeded(&mut self) -> bool {
        if self.start.elapsed().as_millis() > 1000 {
            self.start = Instant::now();
            self.count = 0;
        }
        self.count += 1;
        self.count > self.limit
    }
}

fn page(body: String, token: &str) -> Response {
    let cookie = format!(
        "dmScreenKey={}; Path=/; SameSite=Strict; Max-Age=86400",
        percent_encoding::utf8_percent_encode(token, percent_encoding::NON_ALPHANUMERIC)
    );
    let mut res = ([(header::CONTENT_TYPE, "text/html; charset=utf-8")], body).into_response();
    if let Ok(v) = HeaderValue::from_str(&cookie) {
        res.headers_mut().insert(header::SET_COOKIE, v);
    }
    res
}

fn waiting_text(state: &AppState) -> (String, String) {
    let s = state.session();
    let payload = s
        .replay
        .get("waiting-screen")
        .and_then(|d| serde_json::from_str::<Value>(d).ok())
        .and_then(|m| m.get("payload").cloned());
    let text = |k: &str, d: &str| {
        payload
            .as_ref()
            .and_then(|p| p.get(k))
            .and_then(Value::as_str)
            .unwrap_or(d)
            .to_string()
    };
    (
        text("title", protocol::DEFAULT_WAITING_TITLE),
        text("subtitle", protocol::DEFAULT_WAITING_SUBTITLE),
    )
}

pub async fn player_page(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    if let Ok(ws) = ws {
        return upgrade(state, uri, headers, ws, Channel::Player);
    }
    if viewer_role(&state, &uri, &headers).is_none() {
        return unauthorized();
    }
    let (title, subtitle) = waiting_text(&state);
    page(
        protocol::player_page(&title, &subtitle),
        &request_token(uri.query(), &headers),
    )
}

pub async fn map_page(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    if let Ok(ws) = ws {
        return upgrade(state, uri, headers, ws, Channel::Map);
    }
    if viewer_role(&state, &uri, &headers).is_none() {
        return unauthorized();
    }
    page(
        protocol::MAP_HTML.to_string(),
        &request_token(uri.query(), &headers),
    )
}

pub fn static_file(
    state: &AppState,
    uri: &axum::http::Uri,
    headers: &HeaderMap,
    body: &'static str,
    kind: &'static str,
) -> Response {
    if viewer_role(state, uri, headers).is_none() {
        return unauthorized();
    }
    ([(header::CONTENT_TYPE, kind)], body).into_response()
}

pub async fn health(State(state): State<Arc<AppState>>) -> Response {
    let clients = state.session().viewers.len();
    axum::Json(json!({ "status": "ok", "clients": clients, "protocol": PROTOCOL_VERSION, "version": protocol::version() })).into_response()
}

// Like the embedded server, the upgrade is always accepted and a refused
// client is then closed with a code, which is what browsers can observe.
fn upgrade(
    state: Arc<AppState>,
    uri: axum::http::Uri,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    channel: Channel,
) -> Response {
    let authorized = viewer_role(&state, &uri, &headers).is_some();
    let origin = origin_ok(&headers);
    ws.max_message_size(1024 * 1024)
        .on_upgrade(move |socket| async move {
            if !authorized || !origin {
                tracing::warn!(authorized, origin, "viewer handshake refused");
                return close_with(socket, 1008, "Unauthorized").await;
            }
            run_viewer(state, socket, channel).await
        })
}

async fn run_viewer(state: Arc<AppState>, socket: WebSocket, channel: Channel) {
    let (sink, mut stream) = socket.split();
    let (tx, writer) = spawn_writer(sink);
    let id = state.next_id();
    let admitted = {
        let mut s = state.session();
        if s.viewers.len() >= state.config.max_clients {
            let _ = tx.send(Outbound::Close(1013, "Max clients reached".into()));
            false
        } else {
            // Replay inside the lock: no relay can slip between the cached
            // state and the client's registration.
            for data in s.replay.of_channel(channel) {
                let _ = tx.send(Outbound::Text(data.clone()));
            }
            s.viewers.insert(
                id,
                Viewer {
                    channel,
                    tx: tx.clone(),
                    info: None,
                },
            );
            s.send_screens();
            tracing::debug!(id, ?channel, total = s.viewers.len(), "viewer connected");
            true
        }
    };
    if !admitted {
        drop(tx);
        let _ = writer.await;
        return;
    }

    let mut rate = RateWindow::new(MAX_VIEWER_MESSAGES_PER_SECOND);
    let mut closing = false;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Binary(b) => String::from_utf8_lossy(&b).into_owned(),
            Message::Close(_) => break,
            _ => continue,
        };
        if text.len() > MAX_VIEWER_FRAME {
            let _ = tx.send(Outbound::Close(1009, "Message too big".into()));
            closing = true;
            break;
        }
        if rate.exceeded() {
            tracing::warn!(id, "viewer exceeded the message rate");
            let _ = tx.send(Outbound::Close(1008, "Rate limit".into()));
            closing = true;
            break;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if parsed.get("type").and_then(Value::as_str) == Some("client-info") {
            let mut s = state.session();
            if let Some(v) = s.viewers.get_mut(&id) {
                v.info = parsed.get("payload").cloned();
            }
            s.send_screens();
        }
    }

    {
        let mut s = state.session();
        s.viewers.remove(&id);
        s.send_screens();
    }
    drop(tx);
    let _ = writer.await;
    if closing {
        drain(&mut stream).await;
    }
}
