use axum::http::HeaderMap;
use sha2::{Digest, Sha256};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    View,
    Control,
}

// Comparing digests makes the check independent of the candidate's length and
// content, so response timing reveals nothing about the token.
fn same(secret: &str, candidate: &str) -> bool {
    if secret.is_empty() || candidate.is_empty() {
        return false;
    }
    let a = Sha256::digest(secret.as_bytes());
    let b = Sha256::digest(candidate.as_bytes());
    a.iter()
        .zip(b.iter())
        .fold(0u8, |acc, (x, y)| acc | (x ^ y))
        == 0
}

pub fn role_for(token: &str, view: &str, control: &str) -> Option<Role> {
    if same(control, token) {
        Some(Role::Control)
    } else if same(view, token) {
        Some(Role::View)
    } else {
        None
    }
}

pub fn query_param(query: Option<&str>, name: &str) -> Option<String> {
    url::form_urlencoded::parse(query.unwrap_or("").as_bytes())
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.into_owned())
}

fn cookie_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers
        .get_all(axum::http::header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .collect::<Vec<_>>()
        .join("; ");
    raw.split(';')
        .map(str::trim)
        .find_map(|c| c.strip_prefix("dmScreenKey="))
        .and_then(|v| {
            percent_encoding::percent_decode_str(v)
                .decode_utf8()
                .ok()
                .map(|s| s.into_owned())
        })
}

// `k` first, then the cookie, as the embedded server does.
pub fn request_token(query: Option<&str>, headers: &HeaderMap) -> String {
    query_param(query, "k")
        .filter(|k| !k.is_empty())
        .or_else(|| cookie_token(headers))
        .unwrap_or_default()
}

// /api/ also accepts `Authorization: Bearer`, which keeps the token out of
// URLs the plugin builds for uploads.
pub fn api_token(query: Option<&str>, headers: &HeaderMap) -> String {
    headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(str::to_string)
        .unwrap_or_else(|| request_token(query, headers))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_the_two_tokens_apart_and_fails_closed() {
        assert_eq!(role_for("c", "v", "c"), Some(Role::Control));
        assert_eq!(role_for("v", "v", "c"), Some(Role::View));
        assert_eq!(role_for("vv", "v", "c"), None);
        assert_eq!(role_for("", "v", "c"), None);
        assert_eq!(role_for("x", "", ""), None);
    }

    #[test]
    fn reads_the_query_before_the_cookie() {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::COOKIE,
            "a=1; dmScreenKey=fromcookie%21".parse().unwrap(),
        );
        assert_eq!(request_token(Some("k=fromquery"), &h), "fromquery");
        assert_eq!(request_token(Some("x=1"), &h), "fromcookie!");
        assert_eq!(request_token(None, &HeaderMap::new()), "");
    }

    #[test]
    fn prefers_a_bearer_header_on_the_api() {
        let mut h = HeaderMap::new();
        h.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer tok".parse().unwrap(),
        );
        assert_eq!(api_token(Some("k=other"), &h), "tok");
    }
}
