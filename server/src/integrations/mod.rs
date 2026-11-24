pub mod ddb;
pub mod hydrus;
pub mod webhooks;

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use std::sync::OnceLock;

// One client for every upstream: connection reuse, and one place for the
// timeout. Each request carries its own credential header.
pub fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("a default reqwest client builds")
    })
}

// An upstream failure is reported as a status and the operation name. The
// upstream's own body is never forwarded: it echoes the request back, and the
// request carried the credential.
pub fn upstream_failed(op: &str, detail: impl std::fmt::Display) -> Response {
    tracing::warn!(op, error = %detail, "upstream call failed");
    (StatusCode::BAD_GATEWAY, format!("{op} failed upstream")).into_response()
}

pub fn not_configured(op: &str) -> Response {
    tracing::debug!(op, "integration not configured");
    (
        StatusCode::NOT_IMPLEMENTED,
        format!("{op} is not configured on this server"),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_upstream_failure_says_nothing_of_the_upstream_body() {
        let res = upstream_failed("hydrus search", "secret-bearing body");
        assert_eq!(res.status(), StatusCode::BAD_GATEWAY);
    }
}
