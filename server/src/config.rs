use serde::Deserialize;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct HydrusConfig {
    pub url: String,
    pub key: String,
}

#[derive(Clone, Debug)]
pub struct DdbConfig {
    pub cobalt: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookField {
    pub key: String,
    pub value: String,
}

// The same shape as the plugin's WebhookConfig without its id: the name is
// what a controller sees and sends by, the url is never returned.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WebhookTarget {
    pub name: String,
    pub url: String,
    pub image_field: String,
    pub caption_field: String,
    #[serde(default)]
    pub extra_fields: Vec<WebhookField>,
}

#[derive(Clone, Debug)]
pub struct Config {
    pub view_token: String,
    pub control_token: String,
    pub port: u16,
    pub data_dir: PathBuf,
    pub max_clients: usize,
    pub max_asset_bytes: u64,
    pub asset_retention_days: u64,
    pub derivative_cache_bytes: u64,
    pub hydrus: Option<HydrusConfig>,
    pub ddb: Option<DdbConfig>,
    // Points the D&D Beyond endpoints at a stub; unset in production.
    pub ddb_base: Option<String>,
    pub webhooks: Vec<WebhookTarget>,
    pub ffmpeg: String,
    pub ffprobe: String,
}

const MIN_TOKEN_LEN: usize = 32;

impl Config {
    // Errors name the offending variable and never echo a value.
    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Config, String> {
        Config::from_lookup_with(get, |path| {
            std::fs::read_to_string(path).map_err(|e| e.to_string())
        })
    }

