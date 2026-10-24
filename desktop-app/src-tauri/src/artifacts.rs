use std::borrow::Cow;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::session_store::now_millis;
use crate::session_store::{validate_id, SessionStore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Document,
    Html,
}

impl ArtifactKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Document => "document",
            Self::Html => "html",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Artifact {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub body: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_cwd: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactUpsert {
    pub id: String,
    pub kind: ArtifactKind,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub source_cwd: Option<String>,
}

/// Artifacts own their storage. The legacy table is read only for a one-time migration.
pub(crate) fn ensure_artifacts_table(conn: &Connection) -> rusqlite::Result<()> {
    let migrated: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts')",
        [],
        |row| row.get(0),
    )?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, artifact_kind TEXT NOT NULL, title TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '', source_session_id TEXT, source_cwd TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS artifacts_updated_idx ON artifacts(updated_at DESC, id);",
    )?;
    let legacy: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='notes')",
        [],
        |row| row.get(0),
    )?;
    if legacy {
        let columns: i64 = conn.query_row("SELECT COUNT(*) FROM pragma_table_info('notes') WHERE name IN ('content_kind','artifact_kind')", [], |row| row.get(0))?;
        if columns == 2 && !migrated {
            conn.execute_batch("INSERT OR IGNORE INTO artifacts (id,artifact_kind,title,body,source_session_id,source_cwd,created_at,updated_at)
              SELECT id,artifact_kind,title,body,source_session_id,source_cwd,created_at,updated_at FROM notes WHERE content_kind='artifact';")?;
        }
    }
    Ok(())
}

fn upsert_artifact(conn: &Connection, input: &ArtifactUpsert) -> rusqlite::Result<Artifact> {
    let previous = get_artifact(conn, &input.id)?;
    if previous.as_ref().is_some_and(|old| old.kind != input.kind) {
        return Err(rusqlite::Error::InvalidParameterName(
            "Artifact kind cannot change".into(),
        ));
    }
    let title: String = input.title.trim().chars().take(200).collect();
    let title = if title.is_empty() {
        "Untitled".to_string()
    } else {
        title
    };
    let body = input.body.replace("\r\n", "\n").replace('\r', "\n");
    let now = now_millis();
    let created_at = previous.as_ref().map_or(now, |old| old.created_at);
    let updated_at = previous
        .as_ref()
        .filter(|old| old.title == title && old.body == body)
        .map_or(now, |old| old.updated_at);
    let source_session_id = previous
        .as_ref()
        .and_then(|old| old.source_session_id.clone())
        .or_else(|| input.source_session_id.clone());
    let source_cwd = input
        .source_cwd
        .clone()
        .or_else(|| previous.as_ref().and_then(|old| old.source_cwd.clone()));
    conn.execute("INSERT INTO artifacts(id,artifact_kind,title,body,source_session_id,source_cwd,created_at,updated_at)
      VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(id) DO UPDATE SET title=excluded.title, body=excluded.body, source_cwd=excluded.source_cwd, updated_at=excluded.updated_at",
      params![input.id,input.kind.as_str(),title,body,source_session_id,source_cwd,created_at,updated_at])?;
    Ok(Artifact {
        id: input.id.clone(),
        kind: input.kind,
        title,
        body,
        source_session_id,
        source_cwd,
        created_at,
        updated_at,
    })
}

