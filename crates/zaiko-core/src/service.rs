use std::{collections::HashSet, sync::Arc, time::Duration};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use zbus::{Connection, Proxy, fdo, object_server::SignalEmitter};

use crate::{
    command::{self, CommandRequest},
    config::{self, Config},
    provider::{App, Client, LaunchMode, Message, Tools},
};

const BUS: &str = "org.zaiko.Companion";
const PATH: &str = "/org/zaiko/Companion";
const MAX_TEXT: usize = 8192;
const MAX_MESSAGES: usize = 32;
const MAX_HISTORY_BYTES: usize = 65_536;
const MAX_REQUEST_IDS: usize = 4096;

#[derive(Serialize)]
struct Snapshot {
    messages: Vec<Message>,
    state: &'static str,
    request_id: Option<String>,
    error: Option<String>,
    provider: String,
    model: String,
    models: Vec<String>,
}

struct Active {
    id: String,
    cancel: CancellationToken,
}

struct State {
    snapshot: Snapshot,
    active: Option<Active>,
    seen: HashSet<String>,
    stopping: bool,
}

impl State {
    fn reserve(
        &mut self,
        id: &str,
        content: String,
    ) -> fdo::Result<(CancellationToken, Vec<Message>)> {
        if id.is_empty()
            || id.len() > 128
            || !id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return Err(fdo::Error::InvalidArgs(
                "Request ID must contain 1–128 letters, digits, dots, hyphens or underscores."
                    .to_owned(),
            ));
        }
        if self.stopping {
            return Err(fdo::Error::Failed("Core is stopping.".to_owned()));
        }
        if self.seen.contains(id) {
            return Err(fdo::Error::Failed(
                "Duplicate request ID; request was not executed again.".to_owned(),
            ));
        }
        if self.active.is_some() {
            return Err(fdo::Error::Failed(
                "A request is already active.".to_owned(),
            ));
        }
        if self.seen.len() >= MAX_REQUEST_IDS {
            return Err(fdo::Error::Failed(
                "Session request limit reached. Restart Zaiko to start a new session.".to_owned(),
            ));
        }
        let cancel = CancellationToken::new();
        self.seen.insert(id.to_owned());
        self.active = Some(Active {
            id: id.to_owned(),
            cancel: cancel.clone(),
        });
        self.snapshot.request_id = Some(id.to_owned());
        self.snapshot.state = "thinking";
        self.snapshot.error = None;
        self.append(Message {
            role: "user".into(),
            content,
        });
        Ok((cancel, self.snapshot.messages.clone()))
    }

    fn append(&mut self, message: Message) {
        self.snapshot.messages.push(message);
        while self.snapshot.messages.len() > MAX_MESSAGES
            || self
                .snapshot
                .messages
                .iter()
                .map(|m| m.content.len())
                .sum::<usize>()
                > MAX_HISTORY_BYTES
        {
            self.snapshot.messages.remove(0);
        }
    }

    fn owns(&self, id: &str) -> bool {
        self.active
            .as_ref()
            .is_some_and(|active| active.id == id && !active.cancel.is_cancelled())
    }
}

struct Runtime {
    state: Mutex<State>,
    config: Result<Config, String>,
    shutdown: CancellationToken,
}

impl Runtime {
    fn new(config: Result<Config, String>) -> Arc<Self> {
        let error = config.as_ref().err().cloned();
        Arc::new(Self {
            state: Mutex::new(State {
                snapshot: Snapshot {
                    messages: Vec::new(),
                    state: if error.is_some() { "error" } else { "idle" },
                    request_id: None,
                    error,
                    provider: config
                        .as_ref()
                        .map(|c| c.provider.name().to_owned())
                        .unwrap_or_default(),
                    model: config.as_ref().map(|c| c.model.clone()).unwrap_or_default(),
                    models: config
                        .as_ref()
                        .map(|c| c.models.clone())
                        .unwrap_or_default(),
                },
                active: None,
                seen: HashSet::new(),
                stopping: false,
            }),
            config,
            shutdown: CancellationToken::new(),
        })
    }

    fn clean(&self, text: &str) -> String {
        match &self.config {
            Ok(config) => text.replace(&config.api_key, "[redacted]"),
            Err(_) => text.to_owned(),
        }
    }

