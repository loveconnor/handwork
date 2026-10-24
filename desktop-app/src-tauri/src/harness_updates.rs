use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde_json::Value;

use crate::harness::{exec_output, is_resolved_harness_binary};

const REGISTRY_URL: &str = "https://registry.npmjs.org";
const USER_AGENT: &str = "Handwork";
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// Only harnesses whose releases are published to npm. The rest ship through
/// their own installers with no public version feed to compare against.
fn npm_package(provider: &str) -> Option<&'static str> {
    match provider {
        "claude" => Some("@anthropic-ai/claude-code"),
        "codex" => Some("@openai/codex"),
        "opencode" => Some("opencode-ai"),
        "pi" => Some("@earendil-works/pi-coding-agent"),
        _ => None,
    }
}

/// Native installations retain their CLI's own update mechanism. npm installs
/// use an explicit package prefix so a different installation is not updated.
fn update_args(provider: &str) -> Option<&'static [&'static str]> {
    match provider {
        "claude" => Some(&["update"]),
        "codex" => Some(&["update"]),
        "opencode" => Some(&["upgrade"]),
        "pi" => Some(&["update", "--self"]),
        _ => None,
    }
}

/// npm self-updaters can update a different global prefix than the CLI the
/// app launches. Install into the package's own prefix instead.
fn npm_install_prefix(provider: &str, command: &Path) -> Option<PathBuf> {
    let package = npm_package(provider)?;
    let canonical = std::fs::canonicalize(command).ok()?;
    for ancestor in canonical.ancestors() {
        let manifest = ancestor.join("package.json");
        let Ok(contents) = std::fs::read_to_string(manifest) else {
            continue;
        };
        let Ok(body) = serde_json::from_str::<Value>(&contents) else {
            continue;
        };
        if body.get("name").and_then(Value::as_str) != Some(package) {
            continue;
        }
        let modules = ancestor
            .ancestors()
            .find(|path| path.file_name().is_some_and(|name| name == "node_modules"))?;
        let parent = modules.parent()?;
        return Some(if parent.file_name().is_some_and(|name| name == "lib") {
            parent.parent()?.to_path_buf()
        } else {
            parent.to_path_buf()
        });
    }
    // Vite+ package launchers point at `vp`, not at the installed package.
    if command.parent()?.file_name()? == "bin" {
        let root = command.parent()?.parent()?;
        if root.file_name()? == ".vite-plus" {
            let prefix = root.join("packages").join(package);
            let manifest = prefix
                .join("lib/node_modules")
                .join(package)
                .join("package.json");
            let body: Value =
                serde_json::from_str(&std::fs::read_to_string(manifest).ok()?).ok()?;
            if body.get("name")?.as_str()? == package {
                return Some(prefix);
            }
        }
    }
    None
}

fn update_command(provider: &str, command: &str) -> Result<(String, Vec<String>), String> {
    if let Some(prefix) = npm_install_prefix(provider, Path::new(command)) {
        let npm = crate::harness::resolve_gui_binary("npm")
            .ok_or_else(|| "npm is required to update this installation. Install Node.js or choose a native agent binary in Settings.".to_string())?;
        return Ok((
            npm.to_string_lossy().into_owned(),
            vec![
                "install".into(),
                "--global".into(),
                "--prefix".into(),
                prefix.to_string_lossy().into_owned(),
                format!("{}@latest", npm_package(provider).unwrap()),
                "--no-audit".into(),
                "--no-fund".into(),
            ],
        ));
    }
    let args =
        update_args(provider).ok_or_else(|| format!("No updater for harness: {provider}"))?;
    Ok((
        command.to_string(),
        args.iter().map(|arg| arg.to_string()).collect(),
    ))
}

/// A download plus, for npm installs, a full dependency install.
const UPDATE_TIMEOUT: Duration = Duration::from_secs(300);

static LAUNCH_CHECK_CLAIMED: AtomicBool = AtomicBool::new(false);

/// True for the first caller per app process, so a window opened later in the
/// same run does not repeat the launch check.
#[tauri::command]
pub fn harness_update_check_claim() -> bool {
    !LAUNCH_CHECK_CLAIMED.swap(true, Ordering::SeqCst)
}

