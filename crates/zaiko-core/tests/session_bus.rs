use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use serde_json::Value;
use zbus::{Connection, Proxy};

struct Process(Child);
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

struct Bus {
    _daemon: Process,
    address: String,
}
impl Bus {
    fn start() -> Self {
        let mut daemon = Command::new("dbus-daemon")
            .args(["--session", "--nofork", "--print-address=1"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("dbus-daemon is required for integration tests");
        let mut address = String::new();
        BufReader::new(daemon.stdout.take().unwrap())
            .read_line(&mut address)
            .unwrap();
        Self {
            _daemon: Process(daemon),
            address: address.trim().to_owned(),
        }
    }

    fn core(&self) -> Process {
        // No inherited provider credentials, config files, or real desktop bus.
        Process(
            Command::new(env!("CARGO_BIN_EXE_zaiko-core"))
                .args(["--config", "/dev/null"])
                .env_clear()
                .env("DBUS_SESSION_BUS_ADDRESS", &self.address)
                .env("ZAIKO_LLM_MODEL", "gpt-6.1-sol")
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        )
    }

    async fn connection(&self) -> Connection {
        zbus::connection::Builder::address(self.address.as_str())
            .unwrap()
            .build()
            .await
            .unwrap()
    }
}

struct Desktop {
    calls: Arc<AtomicUsize>,
}
#[zbus::interface(name = "org.zaiko.Desktop")]
impl Desktop {
    async fn present(&self) {}
    async fn open_app(&self, app: &str) -> (bool, String) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if app == "terminal" {
            tokio::time::sleep(Duration::from_millis(200)).await;
        }
        (true, format!("Launch requested for {app}."))
    }
    async fn open_terminal(&self, mode: &str) -> (bool, String) {
        self.calls.fetch_add(1, Ordering::SeqCst);
        (true, format!("Terminal mode requested: {mode}."))
    }
}

async fn snapshot(proxy: &Proxy<'_>) -> Value {
    let value: String = proxy.call("GetSnapshot", &()).await.unwrap();
    serde_json::from_str(&value).unwrap()
}

async fn ready<'a>(connection: &'a Connection) -> Proxy<'a> {
    let proxy = Proxy::new(
        connection,
        "org.zaiko.Companion",
        "/org/zaiko/Companion",
        "org.zaiko.Companion",
    )
    .await
    .unwrap();
    for _ in 0..100 {
        if proxy.call::<_, _, String>("GetSnapshot", &()).await.is_ok() {
            return proxy;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("core did not acquire its service name");
}

async fn idle(proxy: &Proxy<'_>) -> Value {
    for _ in 0..100 {
        let value = snapshot(proxy).await;
        if value["state"] == "idle" && value["request_id"].is_null() {
            return value;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("request did not finish");
}

#[tokio::test]
async fn slash_commands_work_without_provider_config_and_keep_request_guards() {
    let bus = Bus::start();
    let _core = bus.core();
    let connection = bus.connection().await;
    let proxy = ready(&connection).await;

    proxy
        .call::<_, _, ()>("Submit", &("status-one", "  /status\n"))
        .await
        .unwrap();
    let result = idle(&proxy).await;
    let reply = result["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    // A successful reply with no API key proves this did not enter the provider path.
    assert!(reply.starts_with("สถานะ: ● ผิดพลาด (error)"));
    assert!(reply.contains("OPENAI_API_KEY"));
    assert!(reply.contains("ไม่มี sandbox"));
    assert!(result["error"].is_null());
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("status-one", "/status"))
            .await
            .is_err()
    );
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("invalid id", "/status"))
            .await
            .is_err()
    );

    for (id, text, expected) in [
        ("status-args", "/status extra", "ไม่ใส่อาร์กิวเมนต์"),
        ("unknown-command", "/sandbox", "ยังไม่รองรับคำสั่งนี้"),
        (
            "permissions-show",
            "/permissions",
            "สิทธิ์: Full Access (full)",
        ),
        (
            "permissions-bad",
            "/permissions maybe",
            "ใช้ /permissions ask",
        ),
        ("permissions-ask", " /permissions ask ", "Ask for approval"),
        (
            "permissions-status",
            "/status",
            "สิทธิ์: Ask for approval (ask)",
        ),
        ("permissions-full", "/permissions full", "Full Access"),
        (
            "permissions-again",
            "/permissions",
            "สิทธิ์: Full Access (full)",
        ),
        ("model-unready", "/model gpt-6.1-mini", "ยังสลับโมเดลไม่ได้"),
        ("status-again", "/status", "สถานะ: ● ว่าง (idle)"),
        ("removed-mock", "/s001", "ยังไม่รองรับคำสั่งนี้"),
        ("clear-args", "/clear all", "ใช้ /clear โดยไม่ใส่อาร์กิวเมนต์"),
    ] {
        proxy.call::<_, _, ()>("Submit", &(id, text)).await.unwrap();
        let result = idle(&proxy).await;
        assert!(
            result["messages"].as_array().unwrap().last().unwrap()["content"]
                .as_str()
                .unwrap()
                .contains(expected)
        );
    }

    assert_eq!(snapshot(&proxy).await["permissions"], "full");
    proxy
        .call::<_, _, ()>("Submit", &("permissions-snapshot", "/permissions ask"))
        .await
        .unwrap();
    assert_eq!(idle(&proxy).await["permissions"], "ask");

    // /clear and /cls empty the conversation without adding a message.
    for (id, text) in [
        ("clear", " /clear "),
        ("status-before-cls", "/status"),
        ("cls", "/cls"),
    ] {
        proxy.call::<_, _, ()>("Submit", &(id, text)).await.unwrap();
        let result = idle(&proxy).await;
        assert_eq!(
            result["messages"].as_array().unwrap().is_empty(),
            text != "/status"
        );
        assert!(result["error"].is_null());
    }
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("clear", "/clear"))
            .await
            .is_err()
    );

    let _desktop = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .serve_at(
            "/org/zaiko/Desktop",
            Desktop {
                calls: Arc::new(AtomicUsize::new(0)),
            },
        )
        .unwrap()
        .name("org.zaiko.Desktop")
        .unwrap()
        .build()
        .await
        .unwrap();
    // Local commands share the existing request slot and cannot interrupt active work.
    proxy
        .call::<_, _, ()>("OpenApp", &("working", "terminal"))
        .await
        .unwrap();
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("busy-status", "/status"))
            .await
            .is_err()
    );
    assert_eq!(snapshot(&proxy).await["request_id"], "working");
    // A rejected request never changes the permission mode.
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("busy-permissions", "/permissions full"))
            .await
            .is_err()
    );
    assert_eq!(snapshot(&proxy).await["permissions"], "ask");
    proxy
        .call::<_, _, ()>("Cancel", &("working",))
        .await
        .unwrap();
    proxy
        .call::<_, _, ()>("Submit", &("busy-status", "/status"))
        .await
        .unwrap();
    idle(&proxy).await;
    proxy.call::<_, _, ()>("Quit", &()).await.unwrap();
}