    /// Returns a local reply and, for /model, the model to switch to once the
    /// request is accepted.
    fn slash_reply(&self, text: &str, snapshot: &Snapshot) -> Option<(String, Option<String>)> {
        let name = text.split_whitespace().next()?;
        if !name.starts_with('/') {
            return None;
        }
        match name {
            "/status" if text == "/status" => Some((self.status_reply(snapshot), None)),
            "/status" => Some(("ใช้ /status โดยไม่ใส่อาร์กิวเมนต์ค่ะ".into(), None)),
            "/model" => Some(self.model_reply(text, snapshot)),
            _ => Some((
                "ยังไม่รองรับคำสั่งนี้ค่ะ คำสั่งที่ใช้ได้: /status, /model, /exit".into(),
                None,
            )),
        }
    }

    fn model_reply(&self, text: &str, snapshot: &Snapshot) -> (String, Option<String>) {
        let args: Vec<&str> = text.split_whitespace().skip(1).collect();
        let config = match &self.config {
            Ok(config) => config,
            Err(error) => return (format!("ยังสลับโมเดลไม่ได้ค่ะ การตั้งค่า: {error}"), None),
        };
        let provider = config.provider.name();
        let current = &snapshot.model;
        match args.as_slice() {
            [] => (
                format!(
                    "โมเดล: {provider} · {current}\n       \
                     ใช้ /model <model-id> เพื่อสลับโมเดลในเซสชันนี้ค่ะ"
                ),
                None,
            ),
            // Never accept the API key as a model ID: snapshots are not redacted.
            [model] if !config::valid_model(model) || self.clean(model) != *model => (
                "model ID ไม่ถูกต้องค่ะ ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ / - : ไม่เกิน 128 ตัว".into(),
                None,
            ),
            [model] if model == current => (format!("ใช้ {provider} · {model} อยู่แล้วค่ะ"), None),
            [model] => (
                format!(
                    "สลับโมเดลเป็น {provider} · {model} แล้วค่ะ\n       \
                     ใช้เฉพาะเซสชันนี้ รีสตาร์ตแล้วจะกลับไปใช้ค่าจาก .env"
                ),
                Some((*model).to_owned()),
            ),
            _ => ("ใช้ /model หรือ /model <model-id> ค่ะ".into(), None),
        }
    }

    fn status_reply(&self, snapshot: &Snapshot) -> String {
        let (provider, model) = match &self.config {
            Ok(config) => (config.provider.name(), snapshot.model.as_str()),
            Err(_) => ("ยังไม่พร้อม", "ยังไม่พร้อม"),
        };
        let state = match snapshot.state {
            "idle" => "● ว่าง",
            "thinking" => "● กำลังคิด",
            "working" => "● กำลังทำงาน",
            "error" => "● ผิดพลาด",
            _ => "●",
        };
        // Replies render after "[Aiko] ", so continuation lines are indented
        // by its width. Thai uses a proportional fallback font even when the
        // desktop font is monospace, so labels are not padded into columns.
        let mut lines = vec![
            format!("สถานะ: {state} ({})", snapshot.state),
            format!("โมเดล: {provider} · {model}"),
            "สิทธิ์: บัญชีผู้ใช้ปัจจุบัน · ไม่มี sandbox".to_owned(),
            "ไฟล์/โฟลเดอร์สำคัญ: ยังไม่มีการป้องกัน".to_owned(),
        ];
        if let Err(error) = &self.config {
            lines.push(format!("การตั้งค่า: {error}"));
        }
        lines.join("\n       ")
    }