#[tauri::command(async)]
pub fn artifacts_list(store: State<'_, SessionStore>) -> Result<Vec<Artifact>, String> {
    let conn = store.lock_conn()?;
    list_artifacts(&conn).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn artifacts_get(
    store: State<'_, SessionStore>,
    id: String,
) -> Result<Option<Artifact>, String> {
    validate_id(&id, "artifact")?;
    let conn = store.lock_conn()?;
    get_artifact(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn artifacts_delete(
    app: AppHandle,
    store: State<'_, SessionStore>,
    id: String,
) -> Result<(), String> {
    validate_id(&id, "artifact")?;
    let conn = store.lock_conn()?;
    delete_artifact(&conn, &id).map_err(|e| e.to_string())?;
    drop(conn);
    let _ = app.emit("handwork:artifact-deleted", &id);
    Ok(())
}

fn delete_artifact(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM artifacts WHERE id = ?1", [id])?;
    // Update paginated Mono history and older full-session transcripts in the
    // same transaction. Reply text and all unrelated metadata stay intact.
    tx.execute(
        "UPDATE mono_blocks SET block_json = json_set(block_json, '$.artifactCards',
           (SELECT json_group_array(json(card.value))
            FROM json_each(block_json, '$.artifactCards') AS card
            WHERE json_extract(card.value, '$.id') != ?1))
         WHERE instr(block_json, '\"artifactCards\"') > 0
           AND EXISTS (SELECT 1 FROM json_each(block_json, '$.artifactCards') AS card
                       WHERE json_extract(card.value, '$.id') = ?1)",
        [id],
    )?;
    tx.execute(
        "UPDATE sessions SET blocks_json = (
           SELECT json_group_array(json(CASE WHEN json_type(block.value, '$.artifactCards') = 'array'
             THEN json_set(block.value, '$.artifactCards',
               (SELECT json_group_array(json(card.value))
                FROM json_each(block.value, '$.artifactCards') AS card
                WHERE json_extract(card.value, '$.id') != ?1))
             ELSE block.value END))
           FROM json_each(blocks_json) AS block)
         WHERE instr(blocks_json, '\"artifactCards\"') > 0
           AND EXISTS (SELECT 1 FROM json_each(blocks_json) AS block,
                         json_each(block.value, '$.artifactCards') AS card
                       WHERE json_extract(card.value, '$.id') = ?1)",
        [id],
    )?;
    tx.commit()
}

/// A late save from another window must not bring deleted cards back.
pub(crate) fn retain_existing_cards<'a>(
    conn: &Connection,
    value: &'a Value,
) -> rusqlite::Result<Cow<'a, Value>> {
    let mut cleaned = Cow::Borrowed(value);
    if let Some(blocks) = value.as_array() {
        for (index, block) in blocks.iter().enumerate() {
            let next = retain_existing_cards(conn, block)?;
            if let Cow::Owned(next) = next {
                cleaned.to_mut()[index] = next;
            }
        }
    } else if let Some(cards) = value.get("artifactCards").and_then(Value::as_array) {
        let mut existing = Vec::new();
        for card in cards {
            let Some(id) = card["id"].as_str() else {
                continue;
            };
            let present: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM artifacts WHERE id = ?1)",
                [id],
                |row| row.get(0),
            )?;
            if present {
                existing.push(card.clone());
            }
        }
        if existing.len() != cards.len() {
            cleaned.to_mut()["artifactCards"] = Value::Array(existing);
        }
    }
    Ok(cleaned)
}

#[tauri::command(async)]
pub fn artifacts_upsert(
    store: State<'_, SessionStore>,
    artifact: ArtifactUpsert,
) -> Result<Artifact, String> {
    validate_id(&artifact.id, "artifact")?;
    if let Some(id) = artifact.source_session_id.as_deref() {
        validate_id(id, "session")?;
    }
    if artifact.body.len() > 1_000_000 {
        return Err("Content is too large".into());
    }
    let conn = store.lock_conn()?;
    upsert_artifact(&conn, &artifact).map_err(|error| error.to_string())
}

/// Scheme that serves `html` artifacts to the sandboxed frames that show them.
pub const HTML_SCHEME: &str = "monoartifact";

/// The page may run inline scripts and load public styles, scripts, images and
/// fonts, but it cannot fetch, frame, submit forms or leave its sandbox, even
/// if something opens its URL outside a sandboxed frame.
const HTML_CSP: &str = "sandbox allow-scripts; default-src 'none'; \
    script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; \
    img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; \
    worker-src blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/// Runs first in every page: applies the theme the app posts, reports the
