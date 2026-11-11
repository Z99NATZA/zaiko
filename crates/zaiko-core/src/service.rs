use std::{collections::HashSet, sync::Arc, time::Duration};

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::Mutex;
use tokio_util::sync::CancellationToken;
use zbus::{Connection, Proxy, fdo, object_server::SignalEmitter};

use crate::{
    command::{self, CommandRequest},
    config::{Config, ModelChoice},
    provider::{App, Client, LaunchMode, Message, Permissions, Tools},
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
    permissions: &'static str,
}

struct Active {
    id: String,
    cancel: CancellationToken,
}

struct State {
    snapshot: Snapshot,
    /// Session model and picker choices; None/empty while configuration is invalid.
    model: Option<ModelChoice>,
    models: Vec<ModelChoice>,
    permissions: Permissions,
    active: Option<Active>,
    seen: HashSet<String>,
    stopping: bool,
}

/// A slash command handled by the core without the provider.
enum Local {
    Reply(String),
    /// A /model switch: applied at once, with no message or reply.
    Switch(ModelChoice),
    /// /clear or /cls: forget the conversation, with no message or reply.
    Clear,
    /// /permissions ask|full: applied once the request is accepted, then replies.
    Permissions(Permissions, String),
}

impl State {
    /// Checks the request ID and active slot, then marks the ID as used.
    fn admit(&mut self, id: &str) -> fdo::Result<()> {
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
        self.seen.insert(id.to_owned());
        Ok(())
    }