    async fn accept(
        self: &Arc<Self>,
        connection: &Connection,
        id: &str,
        text: &str,
        app: Option<(App, LaunchMode)>,
    ) -> fdo::Result<()> {
        let text = text.trim();
        if text.is_empty() || text.len() > MAX_TEXT {
            return Err(fdo::Error::InvalidArgs(
                "Text must contain 1–8192 UTF-8 bytes.".to_owned(),
            ));
        }
        let (cancel, history, model, local_reply) = {
            let mut state = self.state.lock().await;
            // Capture the state before reserving this request changes it to thinking.
            // Desktop actions do not enter the slash-command path.
            let local_reply = if app.is_none() {
                self.slash_reply(text, &state.snapshot)
            } else {
                None
            };
            let safe_text = self.clean(text);
            let (cancel, history) = state.reserve(id, safe_text.clone())?;
            // Switch only after the request is accepted, so a rejected /model
            // (busy or duplicate ID) changes nothing.
            let local_reply = local_reply.map(|(reply, model)| {
                if let Some(model) = model {
                    // Keep a typed, unlisted model selectable in the picker.
                    if !state.snapshot.models.contains(&model) {
                        state.snapshot.models.push(model.clone());
                    }
                    state.snapshot.model = model;
                }
                reply
            });
            let model = state.snapshot.model.clone();
            emit(
                connection,
                json!({"type":"message","request_id":id,"role":"user","content":safe_text}),
            )
            .await;
            emit(
                connection,
                json!({"type":"state","request_id":id,"state":"thinking"}),
            )
            .await;
            (cancel, history, model, local_reply)
        };
        let runtime = self.clone();
        let connection = connection.clone();
        let id = id.to_owned();
        tokio::spawn(async move {
            let work = async {
                // Local commands also work when provider configuration is invalid.
                if let Some(reply) = local_reply {
                    return Ok(Some(reply));
                }
                let mut tools = DesktopTools {
                    runtime: &runtime,
                    connection: &connection,
                    id: &id,
                };
                if let Some((app, mode)) = app {
                    let result = tools.open_app(app, mode).await?;
                    if result["success"] == true {
                        Ok(None)
                    } else {
                        Err(result["message"]
                            .as_str()
                            .unwrap_or("App launch failed.")
                            .to_owned())
                    }
                } else {
                    let mut config = runtime.config.clone()?;
                    config.model = model;
                    let client = Client::new(config)?;
                    client.chat(&history, &mut tools).await.map(Some)
                }
            };
            let result = tokio::select! {
                biased;
                _=cancel.cancelled()=>return,
                result=tokio::time::timeout(Duration::from_secs(300),work)=>match result {
                    Ok(result)=>result,
                    Err(_)=>Err("Request timed out. You can try again.".to_owned()),
                }
            };
            runtime.finish(&connection, &id, result).await;
        });
        Ok(())
    }

    async fn finish(
        &self,
        connection: &Connection,
        id: &str,
        result: Result<Option<String>, String>,
    ) {
        let mut state = self.state.lock().await;
        if !state.owns(id) {
            return;
        }
        state.active = None;
        state.snapshot.request_id = None;
        match result {
            Ok(reply) => {
                if let Some(content) = reply {
                    let content = self.clean(&content);
                    state.append(Message {
                        role: "assistant".into(),
                        content: content.clone(),
                    });
                    emit(connection,json!({"type":"message","request_id":id,"role":"assistant","content":content})).await;
                }
                state.snapshot.state = "idle";
                state.snapshot.error = None;
                emit(
                    connection,
                    json!({"type":"state","request_id":id,"state":"idle"}),
                )
                .await;
            }
            Err(error) => {
                let error = self.clean(&error);
                state.snapshot.state = "error";
                state.snapshot.error = Some(error.clone());
                emit(
                    connection,
                    json!({"type":"error","request_id":id,"state":"error","message":error}),
                )
                .await;
            }
        }
    }

    async fn cancel(&self, connection: &Connection, id: &str) {
        let mut state = self.state.lock().await;
        if !state.owns(id) {
            return;
        }
        if let Some(active) = state.active.take() {
            active.cancel.cancel();
        }
        state.snapshot.request_id = None;
        state.snapshot.state = "idle";
        state.snapshot.error = None;
        let content = "Request cancelled; running command processes are being stopped. Completed changes and app launches cannot be undone.";
        state.append(Message {
            role: "assistant".into(),
            content: content.into(),
        });
        emit(
            connection,
            json!({"type":"message","request_id":id,"role":"assistant","content":content}),
        )
        .await;
        emit(
            connection,
            json!({"type":"state","request_id":id,"state":"idle"}),
        )
        .await;
    }
}

struct DesktopTools<'a> {
    runtime: &'a Runtime,
    connection: &'a Connection,
    id: &'a str,
}