#[tokio::test]
async fn model_command_switches_the_session_model_without_contacting_the_provider() {
    let bus = Bus::start();
    // A dummy key makes the config valid; /model must still stay local.
    let _core = Process(
        Command::new(env!("CARGO_BIN_EXE_zaiko-core"))
            .args(["--config", "/dev/null"])
            .env_clear()
            .env("DBUS_SESSION_BUS_ADDRESS", &bus.address)
            .env("ZAIKO_LLM_MODEL", "gpt-6.1-sol")
            .env("OPENAI_API_KEY", "dummy-model-secret")
            .env(
                "ZAIKO_LLM_MODELS",
                "gpt-6.1-mini,gpt-6.1-nano,deepseek-flash",
            )
            .env("DEEPSEEK_API_KEY", "dummy-deepseek-secret")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let connection = bus.connection().await;
    let proxy = ready(&connection).await;
    assert_eq!(snapshot(&proxy).await["model"], "gpt-6.1-sol");
    assert_eq!(
        snapshot(&proxy).await["models"],
        serde_json::json!([
            "gpt-6.1-sol",
            "gpt-6.1-mini",
            "gpt-6.1-nano",
            "deepseek-flash"
        ])
    );

    for (id, text, model, expected) in [
        (
            "model-show",
            "/model",
            "gpt-6.1-sol",
            "โมเดล: openai · gpt-6.1-sol",
        ),
        ("model-switch", " /model gpt-6.1-mini ", "gpt-6.1-mini", ""),
        (
            "model-bad",
            "/model bad$id",
            "gpt-6.1-mini",
            "model ID ไม่ถูกต้อง",
        ),
        (
            "model-secret",
            "/model dummy-model-secret",
            "gpt-6.1-mini",
            "model ID ไม่ถูกต้อง",
        ),
        (
            "model-status",
            "/status",
            "gpt-6.1-mini",
            "โมเดล: openai · gpt-6.1-mini",
        ),
        (
            "model-deepseek",
            "/model deepseek-flash",
            "deepseek-flash",
            "",
        ),
        (
            "model-deepseek-status",
            "/status",
            "deepseek-flash",
            "โมเดล: deepseek · deepseek-flash",
        ),
        (
            "model-deepseek-secret",
            "/model dummy-deepseek-secret",
            "deepseek-flash",
            "model ID ไม่ถูกต้อง",
        ),
    ] {
        let before = snapshot(&proxy).await["messages"].clone();
        proxy.call::<_, _, ()>("Submit", &(id, text)).await.unwrap();
        let result = idle(&proxy).await;
        assert_eq!(result["model"], model);
        if expected.is_empty() {
            // A switch adds nothing to the Log or the history sent to the provider.
            assert_eq!(result["messages"], before);
        } else {
            assert!(
                result["messages"].as_array().unwrap().last().unwrap()["content"]
                    .as_str()
                    .unwrap()
                    .contains(expected)
            );
        }
        assert!(!result.to_string().contains("dummy-model-secret"));
        assert!(!result.to_string().contains("dummy-deepseek-secret"));
    }
    // A reused request ID is rejected and never switches the model.
    assert!(
        proxy
            .call::<_, _, ()>("Submit", &("model-switch", "/model gpt-6.1-nano"))
            .await
            .is_err()
    );
    assert_eq!(snapshot(&proxy).await["model"], "deepseek-flash");
    // An unlisted model chosen by ID joins the picker list.
    proxy
        .call::<_, _, ()>("Submit", &("model-custom", "/model gpt-custom"))
        .await
        .unwrap();
    let result = idle(&proxy).await;
    assert_eq!(result["models"].as_array().unwrap().len(), 5);
    // gpt-custom is inferred as OpenAI even though DeepSeek was active.
    assert_eq!(result["provider"], "openai");
    proxy.call::<_, _, ()>("Quit", &()).await.unwrap();
}

#[tokio::test]
async fn service_runs_without_key_and_rejects_duplicate_instances_and_requests() {
    let bus = Bus::start();
    let _core = bus.core();
    let connection = bus.connection().await;
    let proxy = ready(&connection).await;
    let first = snapshot(&proxy).await;
    assert_eq!(first["state"], "error");
    assert!(first["error"].as_str().unwrap().contains("OPENAI_API_KEY"));

    let mut duplicate = bus.core();
    let mut duplicate_exit = None;
    for _ in 0..100 {
        duplicate_exit = duplicate.0.try_wait().unwrap();
        if duplicate_exit.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(
        duplicate_exit.is_some_and(|status| !status.success()),
        "duplicate core must not wait in the bus queue"
    );

    let calls = Arc::new(AtomicUsize::new(0));
    let _desktop = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .serve_at(
            "/org/zaiko/Desktop",
            Desktop {
                calls: calls.clone(),
            },
        )
        .unwrap()
        .name("org.zaiko.Desktop")
        .unwrap()
        .build()
        .await
        .unwrap();

    proxy
        .call::<_, _, ()>("OpenApp", &("launch-one", "terminal"))
        .await
        .unwrap();
    assert!(
        proxy
            .call::<_, _, ()>("OpenApp", &("launch-one", "terminal"))
            .await
            .is_err()
    );
    assert!(
        proxy
            .call::<_, _, ()>("OpenApp", &("launch-busy", "vscode"))
            .await
            .is_err()
    );
    let finished = idle(&proxy).await;
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(finished["messages"].as_array().unwrap().iter().any(|m| {
        m["content"]
            .as_str()
            .is_some_and(|s| s.contains("Launch requested"))
    }));
    assert!(
        proxy
            .call::<_, _, ()>("OpenApp", &("launch-one", "terminal"))
            .await
            .is_err()
    );
    assert!(
        proxy
            .call::<_, _, ()>("OpenApp", &("unsupported", "note"))
            .await
            .is_err()
    );

    // Configuration errors are visible and recoverable; no network request is made.
    proxy
        .call::<_, _, ()>("Submit", &("chat-one", "สวัสดี"))
        .await
        .unwrap();
    for _ in 0..100 {
        if snapshot(&proxy).await["state"] == "error" {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(snapshot(&proxy).await["state"], "error");
    proxy
        .call::<_, _, ()>("OpenApp", &("recover", "vscode"))
        .await
        .unwrap();
    idle(&proxy).await;
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    proxy.call::<_, _, ()>("Quit", &()).await.unwrap();
}

#[tokio::test]
async fn cancellation_releases_slot_and_old_work_cannot_overwrite_new_snapshot() {
    let bus = Bus::start();
    let _core = bus.core();
    let connection = bus.connection().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let _desktop = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .serve_at(
            "/org/zaiko/Desktop",
            Desktop {
                calls: calls.clone(),
            },
        )
        .unwrap()
        .name("org.zaiko.Desktop")
        .unwrap()
        .build()
        .await
        .unwrap();
    let proxy = ready(&connection).await;
    proxy
        .call::<_, _, ()>("OpenApp", &("cancel-me", "terminal"))
        .await
        .unwrap();
    for _ in 0..100 {
        if calls.load(Ordering::SeqCst) > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    proxy
        .call::<_, _, ()>("Cancel", &("cancel-me",))
        .await
        .unwrap();
    proxy
        .call::<_, _, ()>("OpenApp", &("after-cancel", "vscode"))
        .await
        .unwrap();
    let finished = idle(&proxy).await;
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert_eq!(snapshot(&proxy).await, finished);
    let text = finished.to_string();
    assert!(text.contains("Launch requested for vscode"));
    assert!(!text.contains("Launch requested for terminal"));
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(
        proxy
            .call::<_, _, ()>("OpenApp", &("cancel-me", "terminal"))
            .await
            .is_err()
    );
}

#[tokio::test]
async fn terminal_modes_cross_the_bus_without_provider_credentials() {
    let bus = Bus::start();
    let _core = bus.core();
    let connection = bus.connection().await;
    let calls = Arc::new(AtomicUsize::new(0));
    let _desktop = zbus::connection::Builder::address(bus.address.as_str())
        .unwrap()
        .serve_at(
            "/org/zaiko/Desktop",
            Desktop {
                calls: calls.clone(),
            },
        )
        .unwrap()
        .name("org.zaiko.Desktop")
        .unwrap()
        .build()
        .await
        .unwrap();
    let proxy = ready(&connection).await;
    for (mode, expected) in [
        ("default", "Launch requested for terminal."),
        ("tab", "Terminal mode requested: tab."),
        ("standalone", "Terminal mode requested: standalone."),
    ] {
        proxy
            .call::<_, _, ()>("OpenTerminal", &(mode, mode))
            .await
            .unwrap();
        let finished = idle(&proxy).await;
        assert!(
            finished["messages"]
                .as_array()
                .unwrap()
                .iter()
                .any(|message| {
                    message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains(expected))
                })
        );
        assert!(
            proxy
                .call::<_, _, ()>("OpenTerminal", &(mode, mode))
                .await
                .is_err()
        );
    }
    assert!(
        proxy
            .call::<_, _, ()>("OpenTerminal", &("invalid-mode", "shell"))
            .await
            .is_err()
    );
    assert_eq!(calls.load(Ordering::SeqCst), 3);
}

#[test]
fn configuration_uses_process_environment_before_explicit_dotenv_without_echoing_keys() {
    let path = std::env::temp_dir().join(format!(
        "zaiko-core-config-test-{}-{}.env",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::write(&path,"ZAIKO_LLM_PROVIDER=deepseek\nZAIKO_LLM_MODEL=deepseek-chat\nDEEPSEEK_API_KEY=dummy-file-secret\nOPENAI_API_KEY=\n").unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_zaiko-core"))
        .arg("--config")
        .arg(&path)
        .arg("--check-config")
        .env_clear()
        .env("ZAIKO_LLM_PROVIDER", "openai")
        .env("ZAIKO_LLM_MODEL", "gpt-6.1-sol")
        .env("OPENAI_API_KEY", "dummy-process-secret")
        .output()
        .unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).unwrap();
    let stderr = String::from_utf8(output.stderr).unwrap();
    assert!(stdout.contains("provider=openai, model=gpt-6.1-sol"));
    assert!(!stdout.contains("dummy-"));
    assert!(!stderr.contains("dummy-"));
}
