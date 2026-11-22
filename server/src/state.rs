use crate::allowlist::Allowlist;
use crate::assets::AssetStore;
use crate::config::Config;
use crate::derivatives::DerivativeCache;
use crate::mapdata::MapData;
use crate::persist;
use crate::protocol::{Channel, message_channel};
use crate::replay::ReplayCache;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};
use tokio::sync::{Notify, mpsc};

pub enum Outbound {
    Text(String),
    Close(u16, String),
}

pub type Tx = mpsc::UnboundedSender<Outbound>;

pub struct Viewer {
    pub channel: Channel,
    pub tx: Tx,
    pub info: Option<Value>,
}

pub struct ControlConn {
    pub device: String,
    pub tx: Tx,
}

#[derive(Clone, Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Holder {
    pub device_id: String,
    pub name: String,
}

#[derive(Default)]
pub struct Session {
    pub replay: ReplayCache,
    pub allowlist: Allowlist,
    pub viewers: HashMap<u64, Viewer>,
    pub controls: HashMap<u64, ControlConn>,
    pub holder: Option<Holder>,
    pub mapdata: MapData,
}

impl Session {
    pub fn is_active(&self, conn: &ControlConn) -> bool {
        self.holder
            .as_ref()
            .is_some_and(|h| h.device_id == conn.device)
    }

    pub fn clients(&self) -> Vec<Value> {
        self.viewers
            .values()
            .filter_map(|v| {
                let info = v.info.as_ref()?;
                Some(json!({
                    "width": info.get("width").cloned().unwrap_or(Value::Null),
                    "height": info.get("height").cloned().unwrap_or(Value::Null),
                    "devicePixelRatio": info.get("devicePixelRatio").cloned().unwrap_or(Value::Null),
                    "channel": v.channel,
                }))
            })
            .collect()
    }

    pub fn send_screens(&self) {
        let msg =
            json!({ "type": "screens", "payload": { "clients": self.clients() } }).to_string();
        for c in self.controls.values() {
            let _ = c.tx.send(Outbound::Text(msg.clone()));
        }
    }
}

pub struct AppState {
    pub config: Config,
    session: Mutex<Session>,
    next_id: AtomicU64,
    pub assets: AssetStore,
    pub derivatives: DerivativeCache,
    pub dirty: Notify,
}

impl AppState {
    pub fn new(config: Config, session: Session, assets: AssetStore) -> AppState {
        let derivatives = DerivativeCache::new(&config);
        AppState {
            config,
            session: Mutex::new(session),
            next_id: AtomicU64::new(1),
            assets,
            derivatives,
            dirty: Notify::new(),
        }
    }

    pub fn session(&self) -> MutexGuard<'_, Session> {
        self.session.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn next_id(&self) -> u64 {
        self.next_id.fetch_add(1, Ordering::Relaxed)
    }

    pub fn mark_dirty(&self) {
        self.dirty.notify_one();
    }

    // What PlayerScreenServer.broadcast does for one message: allowlist, cache,
    // fan-out to the message's channel; then mirror it to read-only controllers.
    pub fn relay(&self, message: &Value) -> Result<(), &'static str> {
        let kind = message
            .get("type")
            .and_then(Value::as_str)
            .ok_or("bad-message")?;
        let payload = message
            .get("payload")
            .filter(|p| p.is_object())
            .ok_or("bad-message")?;
        let data = message.to_string();
        let channel = message_channel(kind);
        {
            let mut s = self.session();
            s.allowlist.observe(kind, payload);
            s.replay.record(kind, data.clone());
            for v in s.viewers.values().filter(|v| v.channel == channel) {
                let _ = v.tx.send(Outbound::Text(data.clone()));
            }
            let mirror = json!({ "type": "mirror", "payload": { "message": message } }).to_string();
            for c in s.controls.values().filter(|c| !s.is_active(c)) {
                let _ = c.tx.send(Outbound::Text(mirror.clone()));
            }
        }
        self.assets.touch_referenced(&data);
        self.mark_dirty();
        tracing::debug!(kind, channel = ?channel, bytes = data.len(), "relay");
        Ok(())
    }

    pub fn snapshot(&self) -> persist::Snapshot {
        let s = self.session();
        persist::Snapshot {
            replay: s.replay.entries().clone(),
            mapdata: s.mapdata.clone(),
            assets: self.assets.index_snapshot(),
        }
    }
}
