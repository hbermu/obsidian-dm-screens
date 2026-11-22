use crate::auth::{Role, query_param, role_for};
use crate::protocol::{self, PROTOCOL_VERSION};
use crate::state::{AppState, ControlConn, Holder, Outbound, Session};
use crate::viewers::{RateWindow, close_with, drain, origin_ok, spawn_writer};
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{OriginalUri, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use serde_json::{Value, json};
use std::sync::Arc;

pub const MAX_CONTROL_FRAME: usize = 1024 * 1024;
pub const MAX_CONTROL_MESSAGES_PER_SECOND: u32 = 200;
pub const MAX_CONTROL_SOCKETS: usize = 4;
pub const PROTOCOL_MISMATCH: u16 = 4001;

type Upgrade = Result<WebSocketUpgrade, axum::extract::ws::rejection::WebSocketUpgradeRejection>;

struct Handshake {
    device: String,
    name: String,
}

enum Refusal {
    Close(u16, String),
}

fn check(state: &AppState, query: Option<&str>, headers: &HeaderMap) -> Result<Handshake, Refusal> {
    let token = query_param(query, "k").unwrap_or_default();
    if role_for(
        &token,
        &state.config.view_token,
        &state.config.control_token,
    ) != Some(Role::Control)
    {
        return Err(Refusal::Close(1008, "Unauthorized".into()));
    }
    if !origin_ok(headers) {
        return Err(Refusal::Close(1008, "Unauthorized".into()));
    }
    let device = query_param(query, "device").unwrap_or_default();
    let name = query_param(query, "name").unwrap_or_default();
    let device_ok = device.len() == 32
        && device
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
    if !device_ok || name.is_empty() || name.chars().count() > 64 {
        return Err(Refusal::Close(1008, "Bad device".into()));
    }
    if query_param(query, "protocol").as_deref() != Some(PROTOCOL_VERSION.to_string().as_str()) {
        return Err(Refusal::Close(
            PROTOCOL_MISMATCH,
            format!("protocol-mismatch:{PROTOCOL_VERSION}"),
        ));
    }
    Ok(Handshake { device, name })
}

pub async fn control(
    State(state): State<Arc<AppState>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    ws: Upgrade,
) -> Response {
    let Ok(ws) = ws else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let checked = check(&state, uri.query(), &headers);
    ws.max_message_size(2 * MAX_CONTROL_FRAME)
        .on_upgrade(move |socket| async move {
            match checked {
                Err(Refusal::Close(code, reason)) => {
                    tracing::warn!(code, "control handshake refused");
                    close_with(socket, code, &reason).await
                }
                Ok(h) => run_control(state, socket, h).await,
            }
        })
}

fn role_of(s: &Session, conn: &ControlConn) -> &'static str {
    if s.is_active(conn) {
        "active"
    } else {
        "readonly"
    }
}

fn hello(state: &AppState, s: &Session, conn: &ControlConn) -> String {
    let cache: serde_json::Map<String, Value> = s
        .replay
        .entries()
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(v.clone())))
        .collect();
    json!({
        "type": "control-hello",
        "payload": {
            "protocol": PROTOCOL_VERSION,
            "version": protocol::version(),
            "viewToken": state.config.view_token,
            "role": role_of(s, conn),
            "holder": s.holder,
            "hydrus": state.config.hydrus.is_some(),
            "cache": cache,
            "clients": s.clients(),
        }
    })
    .to_string()
}

fn send_roles(s: &Session) {
    for c in s.controls.values() {
        let msg = json!({ "type": "control-role", "payload": { "role": role_of(s, c), "holder": s.holder } }).to_string();
        let _ = c.tx.send(Outbound::Text(msg));
    }
}

fn error(code: &str) -> Outbound {
    Outbound::Text(json!({ "type": "control-error", "payload": { "code": code } }).to_string())
}

async fn run_control(state: Arc<AppState>, socket: WebSocket, h: Handshake) {
    let (sink, mut stream) = socket.split();
    let (tx, writer) = spawn_writer(sink);
    let id = state.next_id();
    let admitted = {
        let mut s = state.session();
        if s.controls.len() >= MAX_CONTROL_SOCKETS {
            let _ = tx.send(Outbound::Close(1013, "Too many controllers".into()));
            false
        } else {
            // The lease survives its holder's disconnection; the same device takes
            // it back silently, any other device must claim it.
            if s.holder.is_none() {
                s.holder = Some(Holder {
                    device_id: h.device.clone(),
                    name: h.name.clone(),
                });
            }
            let conn = ControlConn {
                device: h.device.clone(),
                tx: tx.clone(),
            };
            let _ = tx.send(Outbound::Text(hello(&state, &s, &conn)));
            s.controls.insert(id, conn);
            tracing::info!(
                id,
                active = s.holder.as_ref().is_some_and(|x| x.device_id == h.device),
                "controller connected"
            );
            true
        }
    };
    if !admitted {
        drop(tx);
        let _ = writer.await;
        return;
    }

    let mut rate = RateWindow::new(MAX_CONTROL_MESSAGES_PER_SECOND);
    let mut closing = false;
    while let Some(Ok(msg)) = stream.next().await {
        let text = match msg {
            Message::Text(t) => t.to_string(),
            Message::Close(_) => break,
            _ => continue,
        };
        if text.len() > MAX_CONTROL_FRAME {
            let _ = tx.send(Outbound::Close(1009, "Message too big".into()));
            closing = true;
            break;
        }
        if rate.exceeded() {
            tracing::warn!(id, "controller exceeded the message rate");
            let _ = tx.send(Outbound::Close(1008, "Rate limit".into()));
            closing = true;
            break;
        }
        let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
            let _ = tx.send(error("bad-message"));
            continue;
        };
        match parsed.get("type").and_then(Value::as_str) {
            Some("control-claim") => {
                let mut s = state.session();
                s.holder = Some(Holder {
                    device_id: h.device.clone(),
                    name: h.name.clone(),
                });
                send_roles(&s);
                tracing::info!(id, "control claimed");
            }
            Some("relay") => {
                let active = {
                    let s = state.session();
                    s.controls.get(&id).is_some_and(|c| s.is_active(c))
                };
                if !active {
                    let _ = tx.send(error("not-active"));
                    continue;
                }
                let message = parsed
                    .get("payload")
                    .and_then(|p| p.get("message"))
                    .cloned()
                    .unwrap_or(Value::Null);
                if let Err(code) = state.relay(&message) {
                    let _ = tx.send(error(code));
                }
            }
            _ => {
                let _ = tx.send(error("bad-message"));
            }
        }
    }

    state.session().controls.remove(&id);
    drop(tx);
    let _ = writer.await;
    if closing {
        drain(&mut stream).await;
    }
}
