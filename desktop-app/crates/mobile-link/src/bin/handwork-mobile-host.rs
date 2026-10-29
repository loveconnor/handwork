//! Electron owns workspace state and secrets. This child only provides the shared QUIC transport.
use handwork_mobile_link::{Gate, Identity, WatchSink};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::{mpsc, oneshot},
};

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<Value>>>>;
#[tokio::main]
async fn main() {
    let (output, mut messages) = mpsc::channel::<Value>(128);
    let writer = tokio::spawn(async move {
        let mut stdout = tokio::io::stdout();
        while let Some(message) = messages.recv().await {
            let mut bytes = serde_json::to_vec(&message).unwrap();
            bytes.push(b'\n');
            if stdout.write_all(&bytes).await.is_err() || stdout.flush().await.is_err() {
                break;
            }
        }
    });
    let gate = Gate::default();
    let pending: Pending = Default::default();
    let watches: Arc<Mutex<HashMap<u64, WatchSink>>> = Default::default();
    let sequence = Arc::new(AtomicU64::new(1));
    let mut endpoint: Option<quinn::Endpoint> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let id = message["id"].clone();
        let result: Result<Value, String> = match message["op"].as_str().unwrap_or("") {
            "reply" => {
                if let Some(sender) = pending
                    .lock()
                    .unwrap()
                    .remove(&message["requestId"].as_u64().unwrap_or(0))
                {
                    let _ = sender.send(message["response"].clone());
                }
                continue;
            }
            "push" => {
                let key = message["watchId"].as_u64().unwrap_or(0);
                let sink = watches.lock().unwrap().get(&key).cloned();
                match sink {
                    Some(sink) => sink
                        .try_send(message["update"].clone())
                        .map(|_| Value::Null)
                        .map_err(|e| e.to_string()),
                    None => Err("Watch closed".into()),
                }
            }
            "identity" => Identity::generate()
                .and_then(|v| Ok(json!({"fingerprint":v.fingerprint()?,"identity":v}))),
            "verify" => handwork_mobile_link::verify_proof(
                message["certificate"].as_str().unwrap_or(""),
                message["peer"].as_str().unwrap_or(""),
                message["proof"].as_str().unwrap_or(""),
            )
            .map(|v| json!(v)),
            "allow" => {
                gate.allow(
                    message["fingerprint"].as_str().unwrap_or("").into(),
                    message["expires"].as_u64(),
                );
                Ok(Value::Null)
            }
            "revoke" => {
                gate.remove(message["fingerprint"].as_str().unwrap_or(""));
                Ok(Value::Null)
            }
            "stop" => {
                if let Some(e) = endpoint.take() {
                    e.close(0u32.into(), b"Disabled");
                }
                watches.lock().unwrap().clear();
                Ok(Value::Null)
            }
            "start" => {
                let identity = serde_json::from_value::<Identity>(message["identity"].clone())
                    .map_err(|e| e.to_string());
                match identity.and_then(|identity| {
                    handwork_mobile_link::server_endpoint(
                        &identity,
                        gate.clone(),
                        format!("[::]:{}", message["port"].as_u64().unwrap_or(38416))
                            .parse()
                            .map_err(|_| "Invalid port")?,
                    )
                }) {
                    Err(e) => Err(e),
                    Ok(e) => {
                        let port = e.local_addr().unwrap().port();
                        if let Some(old) = endpoint.replace(e.clone()) {
                            old.close(0u32.into(), b"Restarted");
                        }
                        let out = output.clone();
                        let p = pending.clone();
                        let seq = sequence.clone();
                        let watch_out = output.clone();
                        let wp = pending.clone();
                        let ws = watches.clone();
                        let wseq = sequence.clone();
                        tokio::spawn(handwork_mobile_link::serve(
                            e,
                            gate.clone(),
                            move |peer, request| {
                                let out = out.clone();
                                let pending = p.clone();
                                let id = seq.fetch_add(1, Ordering::Relaxed);
                                async move {
                                    forward(&out, &pending, id, json!({"event":"request","requestId":id,"peer":peer,"request":request})).await
                                }
                            },
                            move |peer, request, sink| {
                                let out = watch_out.clone();
                                let pending = wp.clone();
                                let watches = ws.clone();
                                let id = wseq.fetch_add(1, Ordering::Relaxed);
                                async move {
                                    watches.lock().unwrap().retain(|_, s| !s.is_closed());
                                    if watches.lock().unwrap().len() >= 32 {
                                        return Err("Too many watches".into());
                                    }
                                    watches.lock().unwrap().insert(id, sink.clone());
                                    if let Err(e) = forward(&out, &pending, id, json!({"event":"watch","requestId":id,"peer":peer,"request":request})).await { watches.lock().unwrap().remove(&id); return Err(e); }
                                    tokio::spawn(async move {
                                        sink.closed().await;
                                        watches.lock().unwrap().remove(&id);
                                        let _ =
                                            out.send(json!({"event":"unwatch","watchId":id})).await;
                                    });
                                    Ok(())
                                }
                            },
                        ));
                        Ok(json!({"port":port}))
                    }
                }
            }
            _ => Err("Unknown transport operation".into()),
        };
        let response = match result {
            Ok(value) => json!({"id":id,"ok":true,"result":value}),
            Err(error) => json!({"id":id,"ok":false,"error":error}),
        };
        if output.send(response).await.is_err() {
            break;
        }
    }
    if let Some(e) = endpoint {
        e.close(0u32.into(), b"Desktop exited");
    }
    writer.abort();
}
async fn forward(
    output: &mpsc::Sender<Value>,
    pending: &Pending,
    id: u64,
    message: Value,
) -> Result<Value, String> {
    let (sender, receiver) = oneshot::channel();
    pending.lock().unwrap().insert(id, sender);
    if output.send(message).await.is_err() {
        pending.lock().unwrap().remove(&id);
        return Err("Desktop closed".into());
    }
    let result = tokio::time::timeout(std::time::Duration::from_secs(25), receiver).await;
    pending.lock().unwrap().remove(&id);
    match result {
        Ok(Ok(response)) if response["ok"] == true => Ok(response["result"].clone()),
        Ok(Ok(response)) => Err(response["error"]
            .as_str()
            .unwrap_or("Request failed")
            .into()),
        _ => Err("Desktop request timed out".into()),
    }
}