impl Tools for DesktopTools<'_> {
    async fn run_command(&mut self, request: CommandRequest) -> Result<Value, String> {
        {
            let mut state = self.runtime.state.lock().await;
            if !state.owns(self.id) {
                return Err("Request cancelled.".into());
            }
            state.snapshot.state = "working";
            emit(self.connection, json!({"type":"state","request_id":self.id,"state":"working","content":"Running command…"})).await;
        }
        let command = request.command.clone();
        let mut result = match command::run(request).await {
            Ok(output) => serde_json::to_value(output).expect("command output serialization"),
            Err(message) => json!({"success":false,"message":message}),
        };
        // Redact before returning output to either the model or desktop.
        if let Some(fields) = result.as_object_mut() {
            for value in fields.values_mut() {
                if let Some(text) = value.as_str() {
                    *value = json!(self.runtime.clean(text));
                }
            }
        }
        let mut state = self.runtime.state.lock().await;
        if !state.owns(self.id) {
            return Err("Request cancelled.".into());
        }
        let mut content = format!("Command: {}", truncate(&self.runtime.clean(&command), 1024));
        if let Some(message) = result["message"].as_str() {
            content.push_str(&format!("\n{message}"));
        } else {
            content.push_str(&format!(
                "\nDirectory: {}\nExit: {}{}{}",
                result["workdir"].as_str().unwrap_or_default(),
                result["exit_code"],
                if result["timed_out"] == true {
                    " (timed out)"
                } else {
                    ""
                },
                if result["truncated"] == true {
                    " (output truncated)"
                } else {
                    ""
                }
            ));
            for stream in ["stdout", "stderr"] {
                if let Some(text) = result[stream].as_str().filter(|text| !text.is_empty()) {
                    content.push_str(&format!("\n{stream}: {}", truncate(text, 2048)));
                }
            }
        }
        state.append(Message {
            role: "assistant".into(),
            content: content.clone(),
        });
        emit(
            self.connection,
            json!({"type":"message","request_id":self.id,"role":"assistant","content":content}),
        )
        .await;
        state.snapshot.state = "thinking";
        emit(
            self.connection,
            json!({"type":"state","request_id":self.id,"state":"thinking"}),
        )
        .await;
        Ok(result)
    }

    async fn open_app(&mut self, app: App, mode: LaunchMode) -> Result<Value, String> {
        {
            let mut state = self.runtime.state.lock().await;
            if !state.owns(self.id) {
                return Err("Request cancelled.".into());
            }
            state.snapshot.state = "working";
            emit(self.connection,json!({"type":"state","request_id":self.id,"state":"working","content":format!("Opening {}…",app.name())})).await;
        }
        let result = tokio::time::timeout(Duration::from_secs(10), async {
            let desktop = Proxy::new(
                self.connection,
                "org.zaiko.Desktop",
                "/org/zaiko/Desktop",
                "org.zaiko.Desktop",
            )
            .await?;
            if app == App::Terminal && mode != LaunchMode::Default {
                desktop
                    .call::<_, _, (bool, String)>("OpenTerminal", &(mode.name(),))
                    .await
            } else {
                desktop
                    .call::<_, _, (bool, String)>("OpenApp", &(app.name(),))
                    .await
            }
        })
        .await;
        let (success, message) = match result {
            Ok(Ok((success, message))) => (success, message),
            Ok(Err(_)) => (
                false,
                "Desktop service is unavailable. Enable the Zaiko GNOME extension.".into(),
            ),
            Err(_) => (
                false,
                "Desktop app request timed out; launch outcome is unknown.".into(),
            ),
        };
        let message = truncate(&self.runtime.clean(&message), 2048);
        let mut state = self.runtime.state.lock().await;
        if !state.owns(self.id) {
            return Err("Request cancelled.".into());
        }
        let content = format!("{}: {}", app.name(), message);
        state.append(Message {
            role: "assistant".into(),
            content: content.clone(),
        });
        emit(
            self.connection,
            json!({"type":"message","request_id":self.id,"role":"assistant","content":content}),
        )
        .await;
        state.snapshot.state = "thinking";
        emit(
            self.connection,
            json!({"type":"state","request_id":self.id,"state":"thinking"}),
        )
        .await;
        Ok(json!({"success":success,"message":message,"app":app.name(),"mode":mode.name()}))
    }
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