    fn reserve(
        &mut self,
        id: &str,
        content: String,
    ) -> fdo::Result<(CancellationToken, Vec<Message>)> {
        self.admit(id)?;
        let cancel = CancellationToken::new();
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

    fn set_model(&mut self, choice: ModelChoice) {
        // Keep a typed, unlisted model selectable in the picker.
        if !self.models.contains(&choice) {
            self.models.push(choice.clone());
        }
        self.snapshot.models = self.models.iter().map(|c| c.model.clone()).collect();
        self.snapshot.models.dedup();
        self.snapshot.provider = choice.provider.name().to_owned();
        self.snapshot.model = choice.model.clone();
        self.model = Some(choice);
    }

    fn set_permissions(&mut self, permissions: Permissions) {
        self.permissions = permissions;
        self.snapshot.permissions = permissions.name();
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
        let mut state = State {
            snapshot: Snapshot {
                messages: Vec::new(),
                state: if error.is_some() { "error" } else { "idle" },
                request_id: None,
                error,
                provider: String::new(),
                model: String::new(),
                models: Vec::new(),
                permissions: Permissions::default().name(),
            },
            model: None,
            models: Vec::new(),
            permissions: Permissions::default(),
            active: None,
            seen: HashSet::new(),
            stopping: false,
        };
        if let Ok(config) = &config {
            state.models = config.models.clone();
            state.set_model(ModelChoice {
                provider: config.provider,
                model: config.model.clone(),
            });
        }
        Arc::new(Self {
            state: Mutex::new(state),
            config,
            shutdown: CancellationToken::new(),
        })
    }

    fn clean(&self, text: &str) -> String {
        match &self.config {
            Ok(config) => config
                .secrets()
                .fold(text.to_owned(), |text, key| text.replace(key, "[redacted]")),
            Err(_) => text.to_owned(),
        }
    }

    fn slash_reply(&self, text: &str, state: &State) -> Option<Local> {
        let name = text.split_whitespace().next()?;
        if !name.starts_with('/') {
            return None;
        }
        match name {
            "/status" if text == "/status" => Some(Local::Reply(self.status_reply(state))),
            "/status" => Some(Local::Reply("ใช้ /status โดยไม่ใส่อาร์กิวเมนต์ค่ะ".into())),
            "/clear" | "/cls" if text == name => Some(Local::Clear),
            "/permissions" => Some(Self::permissions_reply(text, state.permissions)),
            "/clear" | "/cls" => Some(Local::Reply(format!("ใช้ {name} โดยไม่ใส่อาร์กิวเมนต์ค่ะ"))),
            "/model" => Some(match self.model_reply(text, state) {
                Ok(choice) => Local::Switch(choice),
                Err(reply) => Local::Reply(reply),
            }),
            _ => Some(Local::Reply(
                "ยังไม่รองรับคำสั่งนี้ค่ะ คำสั่งที่ใช้ได้: /status, /model, /permissions, /clear, /cls, /exit"
                    .into(),
            )),
        }
    }

    fn permissions_reply(text: &str, current: Permissions) -> Local {
        let args: Vec<&str> = text.split_whitespace().skip(1).collect();
        match args.as_slice() {
            [] => Local::Reply(format!(
                "สิทธิ์: {} ({})\n       \
                 ใช้ /permissions ask เพื่อให้ถามก่อนลงมือ หรือ /permissions full เพื่อทำได้ทันทีค่ะ",
                current.label(),
                current.name()
            )),
            [mode] => match Permissions::parse(mode) {
                Some(mode) => Local::Permissions(
                    mode,
                    match mode {
                        Permissions::Ask => {
                            "ตั้งเป็น Ask for approval แล้วค่ะ ไอโกะจะถามก่อนลงมือทำทุกครั้งนะคะ"
                        }
                        Permissions::Full => "ตั้งเป็น Full Access แล้วค่ะ ไอโกะจะลงมือทำได้ทันทีนะคะ",
                    }
                    .into(),
                ),
                None => Local::Reply("ใช้ /permissions ask หรือ /permissions full ค่ะ".into()),
            },
            _ => Local::Reply("ใช้ /permissions ask หรือ /permissions full ค่ะ".into()),
        }
    }

    /// Ok is the model to switch to silently (the footer shows it); Err is a
    /// reply that leaves the model unchanged.
    fn model_reply(&self, text: &str, state: &State) -> Result<ModelChoice, String> {
        let args: Vec<&str> = text.split_whitespace().skip(1).collect();
        let (config, Some(current)) = (
            match &self.config {
                Ok(config) => config,
                Err(error) => return Err(format!("ยังสลับโมเดลไม่ได้ค่ะ การตั้งค่า: {error}")),
            },
            &state.model,
        ) else {
            return Err("ยังสลับโมเดลไม่ได้ค่ะ".into());
        };
        let [entry] = args.as_slice() else {
            return Err(match args.as_slice() {
                [] => format!(
                    "โมเดล: {} · {}\n       \
                     ใช้ /model <model-id> เพื่อสลับโมเดลในเซสชันนี้ค่ะ",
                    current.provider.name(),
                    current.model
                ),
                _ => "ใช้ /model หรือ /model <model-id> ค่ะ".into(),
            });
        };
        // Picker names resolve to their listed provider before inferring one.
        let choice = state
            .models
            .iter()
            .find(|choice| choice.model == *entry)
            .cloned()
            .or_else(|| ModelChoice::parse(entry, config.provider));
        // Never accept a key as a model ID: snapshots are not redacted.
        let Some(choice) = choice.filter(|_| self.clean(entry) == *entry) else {
            return Err(
                "model ID ไม่ถูกต้องค่ะ ใช้ได้เฉพาะตัวอักษร ตัวเลข และ . _ / - : ไม่เกิน 128 ตัว".into(),
            );
        };
        if config.key(choice.provider).is_none() {
            return Err(format!(
                "ยังใช้ {} ไม่ได้ค่ะ ต้องตั้ง {} ก่อน",
                choice.provider.name(),
                choice.provider.key_name()
            ));
        }
        // Choosing the active model is a silent no-op switch.
        Ok(choice)
    }

    fn status_reply(&self, state: &State) -> String {
        let (snapshot, permissions) = (&state.snapshot, state.permissions);
        let (provider, model) = match &self.config {
            Ok(_) => (snapshot.provider.as_str(), snapshot.model.as_str()),
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
            format!(
                "สิทธิ์: {} ({}) · บัญชีผู้ใช้ปัจจุบัน · ไม่มี sandbox",
                permissions.label(),
                permissions.name()
            ),
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
        let (cancel, history, model, permissions, local_reply) = {
            let mut state = self.state.lock().await;
            // Capture the state before reserving this request changes it to thinking.
            // Desktop actions do not enter the slash-command path.
            let local_reply = if app.is_none() {
                self.slash_reply(text, &state)
            } else {
                None
            };
            // A /model switch finishes here: no message, no thinking state and
            // no task. Switch only after the ID is accepted, so a rejected
            // request (busy or duplicate ID) changes nothing.
            let local_reply = match local_reply {
                Some(Local::Switch(choice)) => {
                    state.admit(id)?;
                    state.set_model(choice);
                    state.snapshot.state = "idle";
                    state.snapshot.error = None;
                    emit(
                        connection,
                        json!({"type":"state","request_id":id,"state":"idle"}),
                    )
                    .await;
                    return Ok(());
                }
                // Like a switch, a clear finishes here once the ID is accepted.
                Some(Local::Clear) => {
                    state.admit(id)?;
                    state.snapshot.messages.clear();
                    state.snapshot.state = "idle";
                    state.snapshot.error = None;
                    emit(
                        connection,
                        json!({"type":"state","request_id":id,"state":"idle"}),
                    )
                    .await;
                    return Ok(());
                }
                Some(Local::Reply(reply)) => Some((reply, None)),
                Some(Local::Permissions(mode, reply)) => Some((reply, Some(mode))),
                None => None,
            };
            let safe_text = self.clean(text);
            let (cancel, history) = state.reserve(id, safe_text.clone())?;
            // Change the mode only after the ID and request slot are accepted.
            let local_reply = local_reply.map(|(reply, mode)| {
                if let Some(mode) = mode {
                    state.set_permissions(mode);
                }
                reply
            });
            let model = state.model.clone();
            let permissions = state.permissions;
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
            (cancel, history, model, permissions, local_reply)
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
                    let config = runtime.config.as_ref().map_err(Clone::clone)?;
                    let config = match &model {
                        Some(choice) => config
                            .with_choice(choice)
                            .ok_or("The selected model's provider has no API key.")?,
                        None => config.clone(),
                    };
                    let client = Client::new(config)?.with_permissions(permissions);
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
            models: Vec::new(),
            api_key: "dummy-secret-value".into(),
            keys: Vec::new(),
        }));
        let state = runtime.state.lock().await;
        let Some(Local::Reply(reply)) = runtime.slash_reply("/status", &state) else {
            panic!("/status must reply");
        };
        assert_eq!(
            reply,
            "สถานะ: ● ว่าง (idle)\n       โมเดล: deepseek · test-model\n       \
             สิทธิ์: Full Access (full) · บัญชีผู้ใช้ปัจจุบัน · ไม่มี sandbox\n       ไฟล์/โฟลเดอร์สำคัญ: ยังไม่มีการป้องกัน"
        );
        assert!(!reply.contains("dummy-secret-value"));
        assert!(runtime.slash_reply("สวัสดี", &state).is_none());
    }

