use dm_screen_server::config::Config;
use std::collections::HashMap;

const V: &str = "v0123456789abcdef0123456789abcdef";
const C: &str = "c0123456789abcdef0123456789abcdef";

fn cfg(pairs: &[(&str, &str)], files: &[(&str, &str)]) -> Result<Config, String> {
    let env: HashMap<String, String> =
        [("DM_SCREEN_VIEW_TOKEN", V), ("DM_SCREEN_CONTROL_TOKEN", C)]
            .into_iter()
            .chain(pairs.iter().copied())
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
    let files: HashMap<String, String> = files
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    Config::from_lookup_with(
        |k| env.get(k).cloned(),
        |p| {
            files
                .get(p)
                .cloned()
                .ok_or_else(|| "no such file".to_string())
        },
    )
}

#[test]
fn reads_a_secret_from_the_environment_or_from_the_file_it_names() {
    let direct = cfg(&[("DM_SCREEN_DDB_COBALT", "cookie-value")], &[]).unwrap();
    assert_eq!(direct.ddb.unwrap().cobalt, "cookie-value");

    // A mounted secret file ends with a newline; it must not become part of
    // the cookie.
    let mounted = cfg(
        &[("DM_SCREEN_DDB_COBALT_FILE", "/run/secrets/cobalt")],
        &[("/run/secrets/cobalt", "cookie-value\n")],
    )
    .unwrap();
    assert_eq!(mounted.ddb.unwrap().cobalt, "cookie-value");
}

#[test]
fn refuses_both_forms_of_one_secret_and_a_missing_file() {
    let both = cfg(
        &[
            ("DM_SCREEN_DDB_COBALT", "a"),
            ("DM_SCREEN_DDB_COBALT_FILE", "/x"),
        ],
        &[("/x", "b")],
    )
    .unwrap_err();
    assert!(both.contains("DM_SCREEN_DDB_COBALT") && both.contains("not both"));

    let missing = cfg(&[("DM_SCREEN_DDB_COBALT_FILE", "/gone")], &[]).unwrap_err();
    assert!(missing.contains("DM_SCREEN_DDB_COBALT_FILE"));
}

#[test]
fn hydrus_still_takes_its_key_from_either_form() {
    let c = cfg(
        &[
            ("DM_SCREEN_HYDRUS_URL", "http://hydrus.local:45869"),
            ("DM_SCREEN_HYDRUS_KEY_FILE", "/run/secrets/hydrus"),
        ],
        &[("/run/secrets/hydrus", "k3y\n")],
    )
    .unwrap();
    assert_eq!(c.hydrus.unwrap().key, "k3y");
}

#[test]
fn parses_webhook_targets_and_names_the_offender_without_its_url() {
    let ok = cfg(
        &[(
            "DM_SCREEN_WEBHOOKS",
            r#"[{"name":"Telegram","url":"https://api.example/botTOKEN/sendPhoto","imageField":"photo","captionField":"caption","extraFields":[{"key":"chat_id","value":"7"}]}]"#,
        )],
        &[],
    )
    .unwrap();
    assert_eq!(ok.webhooks.len(), 1);
    assert_eq!(ok.webhooks[0].name, "Telegram");
    assert_eq!(ok.webhooks[0].extra_fields[0].key, "chat_id");

    let plaintext = cfg(
        &[(
            "DM_SCREEN_WEBHOOKS",
            r#"[{"name":"Public","url":"http://api.example/botTOKEN/sendPhoto","imageField":"photo","captionField":"caption"}]"#,
        )],
        &[],
    )
    .unwrap_err();
    assert!(plaintext.contains("Public") && !plaintext.contains("botTOKEN"));

    for (body, needle) in [
        (
            r#"[{"name":"","url":"https://a.example","imageField":"p","captionField":"c"}]"#,
            "empty name",
        ),
        (
            r#"[{"name":"A","url":"https://a.example","imageField":"p","captionField":"c"},{"name":"A","url":"https://b.example","imageField":"p","captionField":"c"}]"#,
            "repeats",
        ),
        ("not json", "not a valid target list"),
    ] {
        let err = cfg(&[("DM_SCREEN_WEBHOOKS", body)], &[]).unwrap_err();
        assert!(err.contains(needle), "{err}");
    }
}

#[test]
fn leaves_every_integration_unset_by_default() {
    let c = cfg(&[], &[]).unwrap();
    assert!(c.hydrus.is_none() && c.ddb.is_none() && c.webhooks.is_empty());
}