async fn emit(connection: &Connection, payload: Value) {
    let _ = connection
        .emit_signal(None::<&str>, PATH, BUS, "Event", &(payload.to_string(),))
        .await;
}

struct Companion {
    runtime: Arc<Runtime>,
}

#[zbus::interface(name = "org.zaiko.Companion")]
impl Companion {
    async fn submit(
        &self,
        request_id: &str,
        text: &str,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<()> {
        self.runtime
            .accept(connection, request_id, text, None)
            .await
    }

    async fn open_app(
        &self,
        request_id: &str,
        app: &str,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<()> {
        let app = App::parse(app).map_err(fdo::Error::InvalidArgs)?;
        self.runtime
            .accept(
                connection,
                request_id,
                &format!("Open {}", app.name()),
                Some((app, LaunchMode::Default)),
            )
            .await
    }

    async fn open_terminal(
        &self,
        request_id: &str,
        mode: &str,
        #[zbus(connection)] connection: &Connection,
    ) -> fdo::Result<()> {
        let mode = LaunchMode::parse(mode).map_err(fdo::Error::InvalidArgs)?;
        self.runtime
            .accept(
                connection,
                request_id,
                &format!("Open terminal ({})", mode.name()),
                Some((App::Terminal, mode)),
            )
            .await
    }

    async fn cancel(&self, request_id: &str, #[zbus(connection)] connection: &Connection) {
        self.runtime.cancel(connection, request_id).await;
    }

    async fn get_snapshot(&self) -> String {
        serde_json::to_string(&self.runtime.state.lock().await.snapshot)
            .expect("snapshot serialization")
    }

    async fn show(&self, #[zbus(connection)] connection: &Connection) {
        emit(connection, json!({"type":"present"})).await;
        let connection = connection.clone();
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(3), async {
                let desktop = Proxy::new(
                    &connection,
                    "org.zaiko.Desktop",
                    "/org/zaiko/Desktop",
                    "org.zaiko.Desktop",
                )
                .await?;
                desktop.call::<_, _, ()>("Present", &()).await
            })
            .await;
        });
    }

    async fn quit(&self) {
        let mut state = self.runtime.state.lock().await;
        state.stopping = true;
        if let Some(active) = state.active.take() {
            active.cancel.cancel();
        }
        let shutdown = self.runtime.shutdown.clone();
        tokio::spawn(async move {
            // Let the D-Bus method response leave before releasing the service.
            tokio::time::sleep(Duration::from_millis(50)).await;
            shutdown.cancel();
        });
    }

    #[zbus(signal)]
    async fn event(emitter: &SignalEmitter<'_>, payload: &str) -> zbus::Result<()>;
}

pub async fn run(config: Result<Config, String>) -> Result<(), String> {
    let runtime = Runtime::new(config);
    let connection = zbus::connection::Builder::session()
        .map_err(|_| "Cannot connect to the session D-Bus.".to_owned())?
        .serve_at(
            PATH,
            Companion {
                runtime: runtime.clone(),
            },
        )
        .map_err(|_| "Cannot register the core D-Bus interface.".to_owned())?
        .build()
        .await
        .map_err(|_| {
            "Cannot start core service. Is Zaiko already running, or is session D-Bus unavailable?"
                .to_owned()
        })?;
    // Set DoNotQueue explicitly. Builder::name() in zbus 5.19 queues by
    // default despite its documentation describing a DoNotQueue default.
    let ownership = connection
        .request_name_with_flags(BUS, zbus::fdo::RequestNameFlags::DoNotQueue.into())
        .await
        .map_err(|_| "Cannot own core service name. Is Zaiko already running?".to_owned())?;
    if !matches!(
        ownership,
        zbus::fdo::RequestNameReply::PrimaryOwner | zbus::fdo::RequestNameReply::AlreadyOwner
    ) {
        return Err("Zaiko is already running.".to_owned());
    }
    tokio::select! {
        _=runtime.shutdown.cancelled()=>{},
        _=tokio::signal::ctrl_c()=>{},
        _=terminate_signal()=>{},
    }
    let mut state = runtime.state.lock().await;
    state.stopping = true;
    if let Some(active) = state.active.take() {
        active.cancel.cancel();
    }
    Ok(())
}

