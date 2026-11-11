use std::{collections::HashMap, future::Future, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    command::CommandRequest,
    config::{Config, Provider},
};

const MAX_RESPONSE_BYTES: usize = 1_048_576;
const MAX_TOOL_CALLS: usize = 16;
// Consecutive failed tool calls that end a request early, so a model that
// keeps trying workarounds answers instead of spending every call.
const MAX_FAILURES: usize = 4;
const SYSTEM: &str = include_str!("../prompts/aiko.md");
// Sent with tools disabled once a request has used all its tool calls or keeps
// failing, so the model answers normally instead of the user seeing an error.
const LIMIT_NOTE: &str = "No more tools can run for this request. Without calling tools, reply briefly in the language of the user's latest message: say what was done, and that the rest is not supported or cannot be done this way. Do not describe it as an error or mention tool call limits.";
// Added to the system prompt in Ask for approval mode.
const ASK_NOTE: &str = "Permission mode: Ask for approval. Before calling any tool (open_app or run_command), first reply in plain text, without calling tools, saying briefly what you will do (the app, or the commands and folder) and asking the user to confirm. Call tools only when the user's latest message clearly agrees to what you proposed, in any wording. If they decline, are unsure, or change the request, do not act; answer or propose again. A confirmation covers only what you described; anything new or different needs a new confirmation.";
const LIMIT_REPLY: &str = "ส่วนที่เหลือไอโกะยังทำให้ไม่ได้ค่ะ ตอนนี้ยังไม่รองรับนะคะ";

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum App {
    Terminal,
    Vscode,
}

impl App {
    pub fn name(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Vscode => "vscode",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "terminal" => Ok(Self::Terminal),
            "vscode" => Ok(Self::Vscode),
            _ => Err("Only terminal and vscode are supported.".to_owned()),
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum LaunchMode {
    #[default]
    Default,
    Tab,
    Standalone,
}

impl LaunchMode {
    pub fn name(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Tab => "tab",
            Self::Standalone => "standalone",
        }
    }

    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "default" => Ok(Self::Default),
            "tab" => Ok(Self::Tab),
            "standalone" => Ok(Self::Standalone),
            _ => Err("Terminal mode must be default, tab, or standalone.".to_owned()),
        }
    }
}

/// Whether the model may use tools at once or must ask in chat first.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Permissions {
    Ask,
    #[default]
    Full,
}

impl Permissions {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Full => "full",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask for approval",
            Self::Full => "Full Access",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "ask" => Some(Self::Ask),
            "full" => Some(Self::Full),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

pub trait Tools {
    fn open_app(
        &mut self,
        app: App,
        mode: LaunchMode,
    ) -> impl Future<Output = Result<Value, String>> + Send;
    fn run_command(
        &mut self,
        request: CommandRequest,
    ) -> impl Future<Output = Result<Value, String>> + Send;
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    config: Config,
    endpoint: String,
    permissions: Permissions,
}

impl Client {
    pub fn new(config: Config) -> Result<Self, String> {
        let endpoint = match config.provider {
            Provider::OpenAi => "https://api.openai.com/v1/responses",
            Provider::DeepSeek => "https://api.deepseek.com/chat/completions",
        };
        Self::with_endpoint(config, endpoint.to_owned())
    }

    fn with_endpoint(config: Config, endpoint: String) -> Result<Self, String> {
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(60))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Cannot initialize provider connection.".to_owned())?;
        Ok(Self {
            http,
            config,
            endpoint,
            permissions: Permissions::default(),
        })
    }

    pub fn with_permissions(mut self, permissions: Permissions) -> Self {
        self.permissions = permissions;
        self
    }

    fn instructions(&self) -> String {
        match self.permissions {
            Permissions::Ask => format!("{SYSTEM}\n\n{ASK_NOTE}"),
            Permissions::Full => SYSTEM.to_owned(),
        }
    }

    pub async fn chat(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        match self.config.provider {
            Provider::OpenAi => self.responses(history, tools).await,
            Provider::DeepSeek => self.completions(history, tools).await,
        }
    }