/// content height so the frame can fit it, and hands web links to the app.
const HTML_BOOTSTRAP: &str = r#"<script>(function(){var s=document.createElement("style"),c=document.currentScript,h;c.parentNode.insertBefore(s,c.nextSibling);var base="html{background:var(--background);color:var(--foreground);font-family:var(--font-sans)}body{margin:0}";s.textContent=base;function post(m){if(parent!==window)parent.postMessage(m,"*");}window.addEventListener("message",function(e){var d=e.data;if(e.source!==parent||!d||d.type!=="handwork:theme"||!d.vars)return;var css=":root{color-scheme:"+(d.scheme==="light"?"light":"dark")+";";for(var k in d.vars)if(/^--[a-z0-9-]+$/.test(k))css+=k+":"+String(d.vars[k]).replace(/[;{}<>]/g,"")+";";s.textContent=css+"}"+base;});document.addEventListener("click",function(e){var a=e.target&&e.target.closest?e.target.closest("a[href]"):null,u;if(!a)return;try{u=new URL(a.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol))return;e.preventDefault();if(e.isTrusted)post({type:"handwork:open-link",url:u.href});},true);function size(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;post({type:"handwork:height",height:v});}if(window.ResizeObserver){var o=new ResizeObserver(size);o.observe(document.documentElement);document.addEventListener("DOMContentLoaded",function(){if(document.body)o.observe(document.body);});}window.addEventListener("load",size);document.addEventListener("DOMContentLoaded",size);post({type:"handwork:ready"});})();</script>"#;