    #[tokio::test]
    async fn model_command_switches_only_valid_non_secret_ids() {
        let runtime = Runtime::new(Ok(Config {
            provider: crate::config::Provider::OpenAi,
            model: "gpt-6.1-sol".into(),
            models: Vec::new(),
            api_key: "dummy-secret-value".into(),
            keys: Vec::new(),
        }));
        let state = runtime.state.lock().await;
        let reply = |text| match runtime.slash_reply(text, &state) {
            Some(Local::Reply(reply)) => reply,
            _ => panic!("{text} must reply"),
        };
        let switch = |text| match runtime.slash_reply(text, &state) {
            Some(Local::Switch(choice)) => choice.model,
            _ => panic!("{text} must switch"),
        };
        assert!(reply("/model").starts_with("โมเดล: openai · gpt-6.1-sol"));
        // A switch, including to the active model, has no reply.
        assert_eq!(switch("/model  gpt-6.1-mini "), "gpt-6.1-mini");
        assert_eq!(switch("/model gpt-6.1-sol"), "gpt-6.1-sol");
        // DeepSeek has no key in this config, so it cannot be selected.
        assert!(reply("/model deepseek-chat").contains("DEEPSEEK_API_KEY"));
        for invalid in ["/model bad$id", "/model dummy-secret-value", "/model a b"] {
            assert!(!reply(invalid).contains("dummy-secret-value"));
        }
        let broken = Runtime::new(Err("Missing test config".into()));
        let state = broken.state.lock().await;
        assert!(matches!(
            broken.slash_reply("/model x", &state),
            Some(Local::Reply(_))
        ));
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
            models: Vec::new(),
            api_key: "dummy-secret-value".into(),
            keys: Vec::new(),
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