#[tauri::command]
pub async fn harness_latest_version(provider: String) -> Result<String, String> {
    let package =
        npm_package(&provider).ok_or_else(|| format!("No update feed for harness: {provider}"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let agent = ureq::AgentBuilder::new().timeout(HTTP_TIMEOUT).build();
        let text = agent
            .get(&format!("{REGISTRY_URL}/{package}/latest"))
            .set("User-Agent", USER_AGENT)
            .set("Accept", "application/json")
            .call()
            .map_err(|error| format!("npm registry request failed: {error}"))?
            .into_string()
            .map_err(|error| format!("npm registry response unreadable: {error}"))?;
        let body: Value = serde_json::from_str(&text)
            .map_err(|error| format!("npm registry returned invalid JSON: {error}"))?;
        latest_version(&body).ok_or_else(|| "npm registry returned no version".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Updates the installation containing the binary Handwork resolved. stdin is closed, so an updater that stops to ask fails instead of
/// hanging.
#[tauri::command]
pub async fn harness_update(
    command: String,
    binary_provider: String,
    binary_path: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !is_resolved_harness_binary(&command, Some(&binary_provider), binary_path.as_deref()) {
            return Err("harness_update: not a resolved harness CLI".to_string());
        }
        let (updater, args) = update_command(&binary_provider, &command)?;
        let output = exec_output(&updater, &args, None, UPDATE_TIMEOUT)?;
        if output.status.success() {
            return Ok(());
        }
        Err(update_failure(&output.stdout, &output.stderr))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Updaters print their reason to either stream; the last line is the one
/// that says what went wrong.
fn update_failure(stdout: &[u8], stderr: &[u8]) -> String {
    [stderr, stdout]
        .iter()
        .filter_map(|bytes| {
            String::from_utf8_lossy(bytes)
                .lines()
                .map(str::trim)
                .rfind(|line| !line.is_empty())
                .map(str::to_string)
        })
        .next()
        .unwrap_or_else(|| "Update failed".to_string())
}

fn latest_version(body: &Value) -> Option<String> {
    let version = body.get("version")?.as_str()?.trim();
    (!version.is_empty()).then(|| version.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn targets_the_npm_installation_containing_the_active_cli() {
        let root = std::env::temp_dir().join(format!("handwork-update-{}", uuid::Uuid::new_v4()));
        let prefix = root.join("node/24.21.0");
        let package = prefix.join("lib/node_modules/@anthropic-ai/claude-code");
        std::fs::create_dir_all(package.join("bin")).unwrap();
        std::fs::write(
            package.join("package.json"),
            r#"{"name":"@anthropic-ai/claude-code"}"#,
        )
        .unwrap();
        let binary = package.join("bin/claude");
        std::fs::write(&binary, "fixture").unwrap();
        assert_eq!(
            npm_install_prefix("claude", &binary),
            Some(std::fs::canonicalize(&prefix).unwrap())
        );
        assert_eq!(npm_install_prefix("codex", &binary), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn resolves_the_package_behind_a_vite_plus_launcher() {
        let root = std::env::temp_dir().join(format!("handwork-update-{}", uuid::Uuid::new_v4()));
        let vite = root.join(".vite-plus");
        let prefix = vite.join("packages/@openai/codex");
        let package = prefix.join("lib/node_modules/@openai/codex");
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(vite.join("bin")).unwrap();
        std::fs::create_dir_all(vite.join("current/bin")).unwrap();
        std::fs::write(package.join("package.json"), r#"{"name":"@openai/codex"}"#).unwrap();
        std::fs::write(vite.join("current/bin/vp"), "fixture").unwrap();
        std::fs::write(vite.join("current/package.json"), r#"{"version":"1.0.0"}"#).unwrap();
        let binary = vite.join("bin/codex");
        std::os::unix::fs::symlink("../current/bin/vp", &binary).unwrap();
        assert_eq!(npm_install_prefix("codex", &binary), Some(prefix));
        assert_eq!(npm_install_prefix("claude", &binary), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn maps_only_npm_published_harnesses() {
        assert_eq!(npm_package("claude"), Some("@anthropic-ai/claude-code"));
        assert_eq!(npm_package("pi"), Some("@earendil-works/pi-coding-agent"));
        assert_eq!(npm_package("cursor"), None);
        assert_eq!(npm_package("../../evil"), None);
    }

    #[test]
    fn updates_only_through_each_cli_own_updater() {
        assert_eq!(update_args("pi"), Some(&["update", "--self"][..]));
        assert_eq!(update_args("opencode"), Some(&["upgrade"][..]));
        assert_eq!(update_args("cursor"), None);
    }

    #[test]
    fn reports_the_last_line_an_updater_printed() {
        assert_eq!(
            update_failure(
                b"checking\n",
                b"npm ERR! code EACCES\nnpm ERR! permission denied\n\n"
            ),
            "npm ERR! permission denied"
        );
        assert_eq!(update_failure(b"no write access\n", b""), "no write access");
        assert_eq!(update_failure(b"", b""), "Update failed");
    }

    #[test]
    fn reads_version_from_registry_payload() {
        assert_eq!(
            latest_version(&json!({ "name": "opencode-ai", "version": "1.18.33" })),
            Some("1.18.33".to_string())
        );
        assert_eq!(latest_version(&json!({ "version": " " })), None);
        assert_eq!(latest_version(&json!({})), None);
    }
}