/// Serves `<scheme>://localhost/<id>`. Only `html` artifacts are served, so a
/// frame can never show a document's Markdown as a page.
pub fn serve_html<R: tauri::Runtime>(
    app: &AppHandle<R>,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let not_found = || {
        tauri::http::Response::builder()
            .status(404)
            .body(Vec::new())
            .unwrap_or_default()
    };
    if request.method() != tauri::http::Method::GET {
        return not_found();
    }
    let id = request.uri().path().trim_start_matches('/');
    if validate_id(id, "artifact").is_err() {
        return not_found();
    }
    let Some(store) = app.try_state::<SessionStore>() else {
        return not_found();
    };
    let artifact = match store.lock_conn() {
        Ok(conn) => get_artifact(&conn, id).ok().flatten(),
        Err(_) => None,
    };
    let Some(artifact) = artifact.filter(|a| a.kind == ArtifactKind::Html) else {
        return not_found();
    };
    tauri::http::Response::builder()
        .status(200)
        .header("Content-Type", "text/html; charset=utf-8")
        .header("Content-Security-Policy", HTML_CSP)
        .header("Cache-Control", "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(with_bootstrap(&artifact.body).into_bytes())
        .unwrap_or_else(|_| not_found())
}

/// Inserts the bootstrap at the start of `<head>`, else after `<html>` or the
/// doctype. Never before the doctype, which would switch to quirks mode.
fn with_bootstrap(body: &str) -> String {
    // ASCII lowercasing keeps byte offsets, so they index into `body`.
    let lower = body.to_ascii_lowercase();
    let at = tag_end(&lower, "<head")
        .or_else(|| tag_end(&lower, "<html"))
        .or_else(|| {
            let start = lower.len() - lower.trim_start().len();
            lower[start..]
                .starts_with("<!doctype")
                .then(|| lower[start..].find('>').map(|end| start + end + 1))
                .flatten()
        })
        .unwrap_or(0);
    let mut page = String::with_capacity(body.len() + HTML_BOOTSTRAP.len());
    page.push_str(&body[..at]);
    page.push_str(HTML_BOOTSTRAP);
    page.push_str(&body[at..]);
    page
}

/// The byte just past the first opening `name` tag, skipping longer names
/// such as `<header>` for `<head`.
fn tag_end(lower: &str, name: &str) -> Option<usize> {
    let mut from = 0;
    while let Some(found) = lower[from..].find(name) {
        let start = from + found;
        let next = start + name.len();
        match lower.as_bytes().get(next) {
            Some(b'>' | b'/') | Some(b' ' | b'\t' | b'\n' | b'\r' | b'\x0c') => {
                return lower[next..].find('>').map(|end| next + end + 1);
            }
            _ => from = next,
        }
    }
    None
}

fn list_artifacts(conn: &Connection) -> rusqlite::Result<Vec<Artifact>> {
    let mut stmt = conn.prepare(
        "SELECT id, artifact_kind, title, body, source_session_id, source_cwd,
                created_at, updated_at
         FROM artifacts
         ORDER BY updated_at DESC, id ASC",
    )?;
    let rows = stmt.query_map([], read_artifact)?;
    rows.collect()
}

fn get_artifact(conn: &Connection, id: &str) -> rusqlite::Result<Option<Artifact>> {
    conn.query_row(
        "SELECT id, artifact_kind, title, body, source_session_id, source_cwd,
                created_at, updated_at
         FROM artifacts WHERE id = ?1",
        params![id],
        read_artifact,
    )
    .optional()
}

fn read_artifact(row: &rusqlite::Row<'_>) -> rusqlite::Result<Artifact> {
    let kind: String = row.get(1)?;
    let kind = match kind.as_str() {
        "document" => ArtifactKind::Document,
        "html" => ArtifactKind::Html,
        _ => {
            return Err(rusqlite::Error::InvalidParameterName(
                "Unsupported artifact kind".into(),
            ));
        }
    };
    Ok(Artifact {
        id: row.get(0)?,
        kind,
        title: row.get(2)?,
        body: row.get(3)?,
        source_session_id: row.get(4)?,
        source_cwd: row.get(5)?,
        created_at: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_legacy_artifacts_once_without_importing_personal_notes() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE notes (
          id TEXT PRIMARY KEY, content_kind TEXT, artifact_kind TEXT,
          title TEXT, body TEXT, source_session_id TEXT, source_cwd TEXT,
          created_at INTEGER, updated_at INTEGER);
          INSERT INTO notes VALUES('doc','artifact','document','Report','Body','s1','/tmp',1,2);
          INSERT INTO notes VALUES('personal','note',NULL,'Private','Personal',NULL,NULL,1,2);",
        )
        .unwrap();
        ensure_artifacts_table(&conn).unwrap();
        let documents = list_artifacts(&conn).unwrap();
        assert_eq!(documents.len(), 1);
        assert_eq!(documents[0].id, "doc");
        assert_eq!(documents[0].body, "Body");
        assert_eq!(documents[0].source_session_id.as_deref(), Some("s1"));
        conn.execute("DELETE FROM artifacts WHERE id='doc'", [])
            .unwrap();
        ensure_artifacts_table(&conn).unwrap();
        assert!(list_artifacts(&conn).unwrap().is_empty());
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM notes", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn html_artifacts_round_trip_their_kind() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let note = ArtifactUpsert {
            kind: ArtifactKind::Document,
            id: "artifact-html".into(),
            title: "Chart".into(),
            body: "<p>hi</p>".into(),
            source_session_id: None,
            source_cwd: None,
        };
        upsert_artifact(
            &conn,
            &ArtifactUpsert {
                kind: ArtifactKind::Html,
                ..note.clone()
            },
        )
        .unwrap();
        let artifact = get_artifact(&conn, &note.id).unwrap().unwrap();
        assert_eq!(artifact.kind, ArtifactKind::Html);
        assert_eq!(serde_json::to_value(artifact).unwrap()["kind"], "html");
    }

    #[test]
    fn bootstrap_goes_first_in_head_and_never_before_the_doctype() {
        let page = with_bootstrap("<!DOCTYPE html><html><HEAD><title>x</title></HEAD></html>");
        assert!(page.starts_with("<!DOCTYPE html><html><HEAD><script>"));
        let page = with_bootstrap("<!doctype html>\n<body><header>x</header></body>");
        assert!(page.starts_with("<!doctype html><script>"));
        let page = with_bootstrap("<html lang=\"en\"><body></body></html>");
        assert!(page.starts_with("<html lang=\"en\"><script>"));
        let page = with_bootstrap("<div>fragment</div>");
        assert!(page.starts_with("<script>"));
        assert!(page.ends_with("</script><div>fragment</div>"));
    }

    #[test]
    fn artifact_contract_preserves_kind_and_excludes_note_fields() {
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let note = ArtifactUpsert {
            kind: ArtifactKind::Document,
            id: "artifact-1".into(),
            title: "PR report".into(),
            body: "# Report".into(),
            source_session_id: Some("mono-1".into()),
            source_cwd: Some("/repo".into()),
        };
        upsert_artifact(&conn, &note).unwrap();
        let artifact = get_artifact(&conn, &note.id).unwrap().unwrap();
        assert_eq!(artifact.kind, ArtifactKind::Document);
        assert_eq!(artifact.body, note.body);
        assert_eq!(list_artifacts(&conn).unwrap()[0].id, note.id);
        let json = serde_json::to_value(artifact).unwrap();
        assert_eq!(json["kind"], "document");
        assert_eq!(json["sourceSessionId"], "mono-1");
        assert!(json.get("tags").is_none());
        assert!(json.get("slug").is_none());
        assert!(get_artifact(&conn, "missing").unwrap().is_none());
        assert!(serde_json::from_value::<ArtifactUpsert>(serde_json::json!({
            "id": "artifact-2", "kind": "code", "title": "Code", "body": "code"
        }))
        .is_err());
    }

    #[test]
    fn deletion_cleans_full_and_paginated_chats_and_keeps_other_artifacts_and_replies() {
        use crate::session_store::{get_session, upsert_session, SessionUpsert};
        use serde_json::json;
        let store = SessionStore::open_in_memory().unwrap();
        let conn = store.lock_conn().unwrap();
        let content = ArtifactUpsert {
            kind: ArtifactKind::Document,
            id: "remove".into(),
            title: "Report".into(),
            body: "Full report".into(),
            source_session_id: None,
            source_cwd: None,
        };
        for id in ["remove", "keep"] {
            upsert_artifact(
                &conn,
                &ArtifactUpsert {
                    id: id.into(),
                    ..content.clone()
                },
            )
            .unwrap();
        }
        let session: SessionUpsert = serde_json::from_value(json!({
            "id": "normal", "cwd": "/tmp", "harness": "codex", "model": "model",
            "modelSettings": {}, "runtimeMode": "default", "title": "Chat",
            "blocks": [
                { "id": "turn", "role": "user", "text": "Review", "artifactCards": [
                    { "id": "remove", "kind": "document", "title": "Report" },
                    { "id": "keep", "kind": "document", "title": "Other" }
                ] },
                { "id": "reply", "role": "assistant", "text": "I created a report." }
            ]
        }))
        .unwrap();
        upsert_session(&conn, &session).unwrap();
        let mono = SessionUpsert {
            id: "mono".into(),
            ..session.clone()
        };
        upsert_session(&conn, &mono).unwrap();
        crate::mono_transcript::migrate_transcript(&conn, "mono").unwrap();
        delete_artifact(&conn, "remove").unwrap();
        delete_artifact(&conn, "remove").unwrap();
        assert!(get_artifact(&conn, "remove").unwrap().is_none());
        assert!(get_artifact(&conn, "keep").unwrap().is_some());
        let blocks = get_session(&conn, "normal").unwrap().unwrap().blocks;
        assert_eq!(
            blocks[0]["artifactCards"],
            json!([{ "id": "keep", "kind": "document", "title": "Other" }])
        );
        assert_eq!(blocks[1], session.blocks[1]);
        let raw: String = conn.query_row("SELECT block_json FROM mono_blocks WHERE session_id = 'mono' AND block_id = 'turn'", [], |row| row.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(&raw).unwrap(), blocks[0]);
        // An older client save still contains both references, but the deleted
        // card is filtered before it reaches storage again.
        upsert_session(&conn, &session).unwrap();
        assert_eq!(
            get_session(&conn, "normal").unwrap().unwrap().blocks,
            blocks
        );
        let stale = retain_existing_cards(&conn, &mono.blocks).unwrap();
        assert_eq!(stale.as_ref(), &blocks);
    }
}