    async fn post(&self, body: Value) -> Result<Value, String> {
        let mut response = self
            .http
            .post(&self.endpoint)
            .bearer_auth(&self.config.api_key)
            .json(&body)
            .send()
            .await
            .map_err(|error| {
                if error.is_timeout() {
                    "Provider request timed out.".to_owned()
                } else {
                    "Cannot reach the selected provider.".to_owned()
                }
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "{} request failed (HTTP {}). Check the selected model, credentials, and account limits.",
                self.config.provider.name(),
                response.status().as_u16()
            ));
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_RESPONSE_BYTES as u64)
        {
            return Err("Provider response exceeds the size limit.".to_owned());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Cannot read provider response.".to_owned())?
        {
            if bytes.len() + chunk.len() > MAX_RESPONSE_BYTES {
                return Err("Provider response exceeds the size limit.".to_owned());
            }
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes).map_err(|_| "Provider returned invalid JSON.".to_owned())
    }

    async fn responses(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        let mut input: Vec<Value> = history
            .iter()
            .map(|m| json!({"role":m.role,"content":m.content}))
            .collect();
        let instructions = self.instructions();
        let request = |input: &[Value], tool_choice: &str| {
            let mut request = json!({
                "model": self.config.model,
                "instructions": instructions,
                "input": input,
                "tools": tool_definitions(true),
                "tool_choice": tool_choice,
                "parallel_tool_calls": false,
                "store": false,
                "include": ["reasoning.encrypted_content"],
                "max_output_tokens": 4096
            });
            if self.config.model.starts_with("gpt-6") || self.config.model.starts_with("gpt-5") {
                request["reasoning"] = json!({"effort":"low"});
            }
            request
        };
        let mut executed = Executed::default();
        for _ in 0..=MAX_TOOL_CALLS {
            let response = self.post(request(&input, "auto")).await?;
            let output = response_output(&response)?;
            let calls: Vec<_> = output
                .iter()
                .filter(|item| item["type"] == "function_call")
                .collect();
            if calls.is_empty() {
                return self.reply(output_text(output));
            }
            if calls.len() + executed.count > MAX_TOOL_CALLS {
                break;
            }
            // Stateless Responses must carry all output items, including reasoning,
            // into the follow-up alongside each function_call_output.
            input.extend(output.iter().cloned());
            for call in calls {
                let id = field(call, "call_id")?;
                let result = executed
                    .call(id, field(call, "name")?, field(call, "arguments")?, tools)
                    .await?;
                input.push(
                    json!({"type":"function_call_output","call_id":id,"output":result.to_string()}),
                );
            }
            if executed.stuck() {
                break;
            }
        }
        input.push(json!({"role":"system","content":LIMIT_NOTE}));
        let response = self.post(request(&input, "none")).await?;
        let output = response_output(&response)?;
        if output.iter().any(|item| item["type"] == "function_call") {
            return Ok(LIMIT_REPLY.to_owned());
        }
        self.reply(output_text(output))
            .or_else(|_| Ok(LIMIT_REPLY.to_owned()))
    }

    async fn completions(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        let mut messages = vec![json!({"role":"system","content":self.instructions()})];
        messages.extend(
            history
                .iter()
                .map(|m| json!({"role":m.role,"content":m.content})),
        );
        let request = |messages: &[Value], tool_choice: &str| {
            json!({
                "model":self.config.model,
                "messages":messages,
                "tools":tool_definitions(false),
                "tool_choice":tool_choice,
                "max_tokens":2048,
                "stream":false
            })
        };
        let mut executed = Executed::default();
        for _ in 0..=MAX_TOOL_CALLS {
            let response = self.post(request(&messages, "auto")).await?;
            let message = choice_message(&response)?;
            let calls = message["tool_calls"]
                .as_array()
                .filter(|calls| !calls.is_empty());
            let Some(calls) = calls else {
                return self.reply(message["content"].as_str().unwrap_or_default().to_owned());
            };
            if calls.len() + executed.count > MAX_TOOL_CALLS {
                break;
            }
            // Preserve reasoning_content when a thinking model returns it.
            messages.push(message.clone());
            for call in calls {
                let id = field(call, "id")?;
                let function = &call["function"];
                let result = executed
                    .call(
                        id,
                        field(function, "name")?,
                        field(function, "arguments")?,
                        tools,
                    )
                    .await?;
                messages
                    .push(json!({"role":"tool","tool_call_id":id,"content":result.to_string()}));
            }
            if executed.stuck() {
                break;
            }
        }
        messages.push(json!({"role":"system","content":LIMIT_NOTE}));
        let response = self.post(request(&messages, "none")).await?;
        let message = choice_message(&response)?;
        if message["tool_calls"]
            .as_array()
            .is_some_and(|calls| !calls.is_empty())
        {
            return Ok(LIMIT_REPLY.to_owned());
        }
        self.reply(message["content"].as_str().unwrap_or_default().to_owned())
            .or_else(|_| Ok(LIMIT_REPLY.to_owned()))
    }

