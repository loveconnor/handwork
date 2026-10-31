#![cfg(feature = "desktop-host")]
use handwork_mobile_link::{exchange, watch, Address, Identity};
use serde_json::{json, Value};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::test]
async fn electron_stdio_host_serves_the_phone_protocol_and_closes_on_parent_exit() {
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_handwork-mobile-host"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut lines = BufReader::new(child.stdout.take().unwrap()).lines();
    macro_rules! send {
        ($value:expr) => {
            input
                .write_all(format!("{}\n", $value).as_bytes())
                .await
                .unwrap()
        };
    }
    macro_rules! receive {
        () => {
            serde_json::from_str::<Value>(
                &tokio::time::timeout(std::time::Duration::from_secs(10), lines.next_line())
                    .await
                    .unwrap()
                    .unwrap()
                    .unwrap(),
            )
            .unwrap()
        };
    }
    let desktop = Identity::generate().unwrap();
    let phone = Identity::generate().unwrap();
    send!(json!({"id":1,"op":"allow","fingerprint":phone.fingerprint().unwrap()}));
    assert_eq!(receive!()["ok"], true);
    send!(json!({"id":2,"op":"start","identity":desktop,"port":0}));
    let started = receive!();
    assert_eq!(started["ok"], true);
    let address = Address {
        host: "127.0.0.1".into(),
        port: started["result"]["port"].as_u64().unwrap() as u16,
    };
    let client = phone.clone();
    let pin = desktop.fingerprint().unwrap();
    let addr = address.clone();
    let request = tokio::spawn(async move {
        exchange(
            &client,
            &pin,
            &[addr],
            json!({"version":1,"id":"read","method":"workspace.list","params":{}}),
        )
        .await
    });
    let event = receive!();
    assert_eq!(event["event"], "request");
    assert_eq!(event["peer"], phone.fingerprint().unwrap());
    send!(
        json!({"op":"reply","requestId":event["requestId"],"response":{"ok":true,"result":{"projects":[],"sessions":[],"monos":[]}}})
    );
    assert_eq!(request.await.unwrap().unwrap()["projects"], json!([]));
    let client = phone.clone();
    let pin = desktop.fingerprint().unwrap();
    let addr = address.clone();
    let watching = tokio::spawn(async move {
        watch(&client, &pin, &[addr], json!({"version":1,"id":"watch","method":"conversation.watch","params":{"conversationId":"s1"}})).await
    });
    let event = receive!();
    assert_eq!(event["event"], "watch");
    send!(
        json!({"op":"reply","requestId":event["requestId"],"response":{"ok":true,"result":null}})
    );
    let watch = watching.await.unwrap().unwrap();
    send!(
        json!({"id":3,"op":"push","watchId":event["requestId"],"update":{"busy":true,"order":[],"turns":[]}})
    );
    assert_eq!(receive!()["ok"], true);
    let frames = watch.next(std::time::Duration::from_secs(1)).await.unwrap();
    assert_eq!(frames[0]["busy"], true);
    drop(input);
    assert!(
        tokio::time::timeout(std::time::Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
