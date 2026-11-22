// Must equal PROTOCOL_VERSION in src/protocol.ts; a controller with another
// value is refused at the handshake instead of being misread.
pub const PROTOCOL_VERSION: u32 = 1;

pub const VERSION: &str = include_str!("../assets/version.txt");

pub const PLAYER_HTML: &str = include_str!("../assets/player.html");
pub const PLAYER_JS: &str = include_str!("../assets/player.js");
pub const PLAYER_CSS: &str = include_str!("../assets/player.css");
pub const MAP_HTML: &str = include_str!("../assets/map.html");
pub const MAP_JS: &str = include_str!("../assets/map.js");
pub const MAP_CSS: &str = include_str!("../assets/map.css");

// Slots scripts/export-screens.mjs leaves in player.html.
pub const TITLE_SLOT: &str = "{{DM_SCREEN_TITLE_HTML}}";
pub const SUBTITLE_SLOT: &str = "{{DM_SCREEN_SUBTITLE_HTML}}";

pub const DEFAULT_WAITING_TITLE: &str = "Player Screen";
pub const DEFAULT_WAITING_SUBTITLE: &str = "Waiting for DM to push content...";

#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Player,
    Map,
}

pub fn message_channel(kind: &str) -> Channel {
    if kind.starts_with("map-") {
        Channel::Map
    } else {
        Channel::Player
    }
}

pub fn escape_html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

pub fn player_page(title: &str, subtitle: &str) -> String {
    let title_html = if title.is_empty() {
        String::new()
    } else {
        format!("<h1>{}</h1>", escape_html(title))
    };
    let subtitle_html = if subtitle.is_empty() {
        String::new()
    } else {
        format!("<p>{}</p>", escape_html(subtitle))
    };
    PLAYER_HTML
        .replace(TITLE_SLOT, &title_html)
        .replace(SUBTITLE_SLOT, &subtitle_html)
}

pub fn version() -> &'static str {
    VERSION.trim()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes_map_prefixed_types_to_the_map_channel() {
        assert_eq!(message_channel("map-view"), Channel::Map);
        assert_eq!(message_channel("image-layers-sync"), Channel::Player);
        assert_eq!(message_channel("clear"), Channel::Player);
    }

    #[test]
    fn fills_and_escapes_the_waiting_slots() {
        let page = player_page("A <b>&", "");
        assert!(page.contains("<h1>A &lt;b&gt;&amp;</h1>"));
        assert!(!page.contains("<p>"));
        assert!(!page.contains(TITLE_SLOT) && !page.contains(SUBTITLE_SLOT));
    }
}