    fn reply(&self, text: String) -> Result<String, String> {
        let text = text.trim();
        if text.is_empty() {
            return Err("Provider returned no text reply.".to_owned());
        }
        if text.len() > 16_384 {
            return Err("Provider reply exceeds the text limit.".to_owned());
        }
        Ok(text.replace(&self.config.api_key, "[redacted]"))
    }
}

fn response_output(response: &Value) -> Result<&Vec<Value>, String> {
    if matches!(
        response["status"].as_str(),
        Some("failed" | "cancelled" | "incomplete")
    ) {
        return Err("Provider did not complete its response. Try a shorter request.".to_owned());
    }
    response["output"]
        .as_array()
        .ok_or_else(|| "Provider response has no output.".to_owned())
}

fn output_text(output: &[Value]) -> String {
    output
        .iter()
        .filter(|item| item["type"] == "message")
        .flat_map(|item| item["content"].as_array().into_iter().flatten())
        .filter(|part| part["type"] == "output_text")
        .filter_map(|part| part["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n")
}

fn choice_message(response: &Value) -> Result<&Value, String> {
    let choice = response["choices"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("Provider response has no choice.")?;
    if matches!(
        choice["finish_reason"].as_str(),
        Some("length" | "content_filter")
    ) {
        return Err("Provider did not complete its response. Try a shorter request.".to_owned());
    }
    choice
        .get("message")
        .filter(|v| v.is_object())
        .ok_or_else(|| "Provider response has no message.".to_owned())
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| "Provider returned a malformed tool call.".to_owned())
}

fn schema() -> Value {
    json!({"type":"object","properties":{"app":{"type":"string","enum":["terminal","vscode"]},"mode":{"type":["string","null"],"enum":["default","tab","standalone",null]}},"required":["app","mode"],"additionalProperties":false})
}

fn tool_definitions(responses: bool) -> Vec<Value> {
    let definitions = [
        (
            "open_app",
            "Open or focus the primary zter terminal with default mode; use tab to add a tab, or standalone only when a separate new terminal is requested. VS Code always opens a new window and only accepts default mode.",
            schema(),
        ),
        (
            "run_command",
            "Run a noninteractive Bash command on this computer as the current user. Use for inspecting/editing files, running installed programs, and general local tasks. Supports pipes and scripts. Prefer open_app for supported desktop actions. workdir must be absolute or null for home; each call has a fresh shell. timeout_ms is 1–120000 or null for 30000. Returns stdout/stderr (first 8192 bytes each), exit_code, timed_out, and truncated. Stdin is closed. Timeout/cancellation stop the active process group. To start a persistent job, explicitly redirect its stdin/stdout/stderr and capture its PID; detached jobs are not tracked or cancelled after this call completes. Interactive sessions are unavailable.",
            json!({
                "type":"object",
                "properties":{
                    "command":{"type":"string","minLength":1,"maxLength":8192},
                    "workdir":{"type":["string","null"],"description":"Absolute directory, or null to use the user's home."},
                    "timeout_ms":{"type":["integer","null"],"minimum":1,"maximum":120000}
                },
                "required":["command","workdir","timeout_ms"],
                "additionalProperties":false
            }),
        ),
    ];
    definitions
        .into_iter()
        .map(|(name, description, parameters)| {
            let mut function =
                json!({"name":name,"description":description,"parameters":parameters});
            if responses {
                function["type"] = json!("function");
                function["strict"] = json!(true);
                function
            } else {
                json!({"type":"function","function":function})
            }
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    app: App,
    #[serde(default)]
    mode: Option<LaunchMode>,
}

#[derive(Default)]
struct Executed {
    ids: HashMap<String, (String, String, Value)>,
    apps: HashMap<(App, LaunchMode), Value>,
    count: usize,
    failures: usize,
}

// A tool call failed when it was rejected, its command exited nonzero, or it timed out.
fn failed(result: &Value) -> bool {
    result["success"] == false
        || result["timed_out"] == true
        || result["exit_code"].as_i64().is_some_and(|code| code != 0)
}

impl Executed {
    fn stuck(&self) -> bool {
        self.failures >= MAX_FAILURES
    }

    async fn call(
        &mut self,
        id: &str,
        name: &str,
        arguments: &str,
        tools: &mut impl Tools,
    ) -> Result<Value, String> {
        let result = self.run(id, name, arguments, tools).await?;
        self.failures = if failed(&result) {
            self.failures + 1
        } else {
            0
        };
        Ok(result)
    }

    async fn run(
        &mut self,
        id: &str,
        name: &str,
        arguments: &str,
        tools: &mut impl Tools,
    ) -> Result<Value, String> {
        self.count += 1;
        if let Some((previous_name, previous_arguments, result)) = self.ids.get(id) {
            if previous_name != name || previous_arguments != arguments {
                return Err("Provider reused a tool call ID with different arguments.".to_owned());
            }
            return Ok(result.clone());
        }
        let result = match name {
            "open_app" => match serde_json::from_str::<Arguments>(arguments) {
                Ok(Arguments { app, mode }) => {
                    let mode = mode.unwrap_or_default();
                    if app == App::Vscode && mode != LaunchMode::Default {
                        json!({"success":false,"message":"VS Code only supports default mode; tab and standalone are terminal modes."})
                    } else if let Some(result) = self.apps.get(&(app, mode)) {
                        result.clone()
                    } else {
                        let result = tools.open_app(app, mode).await?;
                        self.apps.insert((app, mode), result.clone());
                        result
                    }
                }
                Err(_) => {
                    json!({"success":false,"message":"open_app requires app: terminal or vscode and optional mode: default, tab, or standalone."})
                }
            },
            "run_command" => match serde_json::from_str::<CommandRequest>(arguments) {
                Ok(request) => match request.validate() {
                    Ok(()) => tools.run_command(request).await?,
                    Err(message) => json!({"success":false,"message":message}),
                },
                Err(_) => {
                    json!({"success":false,"message":"run_command requires command and optional workdir/timeout_ms only."})
                }
            },
            _ => json!({"success":false,"message":"Supported tools: open_app, run_command."}),
        };
        self.ids.insert(
            id.to_owned(),
            (name.to_owned(), arguments.to_owned(), result.clone()),
        );
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Default)]
    struct FakeTools {
        calls: Vec<(App, LaunchMode)>,
        commands: Vec<String>,
    }
    impl Tools for FakeTools {
        async fn open_app(&mut self, app: App, mode: LaunchMode) -> Result<Value, String> {
            self.calls.push((app, mode));
            Ok(json!({"success":true,"message":"Launch requested."}))
        }
        async fn run_command(&mut self, request: CommandRequest) -> Result<Value, String> {
            // The command "false" fails like the real one.
            let exit_code = i32::from(request.command == "false");
            self.commands.push(request.command);
            Ok(
                json!({"success":true,"exit_code":exit_code,"stdout":"mock command result","stderr":"","timed_out":false,"truncated":false}),
            )
        }
    }

    #[tokio::test]
    async fn only_validated_tools_execute_and_calls_do_not_repeat() {
        let mut executed = Executed::default();
        let mut tools = FakeTools::default();
        let result = executed
            .call("bad", "open_app", r#"{"app":"note"}"#, &mut tools)
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert!(tools.calls.is_empty());
        for id in ["one", "one", "two"] {
            executed
                .call(id, "open_app", r#"{"app":"terminal"}"#, &mut tools)
                .await
                .unwrap();
        }
        assert_eq!(tools.calls, vec![(App::Terminal, LaunchMode::Default)]);
        assert!(
            executed
                .call("one", "open_app", r#"{"app":"vscode"}"#, &mut tools)
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn terminal_modes_are_validated_and_deduplicated_separately() {
        let mut executed = Executed::default();
        let mut tools = FakeTools::default();
        for (index, arguments) in [
            r#"{"app":"terminal","mode":null}"#,
            r#"{"app":"terminal","mode":"tab"}"#,
            r#"{"app":"terminal","mode":"standalone"}"#,
            r#"{"app":"terminal","mode":"tab"}"#,
            r#"{"app":"terminal"}"#,
        ]
        .into_iter()
        .enumerate()
        {
            let result = executed
                .call(&format!("mode-{index}"), "open_app", arguments, &mut tools)
                .await
                .unwrap();
            assert_eq!(result["success"], true);
        }
        for arguments in [
            r#"{"app":"terminal","mode":"shell"}"#,
            r#"{"app":"terminal","mode":"tab","command":"ls"}"#,
            r#"{"app":"vscode","mode":"tab"}"#,
            r#"{"app":"vscode","mode":"standalone"}"#,
        ] {
            let result = executed
                .call(arguments, "open_app", arguments, &mut tools)
                .await
                .unwrap();
            assert_eq!(result["success"], false);
        }
        assert_eq!(
            tools.calls,
            vec![
                (App::Terminal, LaunchMode::Default),
                (App::Terminal, LaunchMode::Tab),
                (App::Terminal, LaunchMode::Standalone),
            ]
        );
    }

    async fn mock_server(responses: Vec<Value>) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mock", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for response in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut bytes = Vec::new();
                let body_start;
                loop {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                    if let Some(pos) = bytes.windows(4).position(|w| w == b"\r\n\r\n") {
                        body_start = pos + 4;
                        break;
                    }
                }
                let headers = String::from_utf8_lossy(&bytes[..body_start]);
                let length: usize = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|n| n.trim().parse().unwrap())
                    })
                    .unwrap();
                while bytes.len() < body_start + length {
                    let mut chunk = [0; 4096];
                    let n = socket.read(&mut chunk).await.unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&chunk[..n]);
                }
                requests
                    .push(serde_json::from_slice(&bytes[body_start..body_start + length]).unwrap());
                let body = response.to_string();
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",body.len(),body).as_bytes()).await.unwrap();
            }
            requests
        });
        (endpoint, task)
    }

    #[tokio::test]
    async fn responses_preserves_reasoning_and_returns_tool_output() {
        let first = json!({"status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-test"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"open_app","arguments":"{\"app\":\"terminal\",\"mode\":\"tab\"}"}]});
        let last = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Launch requested."}]}]});
        let (url, server) = mock_server(vec![first.clone(), last]).await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::OpenAi,
                model: "gpt-6.1-sol".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap();
        let mut tools = FakeTools::default();
        assert_eq!(
            client
                .chat(
                    &[Message {
                        role: "user".into(),
                        content: "เปิดแท็บใหม่".into()
                    }],
                    &mut tools
                )
                .await
                .unwrap(),
            "Launch requested."
        );
        assert_eq!(tools.calls, vec![(App::Terminal, LaunchMode::Tab)]);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["store"], false);
        assert_eq!(
            requests[0]["tools"][0]["parameters"]["required"],
            json!(["app", "mode"])
        );
        assert_eq!(requests[1]["input"][1], first["output"][0]);
        assert_eq!(requests[1]["input"][3]["type"], "function_call_output");
        assert_eq!(requests[1]["input"][3]["call_id"], "call_1");
    }

    #[tokio::test]
    async fn deepseek_preserves_tool_message_and_reasoning() {
        let message = json!({"role":"assistant","content":null,"reasoning_content":"private reasoning","tool_calls":[{"id":"call_1","type":"function","function":{"name":"open_app","arguments":"{\"app\":\"vscode\"}"}}]});
        let (url, server) = mock_server(vec![
            json!({"choices":[{"message":message}]}),
            json!({"choices":[{"message":{"role":"assistant","content":"Ready."}}]}),
        ])
        .await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::DeepSeek,
                model: "deepseek-chat".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap();
        let mut tools = FakeTools::default();
        assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Ready.");
        let requests = server.await.unwrap();
        assert_eq!(
            requests[1]["messages"][1]["reasoning_content"],
            "private reasoning"
        );
        assert_eq!(requests[1]["messages"][2]["tool_call_id"], "call_1");
        assert_eq!(tools.calls, vec![(App::Vscode, LaunchMode::Default)]);
    }

    #[tokio::test]
    async fn deepseek_routes_explicit_standalone_mode() {
        let (url, server) = mock_server(vec![
            json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"standalone","type":"function","function":{"name":"open_app","arguments":"{\"app\":\"terminal\",\"mode\":\"standalone\"}"}}]}}]}),
            json!({"choices":[{"message":{"role":"assistant","content":"Ready."}}]}),
        ])
        .await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::DeepSeek,
                model: "deepseek-chat".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap();
        let mut tools = FakeTools::default();
        assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Ready.");
        assert_eq!(tools.calls, vec![(App::Terminal, LaunchMode::Standalone)]);
        let requests = server.await.unwrap();
        assert_eq!(requests[1]["messages"][2]["tool_call_id"], "standalone");
    }

    #[tokio::test]
    async fn command_outputs_feed_followups_and_replayed_ids_do_not_run_again() {
        let call = |id: &str| json!({"status":"completed","output":[{"type":"function_call","call_id":id,"name":"run_command","arguments":"{\"command\":\"pwd\",\"workdir\":\"/tmp\",\"timeout_ms\":null}"}]});
        let (url, server) = mock_server(vec![
            call("command-1"), call("command-1"), call("command-2"),
            json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Done."}]}]}),
        ]).await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::OpenAi,
                model: "gpt-6.1-sol".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap();
        let mut tools = FakeTools::default();
        assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Done.");
        assert_eq!(tools.commands, vec!["pwd", "pwd"]);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["tools"][1]["name"], "run_command");
        assert_eq!(requests[0]["tools"][1]["strict"], true);
        let result: Value =
            serde_json::from_str(requests[1]["input"][1]["output"].as_str().unwrap()).unwrap();
        assert_eq!(result["stdout"], "mock command result");
    }

    fn test_client(provider: Provider, url: String) -> Client {
        Client::with_endpoint(
            Config {
                provider,
                model: "test-model".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap()
    }

    #[tokio::test]
    async fn exhausted_tool_calls_end_with_a_normal_reply_without_tools() {
        let command = r#"{"command":"pwd","workdir":"/tmp","timeout_ms":null}"#;
        // 16 calls run; the 17th is over the limit, so a final request disables tools.
        let mut responses: Vec<Value> = (0..=MAX_TOOL_CALLS)
            .map(|index| json!({"status":"completed","output":[{"type":"function_call","call_id":format!("call-{index}"),"name":"run_command","arguments":command}]}))
            .collect();
        responses.push(json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"ยังไม่รองรับค่ะ"}]}]}));
        let (url, server) = mock_server(responses).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::OpenAi, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), "ยังไม่รองรับค่ะ");
        assert_eq!(tools.commands.len(), MAX_TOOL_CALLS);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["tool_choice"], "auto");
        let last = requests.last().unwrap();
        assert_eq!(last["tool_choice"], "none");
        let note = last["input"].as_array().unwrap().last().unwrap();
        assert_eq!(note["role"], "system");
        assert_eq!(note["content"], LIMIT_NOTE);

        let call = |index: usize| json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"run_command","arguments":command}}]}}]});
        let mut responses: Vec<Value> = (0..=MAX_TOOL_CALLS).map(call).collect();
        responses.push(
            json!({"choices":[{"message":{"role":"assistant","content":"It is not supported."}}]}),
        );
        let (url, server) = mock_server(responses).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), "It is not supported.");
        assert_eq!(tools.commands.len(), MAX_TOOL_CALLS);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["tool_choice"], "auto");
        let last = requests.last().unwrap();
        assert_eq!(last["tool_choice"], "none");
        assert_eq!(
            last["messages"].as_array().unwrap().last().unwrap()["content"],
            LIMIT_NOTE
        );

        // A model that still asks for a tool gets a fixed reply instead of an error.
        let responses: Vec<Value> = (0..=MAX_TOOL_CALLS + 1).map(call).collect();
        let (url, server) = mock_server(responses).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), LIMIT_REPLY);
        server.await.unwrap();
    }

    #[tokio::test]
    async fn consecutive_failures_end_the_request_with_a_normal_reply() {
        let call = |(index, command): (usize, &&str)| json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":format!("call-{index}"),"type":"function","function":{"name":"run_command","arguments":format!(r#"{{"command":"{command}","workdir":null,"timeout_ms":null}}"#)}}]}}]});
        // A success resets the count; the next four failures stop the request.
        let commands = [
            "false", "false", "false", "pwd", "false", "false", "false", "false",
        ];
        let mut responses: Vec<Value> = commands.iter().enumerate().map(call).collect();
        responses
            .push(json!({"choices":[{"message":{"role":"assistant","content":"ยังไม่รองรับค่ะ"}}]}));
        let (url, server) = mock_server(responses).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), "ยังไม่รองรับค่ะ");
        assert_eq!(tools.commands, commands);
        let requests = server.await.unwrap();
        assert_eq!(requests.len(), commands.len() + 1);
        assert_eq!(requests.last().unwrap()["tool_choice"], "none");
        assert!(failed(&json!({"success":false,"message":"bad"})));
        assert!(failed(
            &json!({"success":true,"exit_code":null,"timed_out":true})
        ));
        assert!(!failed(
            &json!({"success":true,"message":"Launch requested."})
        ));
    }

    #[tokio::test]
    async fn invalid_command_arguments_never_reach_the_executor() {
        let mut executed = Executed::default();
        let mut tools = FakeTools::default();
        for (index, arguments) in [
            r#"{"command":""}"#,
            r#"{"command":"pwd","workdir":"relative"}"#,
            r#"{"command":"pwd","timeout_ms":0}"#,
            r#"{"command":"pwd","timeout_ms":120001}"#,
            r#"{"command":"pwd","shell":"/bin/sh"}"#,
        ]
        .into_iter()
        .enumerate()
        {
            let result = executed
                .call(
                    &format!("bad-{index}"),
                    "run_command",
                    arguments,
                    &mut tools,
                )
                .await
                .unwrap();
            assert_eq!(result["success"], false);
        }
        assert!(tools.commands.is_empty());
    }

    #[tokio::test]
    async fn deepseek_exposes_commands_and_returns_their_output() {
        let (url, server) = mock_server(vec![
            json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[{"id":"command-1","type":"function","function":{"name":"run_command","arguments":"{\"command\":\"pwd\",\"workdir\":\"/tmp\",\"timeout_ms\":1000}"}}]}}]}),
            json!({"choices":[{"message":{"role":"assistant","content":"Done."}}]}),
        ]).await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::DeepSeek,
                model: "deepseek-chat".into(),
                models: Vec::new(),
                api_key: "dummy-test-key".into(),
                keys: Vec::new(),
            },
            url,
        )
        .unwrap();
        let mut tools = FakeTools::default();
        assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Done.");
        assert_eq!(tools.commands, vec!["pwd"]);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["tools"][1]["function"]["name"], "run_command");
        let result: Value =
            serde_json::from_str(requests[1]["messages"][2]["content"].as_str().unwrap()).unwrap();
        assert_eq!(result["exit_code"], 0);
    }

    #[tokio::test]
    async fn ask_mode_adds_the_approval_note_for_both_providers() {
        for (provider, model, reply) in [
            (
                Provider::OpenAi,
                "gpt-6.1-sol",
                json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Okay?"}]}]}),
            ),
            (
                Provider::DeepSeek,
                "deepseek-chat",
                json!({"choices":[{"message":{"role":"assistant","content":"Okay?"}}]}),
            ),
        ] {
            for permissions in [Permissions::Ask, Permissions::Full] {
                let (url, server) = mock_server(vec![reply.clone()]).await;
                let client = Client::with_endpoint(
                    Config {
                        provider,
                        model: model.into(),
                        models: Vec::new(),
                        api_key: "dummy-test-key".into(),
                        keys: Vec::new(),
                    },
                    url,
                )
                .unwrap()
                .with_permissions(permissions);
                let mut tools = FakeTools::default();
                assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Okay?");
                let request = &server.await.unwrap()[0];
                let system = match provider {
                    Provider::OpenAi => &request["instructions"],
                    Provider::DeepSeek => &request["messages"][0]["content"],
                }
                .as_str()
                .unwrap();
                assert!(system.starts_with(SYSTEM));
                assert_eq!(system.contains(ASK_NOTE), permissions == Permissions::Ask);
            }
        }
    }
}
