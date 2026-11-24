use dm_screen_server::config::Config;
use dm_screen_server::{open, persist, protocol, router, spawn_background};
use tracing_subscriber::EnvFilter;

// The container's HEALTHCHECK: the runtime image ships no HTTP client.
fn healthcheck() -> ! {
    use std::io::{Read, Write};
    let port = std::env::var("DM_SCREEN_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .unwrap_or(8080);
    let ok = std::net::TcpStream::connect(("127.0.0.1", port))
        .and_then(|mut s| {
            s.set_read_timeout(Some(std::time::Duration::from_secs(3)))?;
            s.write_all(b"GET /health HTTP/1.0\r\nHost: localhost\r\n\r\n")?;
            let mut buf = String::new();
            s.read_to_string(&mut buf)?;
            Ok(buf.starts_with("HTTP/1.0 200") || buf.starts_with("HTTP/1.1 200"))
        })
        .unwrap_or(false);
    std::process::exit(if ok { 0 } else { 1 });
}

#[tokio::main]
async fn main() {
    if std::env::args().nth(1).as_deref() == Some("healthcheck") {
        healthcheck();
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = match Config::from_lookup(|k| std::env::var(k).ok()) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("dm-screen-server: {e}");
            std::process::exit(2);
        }
    };
    let port = config.port;
    let state = match open(config) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("dm-screen-server: cannot open the data directory: {e}");
            std::process::exit(1);
        }
    };
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("dm-screen-server: cannot listen on port {port}: {e}");
            std::process::exit(1);
        }
    };
    let addr = listener
        .local_addr()
        .expect("a bound listener has an address");
    // The conformance driver starts the server on port 0 and reads this line.
    println!(
        "dm-screen-server {} listening on {addr}",
        protocol::version()
    );
    spawn_background(state.clone());

    let shutdown = async {
        let ctrl_c = tokio::signal::ctrl_c();
        #[cfg(unix)]
        {
            let mut term =
                tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                    .expect("SIGTERM handler");
            tokio::select! { _ = ctrl_c => {}, _ = term.recv() => {} }
        }
        #[cfg(not(unix))]
        let _ = ctrl_c.await;
    };
    let app = router(state.clone());
    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        tracing::error!(error = %e, "server error");
    }
    persist::flush(&state);
    tracing::info!("state flushed; stopped");
}