    pub fn from_lookup_with(
        get: impl Fn(&str) -> Option<String>,
        read_file: impl Fn(&str) -> Result<String, String>,
    ) -> Result<Config, String> {
        // A secret comes from NAME or from the file NAME_FILE names, so a
        // mounted secret rotates without editing the deployment. Both at once
        // is a mistake worth refusing rather than silently preferring one.
        let secret = |name: &str| -> Result<Option<String>, String> {
            let file_name = format!("{name}_FILE");
            let direct = get(name).filter(|v| !v.is_empty());
            let path = get(&file_name).filter(|v| !v.is_empty());
            match (direct, path) {
                (Some(_), Some(_)) => Err(format!("set {name} or {file_name}, not both")),
                (Some(v), None) => Ok(Some(v)),
                (None, Some(p)) => Ok(Some(
                    read_file(&p)
                        .map_err(|e| format!("{file_name}: {e}"))?
                        .trim()
                        .to_string(),
                )),
                (None, None) => Ok(None),
            }
        };
        let token = |name: &str| -> Result<String, String> {
            let v = get(name).unwrap_or_default();
            if v.len() < MIN_TOKEN_LEN {
                return Err(format!(
                    "{name} must be set to at least {MIN_TOKEN_LEN} characters"
                ));
            }
            Ok(v)
        };
        let view_token = token("DM_SCREEN_VIEW_TOKEN")?;
        let control_token = token("DM_SCREEN_CONTROL_TOKEN")?;
        if view_token == control_token {
            return Err("DM_SCREEN_VIEW_TOKEN and DM_SCREEN_CONTROL_TOKEN must differ".into());
        }
        let num = |name: &str, default: u64| -> Result<u64, String> {
            match get(name) {
                None => Ok(default),
                Some(v) => v
                    .trim()
                    .parse::<u64>()
                    .map_err(|_| format!("{name} must be a non-negative integer")),
            }
        };
        let port = num("DM_SCREEN_PORT", 8080)?;
        if port > u16::MAX as u64 {
            return Err("DM_SCREEN_PORT is out of range".into());
        }
        let hydrus = match (get("DM_SCREEN_HYDRUS_URL"), secret("DM_SCREEN_HYDRUS_KEY")?) {
            (None, None) => None,
            (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => {
                check_outbound_url(&url).map_err(|e| format!("DM_SCREEN_HYDRUS_URL: {e}"))?;
                Some(HydrusConfig {
                    url: url.trim_end_matches('/').to_string(),
                    key,
                })
            }
            _ => {
                return Err(
                    "DM_SCREEN_HYDRUS_URL and DM_SCREEN_HYDRUS_KEY must be set together".into(),
                );
            }
        };
        let ddb = secret("DM_SCREEN_DDB_COBALT")?.map(|cobalt| DdbConfig { cobalt });
        let ddb_base = get("DM_SCREEN_DDB_BASE").filter(|b| !b.is_empty());
        let webhooks = match secret("DM_SCREEN_WEBHOOKS")? {
            None => Vec::new(),
            Some(raw) => parse_webhooks(&raw)?,
        };
        Ok(Config {
            view_token,
            control_token,
            port: port as u16,
            data_dir: PathBuf::from(get("DM_SCREEN_DATA_DIR").unwrap_or_else(|| "/data".into())),
            max_clients: num("DM_SCREEN_MAX_CLIENTS", 10)? as usize,
            max_asset_bytes: num("DM_SCREEN_MAX_ASSET_MB", 1024)? * 1024 * 1024,
            asset_retention_days: num("DM_SCREEN_ASSET_RETENTION_DAYS", 90)?,
            derivative_cache_bytes: num("DM_SCREEN_DERIVATIVE_CACHE_MB", 2048)? * 1024 * 1024,
            hydrus,
            ddb,
            ddb_base,
            webhooks,
            ffmpeg: get("DM_SCREEN_FFMPEG").unwrap_or_else(|| "ffmpeg".into()),
            ffprobe: get("DM_SCREEN_FFPROBE").unwrap_or_else(|| "ffprobe".into()),
        })
    }
}

fn parse_webhooks(raw: &str) -> Result<Vec<WebhookTarget>, String> {
    let targets: Vec<WebhookTarget> = serde_json::from_str(raw)
        .map_err(|e| format!("DM_SCREEN_WEBHOOKS is not a valid target list: {e}"))?;
    let mut seen = std::collections::HashSet::new();
    for t in &targets {
        if t.name.trim().is_empty() {
            return Err("DM_SCREEN_WEBHOOKS has a target with an empty name".into());
        }
        if !seen.insert(t.name.clone()) {
            return Err(format!(
                "DM_SCREEN_WEBHOOKS repeats the target name {}",
                t.name
            ));
        }
        // The URL carries the credential, so the error names the target only.
        check_outbound_url(&t.url)
            .map_err(|e| format!("DM_SCREEN_WEBHOOKS target {}: {e}", t.name))?;
    }
    Ok(targets)
}

// The plugin's src/net/urlPolicy.ts rule: http(s) only, no embedded
// credentials, plaintext only to loopback, RFC1918 or a single-label .local.
pub fn check_outbound_url(raw: &str) -> Result<(), String> {
    let url = url::Url::parse(raw).map_err(|_| "not a valid URL".to_string())?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err(format!(
            "only http and https are allowed, got {}",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URLs with embedded credentials are not allowed".into());
    }
    if url.scheme() == "http" && !is_private_host(url.host_str().unwrap_or("")) {
        return Err("plaintext http is allowed only to a loopback, RFC1918 or .local host".into());
    }
    Ok(())
}

fn is_private_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    if host == "localhost" || host == "[::1]" {
        return true;
    }
    if let Some(label) = host.strip_suffix(".local") {
        return !label.is_empty() && !label.contains('.');
    }
    let octets: Vec<u8> = host.split('.').filter_map(|p| p.parse().ok()).collect();
    if octets.len() != 4 || host.split('.').count() != 4 {
        return false;
    }
    matches!(octets[..], [127, ..] | [10, ..] | [192, 168, ..])
        || (octets[0] == 172 && (16..=31).contains(&octets[1]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn cfg(pairs: &[(&str, &str)]) -> Result<Config, String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::from_lookup(|k| map.get(k).cloned())
    }

    const V: &str = "v0123456789abcdef0123456789abcdef";
    const C: &str = "c0123456789abcdef0123456789abcdef";

    #[test]
    fn applies_defaults() {
        let c = cfg(&[("DM_SCREEN_VIEW_TOKEN", V), ("DM_SCREEN_CONTROL_TOKEN", C)]).unwrap();
        assert_eq!(
            (c.port, c.max_clients, c.asset_retention_days),
            (8080, 10, 90)
        );
        assert_eq!(c.max_asset_bytes, 1024 * 1024 * 1024);
        assert!(c.hydrus.is_none());
    }

    #[test]
    fn refuses_bad_tokens_without_echoing_them() {
        let short = cfg(&[
            ("DM_SCREEN_VIEW_TOKEN", "short"),
            ("DM_SCREEN_CONTROL_TOKEN", C),
        ])
        .unwrap_err();
        assert!(short.contains("DM_SCREEN_VIEW_TOKEN") && !short.contains("short"));
        assert!(
            cfg(&[("DM_SCREEN_VIEW_TOKEN", V)])
                .unwrap_err()
                .contains("DM_SCREEN_CONTROL_TOKEN")
        );
        assert!(
            cfg(&[("DM_SCREEN_VIEW_TOKEN", V), ("DM_SCREEN_CONTROL_TOKEN", V)])
                .unwrap_err()
                .contains("must differ")
        );
    }

    #[test]
    fn requires_both_hydrus_variables_and_applies_the_url_policy() {
        let base = [("DM_SCREEN_VIEW_TOKEN", V), ("DM_SCREEN_CONTROL_TOKEN", C)];
        let only_url = [
            base[0],
            base[1],
            ("DM_SCREEN_HYDRUS_URL", "http://hydrus.local:45869"),
        ];
        assert!(cfg(&only_url).unwrap_err().contains("set together"));
        let public = [
            base[0],
            base[1],
            ("DM_SCREEN_HYDRUS_URL", "http://example.com"),
            ("DM_SCREEN_HYDRUS_KEY", "k"),
        ];
        assert!(cfg(&public).unwrap_err().contains("plaintext"));
        let ok = [
            base[0],
            base[1],
            ("DM_SCREEN_HYDRUS_URL", "http://192.168.1.5:45869/"),
            ("DM_SCREEN_HYDRUS_KEY", "k"),
        ];
        assert_eq!(
            cfg(&ok).unwrap().hydrus.unwrap().url,
            "http://192.168.1.5:45869"
        );
    }

    #[test]
    fn mirrors_the_plugin_private_host_rule() {
        for h in [
            "localhost",
            "127.0.0.1",
            "10.1.2.3",
            "192.168.0.1",
            "172.16.0.1",
            "172.31.9.9",
            "nas.local",
        ] {
            assert!(is_private_host(h), "{h}");
        }
        for h in [
            "172.15.0.1",
            "172.32.0.1",
            "8.8.8.8",
            "a.b.local",
            "example.com",
            "10.1.2",
        ] {
            assert!(!is_private_host(h), "{h}");
        }
        assert!(check_outbound_url("https://user:pw@host").is_err());
        assert!(check_outbound_url("ftp://host").is_err());
        assert!(check_outbound_url("https://example.com").is_ok());
    }
}