#[cfg(unix)]
async fn terminate_signal() {
    if let Ok(mut signal) =
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
    {
        signal.recv().await;
    } else {
        std::future::pending::<()>().await;
    }
}

#[cfg(not(unix))]
async fn terminate_signal() {
    std::future::pending::<()>().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn status_reports_runtime_configuration_without_credentials() {
        let runtime = Runtime::new(Ok(Config {
            provider: crate::config::Provider::DeepSeek,
            model: "test-model".into(),
            models: vec!["test-model".into()],
            api_key: "dummy-secret-value".into(),
        }));
        let state = runtime.state.lock().await;
        let (reply, model) = runtime.slash_reply("/status", &state.snapshot).unwrap();
        assert!(model.is_none());
        assert_eq!(
            reply,
            "สถานะ: ● ว่าง (idle)\n       โมเดล: deepseek · test-model\n       \
             สิทธิ์: บัญชีผู้ใช้ปัจจุบัน · ไม่มี sandbox\n       ไฟล์/โฟลเดอร์สำคัญ: ยังไม่มีการป้องกัน"
        );
        assert!(!reply.contains("dummy-secret-value"));
        assert!(runtime.slash_reply("สวัสดี", &state.snapshot).is_none());
    }

    #[tokio::test]
    async fn model_command_switches_only_valid_non_secret_ids() {
        let runtime = Runtime::new(Ok(Config {
            provider: crate::config::Provider::OpenAi,
            model: "gpt-6.1-sol".into(),
            models: vec!["gpt-6.1-sol".into()],
            api_key: "dummy-secret-value".into(),
        }));
        let state = runtime.state.lock().await;
        let reply = |text| runtime.slash_reply(text, &state.snapshot).unwrap();
        let (show, none) = reply("/model");
        assert!(show.starts_with("โมเดล: openai · gpt-6.1-sol"));
        assert!(none.is_none());
        assert_eq!(
            reply("/model  gpt-6.1-mini ").1.as_deref(),
            Some("gpt-6.1-mini")
        );
        assert!(reply("/model gpt-6.1-sol").1.is_none());
        for invalid in ["/model bad$id", "/model dummy-secret-value", "/model a b"] {
            let (text, model) = reply(invalid);
            assert!(model.is_none());
            assert!(!text.contains("dummy-secret-value"));
        }
        let broken = Runtime::new(Err("Missing test config".into()));
        let state = broken.state.lock().await;
        assert!(
            broken
                .slash_reply("/model x", &state.snapshot)
                .unwrap()
                .1
                .is_none()
        );
    }

    #[tokio::test]
    async fn request_ids_and_active_slot_prevent_reexecution() {
        let runtime = Runtime::new(Err("Missing test config".into()));
        let mut state = runtime.state.lock().await;
        assert!(state.reserve("one", "เปิด terminal".into()).is_ok());
        assert!(state.reserve("one", "again".into()).is_err());
        assert!(state.reserve("two", "busy".into()).is_err());
        state.active.take().unwrap().cancel.cancel();
        assert!(state.reserve("one", "old id".into()).is_err());
        assert!(state.reserve("two", "new id".into()).is_ok());
        assert!(!state.owns("one"));
        assert!(state.owns("two"));
    }

    #[tokio::test]
    async fn history_is_bounded_and_snapshot_has_no_credentials() {
        let runtime = Runtime::new(Ok(Config {
            provider: crate::config::Provider::OpenAi,
            model: "gpt-6.1-sol".into(),
            models: vec!["gpt-6.1-sol".into()],
            api_key: "dummy-secret-value".into(),
        }));
        let mut state = runtime.state.lock().await;
        for _ in 0..100 {
            state.append(Message {
                role: "user".into(),
                content: "x".repeat(4096),
            });
        }
        assert!(
            state
                .snapshot
                .messages
                .iter()
                .map(|m| m.content.len())
                .sum::<usize>()
                <= MAX_HISTORY_BYTES
        );
        assert!(
            !serde_json::to_string(&state.snapshot)
                .unwrap()
                .contains("dummy-secret-value")
        );
    }
}
