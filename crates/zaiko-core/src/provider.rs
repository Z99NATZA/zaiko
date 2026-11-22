use std::{collections::HashMap, future::Future, time::Duration};

use tokio::time::{Instant, sleep, sleep_until};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    command::CommandRequest,
    config::{Config, Provider},
};

// Largest JSON response, or single streamed event.
const MAX_RESPONSE_BYTES: usize = 1_048_576;
// Largest streamed response; each token arrives wrapped in its own event.
const MAX_STREAM_BYTES: usize = 16 * MAX_RESPONSE_BYTES;
// Longest reply kept; a longer one is cut at a line break and marked.
const MAX_REPLY_BYTES: usize = 16_384;
// Output tokens a hosted model may spend on one response, reasoning included.
const MAX_OUTPUT_TOKENS: u32 = 16_384;
// Time a client has for all its responses, below the 300-second limit the
// service puts on a request, so a reply still being written at this point is
// kept as a cut-off reply instead of being lost to that limit.
const REQUEST_BUDGET: Duration = Duration::from_secs(270);
const INCOMPLETE: &str = "Provider did not complete its response. Try a shorter request.";
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
// Added to the system prompt for local Ollama models, which drift into other
// languages (often Chinese) more easily than hosted models.
const OLLAMA_NOTE: &str = "Write every reply only in the language of the user's latest message, for example only Thai when they write Thai. Never switch to Chinese or any other language mid-reply.";
// Sent with tools disabled when a reply contains CJK text the user did not write.
const LANGUAGE_NOTE: &str = "Your previous reply mixed in another language. Rewrite it entirely in the language of the user's latest message, keeping the same meaning and tone. Use no Chinese, Japanese, or Korean characters. Reply with the rewritten text only.";
// Prefixed to Log records in the history sent to the model, so a model does
// not take them for its own replies and imitate them instead of calling tools.
const TOOL_LOG_NOTE: &str = "Tool log from earlier in this conversation, recorded by Zaiko, not written by you. Writing text like this does nothing; only tool calls act.";
// Sent once when a reply reports an action although no tool ran for the request.
const UNBACKED_NOTE: &str = "Your reply says an action was done, but no tool ran for this request, so nothing happened. If the user asked for something a tool can do, call that tool now. Otherwise reply again without claiming any action, and say briefly that it is not supported yet.";
const LIMIT_REPLY: &str = "ส่วนที่เหลือไอโกะยังทำให้ไม่ได้ค่ะ ตอนนี้ยังไม่รองรับนะคะ";
// Appended to a reply the model stopped at its output limit.
const CUT_OFF_TH: &str = "(คำตอบยาวเกินไป ไอโกะเลยตัดไว้ตรงนี้ค่ะ อยากได้ส่วนที่เหลือก็บอกให้เขียนต่อได้นะคะ)";
const CUT_OFF_EN: &str =
    "(The reply was too long, so it stops here. Ask me to continue for the rest.)";

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
    /// A Log record written by Zaiko, such as a tool result, rather than by
    /// the user or the model. Snapshots do not include it.
    #[serde(skip)]
    pub tool: bool,
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
    /// Longest wait for the provider to send anything more.
    idle: Duration,
    /// When a response still streaming is cut; a client serves one request.
    deadline: Instant,
}

impl Client {
    pub fn new(config: Config) -> Result<Self, String> {
        let endpoint = match config.provider {
            Provider::OpenAi => "https://api.openai.com/v1/responses".to_owned(),
            Provider::DeepSeek => "https://api.deepseek.com/chat/completions".to_owned(),
            Provider::Ollama => format!("{}/api/chat", config.ollama_url),
        };
        Self::with_endpoint(config, endpoint)
    }

    fn with_endpoint(config: Config, endpoint: String) -> Result<Self, String> {
        // Responses stream, so only silence times out. A local model may first
        // need to load into memory before it sends anything.
        let idle = match config.provider {
            Provider::Ollama => 180,
            _ => 60,
        };
        let http = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(10))
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|_| "Cannot initialize provider connection.".to_owned())?;
        Ok(Self {
            http,
            config,
            endpoint,
            permissions: Permissions::default(),
            idle: Duration::from_secs(idle),
            deadline: Instant::now() + REQUEST_BUDGET,
        })
    }

    pub fn with_permissions(mut self, permissions: Permissions) -> Self {
        self.permissions = permissions;
        self
    }

    fn instructions(&self) -> String {
        let mut instructions = SYSTEM.to_owned();
        if self.permissions == Permissions::Ask {
            instructions = format!("{instructions}\n\n{ASK_NOTE}");
        }
        if self.config.provider == Provider::Ollama {
            instructions = format!("{instructions}\n\n{OLLAMA_NOTE}");
        }
        instructions
    }

    pub async fn chat(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        match self.config.provider {
            Provider::OpenAi => self.responses(history, tools).await,
            Provider::DeepSeek | Provider::Ollama => self.completions(history, tools).await,
        }
    }

    /// Sends a streaming request and returns the response in the provider's
    /// non-streaming shape. A server answering with plain JSON also works.
    async fn post(&self, body: Value) -> Result<Value, String> {
        const TIMED_OUT: &str = "Provider request timed out.";
        let ollama = self.config.provider == Provider::Ollama;
        let mut request = self.http.post(&self.endpoint).json(&body);
        if !self.config.api_key.is_empty() {
            request = request.bearer_auth(&self.config.api_key);
        }
        let sent = tokio::select! {
            sent = request.send() => sent,
            _ = sleep(self.idle) => return Err(TIMED_OUT.to_owned()),
            _ = sleep_until(self.deadline) => return Err(TIMED_OUT.to_owned()),
        };
        let mut response = sent.map_err(|error| {
            if error.is_timeout() {
                TIMED_OUT.to_owned()
            } else if ollama {
                "Cannot reach Ollama. Start it with ollama serve, or check ZAIKO_OLLAMA_URL."
                    .to_owned()
            } else {
                "Cannot reach the selected provider.".to_owned()
            }
        })?;
        if !response.status().is_success() {
            let hint = if ollama {
                "Check that the model is pulled (ollama pull <model>) and supports tools."
            } else {
                "Check the selected model, credentials, and account limits."
            };
            return Err(format!(
                "{} request failed (HTTP {}). {hint}",
                self.config.provider.name(),
                response.status().as_u16()
            ));
        }
        const TOO_LARGE: &str = "Provider response exceeds the size limit.";
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_ascii_lowercase();
        let mut stream = (content_type.contains("text/event-stream")
            || content_type.contains("ndjson"))
        .then(|| Stream::new(self.config.provider));
        let limit = if stream.is_some() {
            MAX_STREAM_BYTES
        } else {
            MAX_RESPONSE_BYTES
        };
        if response.content_length().is_some_and(|n| n > limit as u64) {
            return Err(TOO_LARGE.to_owned());
        }
        let (mut bytes, mut total) = (Vec::new(), 0);
        let mut done = false;
        while !done {
            let chunk = tokio::select! {
                chunk = response.chunk() => {
                    chunk.map_err(|_| "Cannot read provider response.".to_owned())?
                }
                _ = sleep(self.idle) => return Err(TIMED_OUT.to_owned()),
                // Keep what has streamed so far as a cut-off response.
                _ = sleep_until(self.deadline) => match stream {
                    Some(stream) => return stream.finish(true),
                    None => return Err(TIMED_OUT.to_owned()),
                },
            };
            let Some(chunk) = chunk else {
                // The last event may end without a line break.
                if let Some(stream) = stream.as_mut()
                    && !bytes.is_empty()
                {
                    stream.line(&bytes)?;
                }
                break;
            };
            total += chunk.len();
            if total > limit {
                return Err(TOO_LARGE.to_owned());
            }
            bytes.extend_from_slice(&chunk);
            let Some(stream) = stream.as_mut() else {
                continue;
            };
            while !done && let Some(end) = bytes.iter().position(|&b| b == b'\n') {
                let line: Vec<u8> = bytes.drain(..=end).collect();
                done = stream.line(&line)?;
            }
            if bytes.len() > MAX_RESPONSE_BYTES {
                return Err(TOO_LARGE.to_owned());
            }
        }
        match stream {
            Some(stream) => stream.finish(false),
            None => serde_json::from_slice(&bytes)
                .map_err(|_| "Provider returned invalid JSON.".to_owned()),
        }
    }

    async fn responses(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        let mut input: Vec<Value> = history.iter().map(history_item).collect();
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
                "max_output_tokens": MAX_OUTPUT_TOKENS,
                "stream": true
            });
            if self.config.model.starts_with("gpt-6") || self.config.model.starts_with("gpt-5") {
                request["reasoning"] = json!({"effort":"low"});
            }
            request
        };
        let mut executed = Executed::default();
        for _ in 0..=MAX_TOOL_CALLS {
            let response = self.post(request(&input, "auto")).await?;
            let (output, cut) = response_output(&response)?;
            let calls: Vec<_> = output
                .iter()
                .filter(|item| item["type"] == "function_call")
                .collect();
            if calls.is_empty() {
                return self.reply(output_text(output), cut);
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
        let (output, cut) = response_output(&response)?;
        if output.iter().any(|item| item["type"] == "function_call") {
            return Ok(LIMIT_REPLY.to_owned());
        }
        self.reply(output_text(output), cut)
            .or_else(|_| Ok(LIMIT_REPLY.to_owned()))
    }

    async fn completions(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        let mut messages = vec![json!({"role":"system","content":self.instructions()})];
        messages.extend(history.iter().map(history_item));
        let mut executed = Executed::default();
        let mut checked = false;
        for _ in 0..=MAX_TOOL_CALLS {
            let response = self.complete(&messages, Some("auto")).await?;
            let (message, cut) = choice_message(&response)?;
            let calls = message["tool_calls"]
                .as_array()
                .filter(|calls| !calls.is_empty());
            let Some(calls) = calls else {
                let text = message["content"].as_str().unwrap_or_default().to_owned();
                // A reply reporting an action when no tool ran is made up; give
                // the model one chance to act or to say it cannot.
                if executed.count == 0 && !checked && claims_action(&text) {
                    checked = true;
                    messages.push(json!({"role":"assistant","content":text}));
                    messages.push(json!({"role":"system","content":UNBACKED_NOTE}));
                    continue;
                }
                let text = self.keep_voice(history, &messages, text).await;
                return self.reply(text, cut);
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
        let response = self.complete(&messages, Some("none")).await?;
        let (message, cut) = choice_message(&response)?;
        if message["tool_calls"]
            .as_array()
            .is_some_and(|calls| !calls.is_empty())
        {
            return Ok(LIMIT_REPLY.to_owned());
        }
        let text = message["content"].as_str().unwrap_or_default().to_owned();
        let text = self.keep_voice(history, &messages, text).await;
        self.reply(text, cut)
            .or_else(|_| Ok(LIMIT_REPLY.to_owned()))
    }

    /// Sends chat-completions `messages` and returns a chat-completions
    /// response. `tool_choice` None offers no tools. Ollama uses its native
    /// API, which can set the context size, thinking, and keep-alive.
    async fn complete(
        &self,
        messages: &[Value],
        tool_choice: Option<&str>,
    ) -> Result<Value, String> {
        if self.config.provider == Provider::Ollama {
            // Ollama ignores tool_choice, so it gets no tools when none may run.
            let request = ollama_request(&self.config, messages, tool_choice == Some("auto"));
            return Ok(ollama_response(self.post(request).await?, messages.len()));
        }
        let mut request = json!({
            "model":self.config.model,
            "messages":messages,
            "max_tokens":MAX_OUTPUT_TOKENS,
            "stream":true
        });
        if let Some(tool_choice) = tool_choice {
            request["tools"] = json!(tool_definitions(false));
            request["tool_choice"] = json!(tool_choice);
        }
        self.post(request).await
    }

    /// Keeps Aiko's language, and for Ollama her feminine voice.
    async fn keep_voice(&self, history: &[Message], messages: &[Value], text: String) -> String {
        let text = self.keep_language(history, messages, text).await;
        if self.config.provider == Provider::Ollama {
            feminine(without_speaker(&text))
        } else {
            text
        }
    }

    /// Returns `text` without CJK script the user did not write: the model
    /// rewrites it once, and any CJK words left after that are removed.
    async fn keep_language(&self, history: &[Message], messages: &[Value], text: String) -> String {
        let user = history
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .map_or("", |m| m.content.as_str());
        if !text.chars().any(cjk) || user.chars().any(cjk) {
            return text;
        }
        let mut retry = messages.to_vec();
        retry.push(json!({"role":"assistant","content":text}));
        retry.push(json!({"role":"system","content":LANGUAGE_NOTE}));
        let rewritten = match self.complete(&retry, None).await {
            // A cut-off rewrite would lose part of the reply; keep the original.
            Ok(response) => choice_message(&response)
                .ok()
                .filter(|(_, cut)| !cut)
                .and_then(|(message, _)| message["content"].as_str())
                .map(str::trim)
                .filter(|text| !text.is_empty())
                .map(str::to_owned),
            Err(_) => None,
        };
        let text = rewritten.unwrap_or(text);
        if !text.chars().any(cjk) {
            return text;
        }
        let kept = without_cjk(&text);
        if kept.trim().is_empty() { text } else { kept }
    }

    /// The reply to show; `cut` marks one the model stopped at its output limit.
    fn reply(&self, text: String, cut: bool) -> Result<String, String> {
        let mut text = text.trim();
        if text.is_empty() {
            return Err("Provider returned no text reply.".to_owned());
        }
        let cut = cut || text.len() > MAX_REPLY_BYTES;
        if text.len() > MAX_REPLY_BYTES {
            text = &text[..text.floor_char_boundary(MAX_REPLY_BYTES)];
            // End at a line break when one is reasonably close.
            if let Some(end) = text.rfind('\n').filter(|&end| end > MAX_REPLY_BYTES / 2) {
                text = &text[..end];
            }
        }
        let text = if cut { cut_off(text) } else { text.to_owned() };
        if self.config.api_key.is_empty() {
            return Ok(text);
        }
        Ok(text.replace(&self.config.api_key, "[redacted]"))
    }
}

/// Collects a streamed response into the provider's non-streaming shape.
/// OpenAI and DeepSeek send server-sent events; Ollama sends JSON lines.
enum Stream {
    /// OpenAI Responses: the final event carries the whole response.
    Responses {
        text: String,
        response: Option<Value>,
    },
    /// Chat completions: deltas of one choice.
    Chat {
        content: Option<String>,
        reasoning: Option<String>,
        calls: Vec<Value>,
        finish: Option<String>,
    },
    Ollama {
        content: String,
        calls: Vec<Value>,
        finish: Option<String>,
    },
}

impl Stream {
    fn new(provider: Provider) -> Self {
        match provider {
            Provider::OpenAi => Self::Responses {
                text: String::new(),
                response: None,
            },
            Provider::DeepSeek => Self::Chat {
                content: None,
                reasoning: None,
                calls: Vec::new(),
                finish: None,
            },
            Provider::Ollama => Self::Ollama {
                content: String::new(),
                calls: Vec::new(),
                finish: None,
            },
        }
    }

    /// Reads one line of the stream; true once the response is complete.
    fn line(&mut self, line: &[u8]) -> Result<bool, String> {
        let line = std::str::from_utf8(line)
            .map_err(|_| "Provider returned invalid JSON.".to_owned())?
            .trim();
        // Server-sent events carry JSON in data fields; other fields, comments
        // and keep-alives carry nothing needed.
        let data = match self {
            Self::Ollama { .. } => line,
            _ => match line.strip_prefix("data:") {
                Some(data) => data.trim(),
                None => return Ok(false),
            },
        };
        if data.is_empty() {
            return Ok(false);
        }
        if data == "[DONE]" {
            return Ok(true);
        }
        let event: Value =
            serde_json::from_str(data).map_err(|_| "Provider returned invalid JSON.".to_owned())?;
        // Provider error bodies are not shown; they may echo the request.
        if event.get("error").is_some_and(|error| !error.is_null()) || event["type"] == "error" {
            return Err(INCOMPLETE.to_owned());
        }
        match self {
            Self::Responses { text, response } => match event["type"].as_str() {
                Some("response.output_text.delta") => {
                    text.push_str(event["delta"].as_str().unwrap_or_default());
                }
                Some("response.completed" | "response.incomplete" | "response.failed") => {
                    *response = Some(event["response"].clone());
                    return Ok(true);
                }
                _ => {}
            },
            Self::Chat {
                content,
                reasoning,
                calls,
                finish,
            } => {
                // A last chunk may carry only usage, with no choice.
                let Some(choice) = event["choices"].get(0) else {
                    return Ok(false);
                };
                let delta = &choice["delta"];
                if let Some(text) = delta["content"].as_str() {
                    content.get_or_insert_default().push_str(text);
                }
                if let Some(text) = delta["reasoning_content"].as_str() {
                    reasoning.get_or_insert_default().push_str(text);
                }
                for part in delta["tool_calls"].as_array().into_iter().flatten() {
                    let index = part["index"]
                        .as_u64()
                        .map(|index| index as usize)
                        .filter(|&index| index <= calls.len() && index <= MAX_TOOL_CALLS)
                        .ok_or_else(|| "Provider returned a malformed tool call.".to_owned())?;
                    if index == calls.len() {
                        calls.push(json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
                    }
                    let call = &mut calls[index];
                    if let Some(id) = part["id"].as_str().filter(|id| !id.is_empty()) {
                        call["id"] = json!(id);
                    }
                    for key in ["name", "arguments"] {
                        if let Some(text) = part["function"][key].as_str() {
                            let joined = format!(
                                "{}{text}",
                                call["function"][key].as_str().unwrap_or_default()
                            );
                            call["function"][key] = json!(joined);
                        }
                    }
                }
                if let Some(reason) = choice["finish_reason"].as_str() {
                    *finish = Some(reason.to_owned());
                }
            }
            Self::Ollama {
                content,
                calls,
                finish,
            } => {
                let message = &event["message"];
                content.push_str(message["content"].as_str().unwrap_or_default());
                calls.extend(
                    message["tool_calls"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .cloned(),
                );
                if event["done"] == true {
                    *finish = Some(event["done_reason"].as_str().unwrap_or("stop").to_owned());
                    return Ok(true);
                }
            }
        }
        Ok(false)
    }

    /// The response collected so far. `cut` marks one stopped at the deadline,
    /// which counts as stopped at the output limit; only its text is kept.
    fn finish(self, cut: bool) -> Result<Value, String> {
        const ENDED: &str = "Provider response ended early.";
        match self {
            Self::Responses {
                response: Some(response),
                ..
            } => Ok(response),
            Self::Responses {
                text,
                response: None,
            } => {
                if !cut {
                    return Err(ENDED.to_owned());
                }
                Ok(
                    json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":text}]}]}),
                )
            }
            Self::Chat {
                content,
                reasoning,
                calls,
                finish,
            } => {
                let finish = if cut {
                    Some("length".to_owned())
                } else {
                    finish
                };
                let finish = finish.ok_or_else(|| ENDED.to_owned())?;
                let mut message = json!({"role":"assistant","content":content});
                if let Some(reasoning) = reasoning {
                    message["reasoning_content"] = json!(reasoning);
                }
                if !calls.is_empty() {
                    message["tool_calls"] = json!(calls);
                }
                Ok(json!({"choices":[{"message":message,"finish_reason":finish}]}))
            }
            Self::Ollama {
                content,
                calls,
                finish,
            } => {
                let finish = if cut {
                    Some("length".to_owned())
                } else {
                    finish
                };
                let finish = finish.ok_or_else(|| ENDED.to_owned())?;
                let mut message = json!({"role":"assistant","content":content});
                if !calls.is_empty() {
                    message["tool_calls"] = json!(calls);
                }
                Ok(json!({"message":message,"done":true,"done_reason":finish}))
            }
        }
    }
}

/// A history message as sent to the model; Log records become system notes.
fn history_item(message: &Message) -> Value {
    if message.tool {
        json!({"role":"system","content":format!("{TOOL_LOG_NOTE}\n{}", message.content)})
    } else {
        json!({"role":message.role,"content":message.content})
    }
}

/// Converts chat-completions messages into an Ollama /api/chat request.
fn ollama_request(config: &Config, messages: &[Value], tools: bool) -> Value {
    let mut names = HashMap::new();
    let mut native = Vec::with_capacity(messages.len());
    for message in messages {
        let mut message = message.clone();
        // Native tool calls carry arguments as an object, and tool results name their tool.
        if let Some(calls) = message["tool_calls"].as_array_mut() {
            for call in calls {
                if let (Some(id), Some(name)) =
                    (call["id"].as_str(), call["function"]["name"].as_str())
                {
                    names.insert(id.to_owned(), name.to_owned());
                }
                if let Some(arguments) = call["function"]["arguments"].as_str()
                    && let Ok(arguments) = serde_json::from_str::<Value>(arguments)
                {
                    call["function"]["arguments"] = arguments;
                }
            }
        }
        if message["role"] == "tool"
            && let Some(name) = message["tool_call_id"]
                .as_str()
                .and_then(|id| names.get(id))
        {
            message["tool_name"] = json!(name);
        }
        native.push(message);
    }
    let mut request = json!({
        "model":config.model,
        "messages":native,
        "stream":true,
        // Thinking makes small local models several times slower and more
        // likely to drift into another language.
        "think":false,
        // Stay loaded between messages instead of the default five minutes.
        "keep_alive":"30m",
        "options":{"num_ctx":config.ollama_context,"num_predict":2048}
    });
    if tools {
        request["tools"] = json!(tool_definitions(false));
    }
    request
}

/// Converts an Ollama /api/chat response into a chat-completions response.
/// `turn` keeps generated tool call IDs unique within a request.
fn ollama_response(mut response: Value, turn: usize) -> Value {
    let mut message = response["message"].take();
    if let Some(calls) = message["tool_calls"].as_array_mut() {
        for (index, call) in calls.iter_mut().enumerate() {
            if !call["id"].as_str().is_some_and(|id| !id.is_empty()) {
                call["id"] = json!(format!("call-{turn}-{index}"));
            }
            call["type"] = json!("function");
            let arguments = &call["function"]["arguments"];
            if !arguments.is_string() && !arguments.is_null() {
                call["function"]["arguments"] = json!(arguments.to_string());
            }
        }
    }
    let finish = match response["done_reason"].as_str() {
        Some("length") => "length",
        _ => "stop",
    };
    json!({"choices":[{"message":message,"finish_reason":finish}]})
}

/// Drops a leading speaker label such as "ไอโกะ:", which local models copy
/// from chat transcripts; the Log already names the speaker.
fn without_speaker(text: &str) -> &str {
    let trimmed = text.trim_start();
    for label in ["ไอโกะ", "Aiko", "[Aiko]"] {
        if let Some(rest) = trimmed.strip_prefix(label) {
            if let Some(rest) = rest.trim_start().strip_prefix([':', '：']) {
                return rest.trim_start();
            }
            if label == "[Aiko]" {
                return rest.trim_start();
            }
        }
    }
    text
}

/// Replaces masculine Thai particles with feminine ones outside code blocks.
/// Small local models often echo the user's "ครับ".
fn feminine(text: &str) -> String {
    const QUESTIONS: [&str; 7] = ["ไหม", "มั้ย", "เปล่า", "อะไร", "ไร", "หรอ", "เหรอ"];
    text.split("```")
        .enumerate()
        .map(|(index, part)| {
            if index % 2 == 1 {
                return part.to_owned();
            }
            let mut part = part.replace("ครับผม", "ค่ะ").replace("นะครับ", "นะคะ");
            // "นะ" takes the short particle; models often misspell it.
            part = part.replace("นะค่ะ", "นะคะ");
            for question in QUESTIONS {
                part = part.replace(&format!("{question}ครับ"), &format!("{question}คะ"));
            }
            part.replace("ครับ?", "คะ?")
                .replace("ครับ ?", "คะ ?")
                .replace("ครับ", "ค่ะ")
        })
        .collect::<Vec<_>>()
        .join("```")
}

/// Whether a reply reports a finished action, such as "เปิดให้แล้วค่ะ".
fn claims_action(text: &str) -> bool {
    const THAI: [&str; 8] = [
        "ให้แล้ว",
        "เรียบร้อยแล้ว",
        "เรียกเปิด",
        "เปิดแล้ว",
        "ปิดแล้ว",
        "รันแล้ว",
        "แก้แล้ว",
        "ลบแล้ว",
    ];
    const ENGLISH: [&str; 8] = [
        "opened", "closed", "started", "stopped", "changed", "updated", "deleted", "ran ",
    ];
    let lower = text.to_lowercase();
    THAI.iter().any(|marker| text.contains(marker))
        || ["i've ", "i have "].iter().any(|subject| {
            ENGLISH
                .iter()
                .any(|verb| lower.contains(&format!("{subject}{verb}")))
        })
}

/// Han, kana, hangul, and their punctuation and full-width forms.
fn cjk(c: char) -> bool {
    matches!(c,
        '\u{1100}'..='\u{11FF}'
        | '\u{2E80}'..='\u{9FFF}'
        | '\u{A960}'..='\u{A97F}'
        | '\u{AC00}'..='\u{D7FF}'
        | '\u{F900}'..='\u{FAFF}'
        | '\u{FE30}'..='\u{FE4F}'
        | '\u{FF00}'..='\u{FFEF}'
        | '\u{20000}'..='\u{3FFFF}')
}

/// Drops each whitespace-separated word that contains CJK, keeping line breaks.
fn without_cjk(text: &str) -> String {
    text.lines()
        .map(|line| {
            line.split_whitespace()
                .filter(|word| !word.chars().any(cjk))
                .collect::<Vec<_>>()
                .join(" ")
        })
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_owned()
}

/// Closes a code block left open by a reply cut at the output limit, and
/// says that it was cut, in Thai when the reply is Thai.
fn cut_off(text: &str) -> String {
    let mut text = text.trim_end().to_owned();
    if text.matches("```").count() % 2 == 1 {
        text.push_str("\n```");
    }
    let thai = text.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c));
    let note = if thai { CUT_OFF_TH } else { CUT_OFF_EN };
    format!("{text}\n\n{note}")
}

/// The Responses output items, and whether the model stopped at its output
/// limit. Only text can be kept from a cut-off response: a cut-off tool call
/// has partial arguments.
fn response_output(response: &Value) -> Result<(&Vec<Value>, bool), String> {
    let output = response["output"].as_array();
    match response["status"].as_str() {
        Some("failed" | "cancelled") => return Err(INCOMPLETE.to_owned()),
        Some("incomplete") => {
            let kept = response["incomplete_details"]["reason"] == "max_output_tokens"
                && output.is_some_and(|output| {
                    !output.iter().any(|item| item["type"] == "function_call")
                        && !output_text(output).trim().is_empty()
                });
            return output
                .filter(|_| kept)
                .map(|output| (output, true))
                .ok_or_else(|| INCOMPLETE.to_owned());
        }
        _ => {}
    }
    output
        .map(|output| (output, false))
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

/// The first choice's message, and whether the model stopped at its output
/// limit. Only text can be kept from a cut-off message: a cut-off tool call
/// has partial arguments.
fn choice_message(response: &Value) -> Result<(&Value, bool), String> {
    let choice = response["choices"]
        .as_array()
        .and_then(|v| v.first())
        .ok_or("Provider response has no choice.")?;
    let message = choice
        .get("message")
        .filter(|v| v.is_object())
        .ok_or_else(|| "Provider response has no message.".to_owned())?;
    match choice["finish_reason"].as_str() {
        Some("content_filter") => Err(INCOMPLETE.to_owned()),
        Some("length") => {
            let calls = message["tool_calls"]
                .as_array()
                .is_some_and(|calls| !calls.is_empty());
            let text = message["content"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty());
            if calls || !text {
                return Err(INCOMPLETE.to_owned());
            }
            Ok((message, true))
        }
        _ => Ok((message, false)),
    }
}

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| "Provider returned a malformed tool call.".to_owned())
}

fn schema() -> Value {
    json!({"type":"object","properties":{"app":{"type":"string","enum":["terminal","vscode"]},"mode":{"type":["string","null"],"enum":["default","tab","standalone",null]},"command":{"type":["string","null"],"maxLength":4096,"description":"One-line shell command to run in a new zter tab, or null to just open the app."},"path":{"type":["string","null"],"maxLength":4096,"description":"Folder to open in (or a file, for VS Code): absolute or relative to home, for example my_code/rs. null for none."}},"required":["app","mode","command","path"],"additionalProperties":false})
}

fn tool_definitions(responses: bool) -> Vec<Value> {
    let definitions = [
        (
            "open_app",
            "Open or focus the primary zter terminal with default mode; use tab to add a tab, or standalone only when a separate new terminal is requested. To open zter with a program running in it (for example cava, htop, or codex), set command to that one-line shell command: it runs in a new tab, or a new window with standalone. Set path to open VS Code at a folder or file, or to start a new terminal tab in a folder. VS Code always opens a new window, only accepts default mode, and takes command null.",
            schema(),
        ),
        (
            "run_command",
            "Run a noninteractive Bash command on this computer as the current user. Use for inspecting/editing files, running installed programs, and general local tasks. Supports pipes and scripts. Prefer open_app for supported desktop actions. workdir must be absolute or null for home; each call has a fresh shell. timeout_ms is 1–120000 or null for 30000. Returns stdout/stderr (first 8192 bytes each), exit_code, timed_out, and truncated. Stdin is closed. Timeout/cancellation stop the active process group. To start a persistent job, explicitly redirect its stdin/stdout/stderr and capture its PID; detached jobs are not tracked or cancelled after this call completes. Interactive sessions are unavailable: never run full-screen or interactive programs such as cava, htop, vim, or codex here; open them with open_app and command instead.",
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
    #[serde(default)]
    command: Option<String>,
    #[serde(default)]
    path: Option<String>,
}

/// The run_command request for an open_app call with a command or path:
/// zter with `command` typed into the shell of a new tab (or a new window in
/// standalone mode), or VS Code at `path`.
fn launch_command(
    app: App,
    mode: LaunchMode,
    command: Option<&str>,
    path: Option<&str>,
) -> Result<CommandRequest, String> {
    let one_line = |value: &str, name: &str| {
        let value = value.trim();
        if value.len() > 4096 || value.chars().any(char::is_control) {
            Err(format!("{name} must be one line of up to 4096 bytes."))
        } else {
            Ok(value.to_owned())
        }
    };
    let quote = |value: &str| format!("'{}'", value.replace('\'', r"'\''"));
    let path = match path {
        Some(path) => Some(home_path(&one_line(path, "path")?)?),
        None => None,
    };
    let script = match app {
        App::Vscode => {
            let path = quote(path.as_deref().ok_or("path is required.")?);
            format!(
                "[ -e {path} ] || {{ printf 'Not found: %s. Search for it, then try again.\\n' {path} >&2; exit 1; }}\n\
                 for code in code code-oss codium; do\n\
                 if command -v \"$code\" >/dev/null; then setsid \"$code\" --new-window {path} </dev/null >/dev/null 2>&1 & exit 0; fi\n\
                 done\n\
                 echo 'VS Code is not installed.' >&2; exit 127"
            )
        }
        App::Terminal => {
            let mut run = Vec::new();
            let mut check = String::new();
            if let Some(path) = &path {
                let path = quote(path);
                check = format!(
                    "[ -d {path} ] || {{ printf 'Folder not found: %s. Search for it, then try again.\\n' {path} >&2; exit 1; }}\n"
                );
                run.push(format!("cd {path}"));
            }
            if let Some(command) = command {
                run.push(one_line(command, "command")?);
            }
            let flag = match mode {
                LaunchMode::Standalone => "-s",
                _ => "--new-tab",
            };
            format!(
                "{check}command -v zter >/dev/null || {{ echo 'zter is not installed.' >&2; exit 127; }}\n\
                 setsid zter {flag} --run {} </dev/null >/dev/null 2>&1 &",
                quote(&run.join(" && "))
            )
        }
    };
    Ok(CommandRequest {
        command: script,
        workdir: None,
        timeout_ms: Some(10_000),
    })
}

/// Resolves `path` against the user's home unless it is absolute; ~ means home.
fn home_path(path: &str) -> Result<String, String> {
    if path.starts_with('/') {
        return Ok(path.to_owned());
    }
    let home =
        std::env::var("HOME").map_err(|_| "Cannot locate your home; use an absolute path.")?;
    let relative = path
        .strip_prefix('~')
        .unwrap_or(path)
        .trim_start_matches('/');
    Ok(if relative.is_empty() {
        home
    } else {
        format!("{}/{relative}", home.trim_end_matches('/'))
    })
}

#[derive(Default)]
struct Executed {
    ids: HashMap<String, (String, String, Value)>,
    apps: HashMap<(App, LaunchMode), Value>,
    count: usize,
    failures: usize,
}

const NOT_FOUND_HINT: &str = "A file or folder was not found. Before asking the user, search for it with run_command, for example: find ~/my_code/rs -name main.rs -not -path '*/target/*' -not -path '*/.*' (source files are often under src). Then retry with the path found.";

/// Whether a failed result says a file or folder does not exist.
fn missing_path(result: &Value) -> bool {
    ["stderr", "message"].iter().any(|key| {
        result[key].as_str().is_some_and(|text| {
            [
                "No such file or directory",
                "not found",
                "can't read",
                "cannot access",
            ]
            .iter()
            .any(|marker| text.contains(marker))
        })
    })
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
        let mut result = self.run(id, name, arguments, tools).await?;
        self.failures = if failed(&result) {
            self.failures + 1
        } else {
            0
        };
        // Small models ask the user right away; a hint next to the error works
        // better than the same rule in the system prompt.
        if failed(&result) && missing_path(&result) {
            result["hint"] = json!(NOT_FOUND_HINT);
        }
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
                Ok(Arguments {
                    app,
                    mode,
                    command,
                    path,
                }) => {
                    let mode = mode.unwrap_or_default();
                    let command = command.filter(|command| !command.trim().is_empty());
                    let path = path.filter(|path| !path.trim().is_empty());
                    if app == App::Vscode && (mode != LaunchMode::Default || command.is_some()) {
                        json!({"success":false,"message":"VS Code only supports default mode and command null; tab, standalone, and commands are terminal options. Use path to open a folder."})
                    } else if command.is_some() || path.is_some() {
                        match launch_command(app, mode, command.as_deref(), path.as_deref()) {
                            Ok(request) => tools.run_command(request).await?,
                            Err(message) => json!({"success":false,"message":message}),
                        }
                    } else if let Some(result) = self.apps.get(&(app, mode)) {
                        result.clone()
                    } else {
                        let result = tools.open_app(app, mode).await?;
                        self.apps.insert((app, mode), result.clone());
                        result
                    }
                }
                Err(_) => {
                    json!({"success":false,"message":"open_app requires app: terminal or vscode, optional mode: default, tab, or standalone, and optional command and path."})
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
    async fn terminal_commands_open_zter_with_the_program_running() {
        let mut executed = Executed::default();
        let mut tools = FakeTools::default();
        for (id, arguments) in [
            (
                "a",
                r#"{"app":"terminal","mode":"default","command":"cava"}"#,
            ),
            (
                "b",
                r#"{"app":"terminal","mode":"standalone","command":"echo 'hi'"}"#,
            ),
            // Each call is its own terminal, unlike plain opens.
            ("c", r#"{"app":"terminal","mode":null,"command":"cava"}"#),
        ] {
            let result = executed
                .call(id, "open_app", arguments, &mut tools)
                .await
                .unwrap();
            assert_eq!(result["success"], true);
        }
        assert!(tools.calls.is_empty());
        assert_eq!(tools.commands.len(), 3);
        assert!(tools.commands[0].contains("setsid zter --new-tab --run 'cava' </dev/null"));
        let quoted = ["'echo ", r"'\''", "hi", r"'\''", "'"].concat();
        assert!(tools.commands[1].contains(&format!("setsid zter -s --run {quoted} ")));
        // An empty command just opens the terminal.
        executed
            .call(
                "d",
                "open_app",
                r#"{"app":"terminal","mode":null,"command":" "}"#,
                &mut tools,
            )
            .await
            .unwrap();
        assert_eq!(tools.calls, [(App::Terminal, LaunchMode::Default)]);
        for (id, arguments) in [
            ("e", r#"{"app":"vscode","mode":null,"command":"ls"}"#),
            (
                "f",
                r#"{"app":"terminal","mode":null,"command":"ls\nrm x"}"#,
            ),
        ] {
            let result = executed
                .call(id, "open_app", arguments, &mut tools)
                .await
                .unwrap();
            assert_eq!(result["success"], false);
        }
        assert_eq!(tools.commands.len(), 3);
    }

    #[tokio::test]
    async fn paths_open_vscode_or_a_terminal_tab_in_that_folder() {
        let home = std::env::var("HOME").unwrap();
        let mut executed = Executed::default();
        let mut tools = FakeTools::default();
        for (id, arguments) in [
            (
                "a",
                r#"{"app":"vscode","mode":null,"command":null,"path":"my_code/rs"}"#,
            ),
            (
                "b",
                r#"{"app":"terminal","mode":null,"command":"cargo run","path":"~/my_code/rs"}"#,
            ),
            (
                "c",
                r#"{"app":"terminal","mode":"tab","command":null,"path":"/tmp"}"#,
            ),
        ] {
            let result = executed
                .call(id, "open_app", arguments, &mut tools)
                .await
                .unwrap();
            assert_eq!(result["success"], true);
        }
        assert!(tools.calls.is_empty());
        let folder = format!("'{home}/my_code/rs'");
        assert!(tools.commands[0].starts_with(&format!("[ -e {folder} ]")));
        assert!(tools.commands[0].contains(&format!("--new-window {folder} </dev/null")));
        assert!(tools.commands[1].starts_with(&format!("[ -d {folder} ]")));
        assert!(tools.commands[1].contains(&format!(
            "--run 'cd {} && cargo run'",
            folder.replace('\'', r"'\''")
        )));
        assert!(tools.commands[2].contains(r"zter --new-tab --run 'cd '\''/tmp'\''' "));
        let result = executed
            .call(
                "d",
                "open_app",
                r#"{"app":"vscode","mode":null,"command":"ls","path":"/tmp"}"#,
                &mut tools,
            )
            .await
            .unwrap();
        assert_eq!(result["success"], false);
        assert_eq!(tools.commands.len(), 3);
    }

    #[tokio::test]
    async fn missing_files_add_a_search_hint() {
        struct Missing;
        impl Tools for Missing {
            async fn open_app(&mut self, _: App, _: LaunchMode) -> Result<Value, String> {
                unreachable!()
            }
            async fn run_command(&mut self, request: CommandRequest) -> Result<Value, String> {
                let stderr = if request.command == "missing" {
                    "sed: can't read main.rs: No such file or directory\n"
                } else {
                    "permission denied\n"
                };
                Ok(json!({"success":false,"exit_code":2,"stderr":stderr}))
            }
        }
        let mut executed = Executed::default();
        let call = |command: &str| format!(r#"{{"command":"{command}","workdir":null}}"#);
        let result = executed
            .call("a", "run_command", &call("missing"), &mut Missing)
            .await
            .unwrap();
        assert_eq!(result["hint"], NOT_FOUND_HINT);
        let result = executed
            .call("b", "run_command", &call("denied"), &mut Missing)
            .await
            .unwrap();
        assert!(result.get("hint").is_none());
    }

    #[test]
    fn log_records_reach_the_model_as_system_notes() {
        let record = Message {
            role: "assistant".into(),
            content: "Command: pwd".into(),
            tool: true,
        };
        assert_eq!(
            history_item(&record),
            json!({"role":"system","content":format!("{TOOL_LOG_NOTE}\nCommand: pwd")})
        );
        let reply = Message {
            tool: false,
            ..record
        };
        assert_eq!(
            history_item(&reply),
            json!({"role":"assistant","content":"Command: pwd"})
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
            r#"{"app":"terminal","mode":"tab","extra":"ls"}"#,
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
        let replies = responses
            .into_iter()
            .map(|response| Reply {
                content_type: "application/json",
                body: response.to_string(),
                stall: false,
            })
            .collect();
        mock_replies(replies).await
    }

    /// A raw response body; `stall` keeps the connection open after it, as a
    /// provider still writing would.
    struct Reply {
        content_type: &'static str,
        body: String,
        stall: bool,
    }

    /// Server-sent events: one data field per event, then [DONE].
    fn sse(events: &[Value]) -> Reply {
        let mut body: String = events
            .iter()
            .map(|event| format!("data: {event}\n\n"))
            .collect();
        body.push_str("data: [DONE]\n\n");
        Reply {
            content_type: "text/event-stream",
            body,
            stall: false,
        }
    }

    async fn mock_replies(replies: Vec<Reply>) -> (String, tokio::task::JoinHandle<Vec<Value>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("http://{}/mock", listener.local_addr().unwrap());
        let task = tokio::spawn(async move {
            let mut requests = Vec::new();
            for reply in replies {
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
                // A streamed body has no length and ends when the connection closes.
                let length = if reply.content_type == "application/json" {
                    format!("Content-Length: {}\r\n", reply.body.len())
                } else {
                    String::new()
                };
                socket.write_all(format!("HTTP/1.1 200 OK\r\nContent-Type: {}\r\n{length}Connection: close\r\n\r\n{}", reply.content_type, reply.body).as_bytes()).await.unwrap();
                if reply.stall {
                    // Wait until the client gives up and closes the connection.
                    let _ = socket.read(&mut [0; 64]).await;
                }
            }
            requests
        });
        (endpoint, task)
    }

    #[tokio::test]
    async fn deepseek_streams_text_reasoning_and_split_tool_calls() {
        let delta = |delta: Value, finish: Value| json!({"choices":[{"index":0,"delta":delta,"finish_reason":finish}]});
        let mut first = sse(&[
            delta(
                json!({"role":"assistant","reasoning_content":"open "}),
                Value::Null,
            ),
            delta(json!({"reasoning_content":"it"}), Value::Null),
            delta(
                json!({"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"open_app","arguments":""}}]}),
                Value::Null,
            ),
            delta(
                json!({"tool_calls":[{"index":0,"function":{"arguments":"{\"app\":"}}]}),
                Value::Null,
            ),
            delta(
                json!({"tool_calls":[{"index":0,"function":{"arguments":"\"vscode\"}"}}]}),
                Value::Null,
            ),
            delta(json!({}), json!("tool_calls")),
            json!({"choices":[],"usage":{"completion_tokens":9}}),
        ]);
        // Keep-alive comments carry nothing.
        first.body.insert_str(0, ": keep-alive\n\n");
        let mut last = sse(&[
            delta(json!({"content":"Rea"}), Value::Null),
            delta(json!({"content":"dy."}), json!("stop")),
        ]);
        // The last event may end without a line break.
        last.body = last.body.trim_end().to_owned();
        let (url, server) = mock_replies(vec![first, last]).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), "Ready.");
        assert_eq!(tools.calls, vec![(App::Vscode, LaunchMode::Default)]);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["stream"], true);
        let assistant = &requests[1]["messages"][1];
        assert_eq!(assistant["reasoning_content"], "open it");
        assert_eq!(assistant["content"], Value::Null);
        assert_eq!(
            assistant["tool_calls"],
            json!([{"id":"call_1","type":"function","function":{"name":"open_app","arguments":"{\"app\":\"vscode\"}"}}])
        );
        assert_eq!(requests[1]["messages"][2]["tool_call_id"], "call_1");
    }

    #[tokio::test]
    async fn responses_and_ollama_streams_return_their_final_reply() {
        let done = json!({"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Hello there."}]}]}});
        let mut reply = sse(&[
            json!({"type":"response.created","response":{"status":"in_progress"}}),
            json!({"type":"response.output_text.delta","delta":"Hello"}),
            json!({"type":"response.output_text.delta","delta":" there."}),
            done,
        ]);
        // Event names are ignored; the data carries the type.
        reply.body = reply.body.replace("data: ", "event: x\ndata: ");
        let (url, server) = mock_replies(vec![reply]).await;
        let mut tools = FakeTools::default();
        let client = test_client(Provider::OpenAi, url);
        assert_eq!(client.chat(&[], &mut tools).await.unwrap(), "Hello there.");
        assert_eq!(server.await.unwrap()[0]["stream"], true);

        let lines = [
            json!({"message":{"role":"assistant","content":"สวัสดี"},"done":false}),
            json!({"message":{"role":"assistant","content":"ครับ"},"done":false}),
            json!({"message":{"role":"assistant","content":""},"done":true,"done_reason":"stop"}),
        ];
        let body = lines.iter().map(|line| format!("{line}\n")).collect();
        let (url, server) = mock_replies(vec![Reply {
            content_type: "application/x-ndjson",
            body,
            stall: false,
        }])
        .await;
        let reply = test_client(Provider::Ollama, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), "สวัสดีค่ะ");
        assert_eq!(server.await.unwrap()[0]["stream"], true);
    }

    #[tokio::test]
    async fn streams_keep_their_text_at_the_deadline_and_fail_when_silent() {
        let delta = |text: &str| json!({"choices":[{"index":0,"delta":{"content":text},"finish_reason":null}]});
        let stalled = |events: &[Value]| {
            let mut reply = sse(events);
            reply.body = reply.body.replace("data: [DONE]\n\n", "");
            reply.stall = true;
            reply
        };
        let (url, server) = mock_replies(vec![stalled(&[delta("still "), delta("writing")])]).await;
        let mut client = test_client(Provider::DeepSeek, url);
        client.deadline = Instant::now() + Duration::from_millis(300);
        let mut tools = FakeTools::default();
        let reply = client.chat(&[], &mut tools).await;
        assert_eq!(reply.unwrap(), format!("still writing\n\n{CUT_OFF_EN}"));
        server.await.unwrap();

        let (url, server) = mock_replies(vec![stalled(&[
            json!({"type":"response.output_text.delta","delta":"ยังเขียนอยู่"}),
        ])])
        .await;
        let mut client = test_client(Provider::OpenAi, url);
        client.deadline = Instant::now() + Duration::from_millis(300);
        let reply = client.chat(&[], &mut tools).await;
        assert_eq!(reply.unwrap(), format!("ยังเขียนอยู่\n\n{CUT_OFF_TH}"));
        server.await.unwrap();

        // Silence before the deadline is a timeout, not a cut-off reply.
        let (url, server) = mock_replies(vec![stalled(&[delta("hi")])]).await;
        let mut client = test_client(Provider::DeepSeek, url);
        client.idle = Duration::from_millis(200);
        let error = client.chat(&[], &mut tools).await;
        assert_eq!(error.unwrap_err(), "Provider request timed out.");
        server.await.unwrap();

        // A stream that closes without finishing is an error.
        let mut reply = stalled(&[delta("hi")]);
        reply.stall = false;
        let (url, server) = mock_replies(vec![reply]).await;
        let error = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(error.unwrap_err(), "Provider response ended early.");
        server.await.unwrap();

        // An error event is reported without its body.
        let (url, server) =
            mock_replies(vec![sse(&[json!({"error":{"message":"secret detail"}})])]).await;
        let error = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(error.unwrap_err(), INCOMPLETE);
        server.await.unwrap();
        assert!(tools.calls.is_empty() && tools.commands.is_empty());
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
                        content: "เปิดแท็บใหม่".into(),
                        tool: false,
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
            json!(["app", "mode", "command", "path"])
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
    async fn ollama_uses_its_native_api_without_a_key_and_drops_tools_at_the_limit() {
        let arguments = json!({"command":"pwd","workdir":"/tmp","timeout_ms":null});
        // Ollama may omit tool call IDs; generated ones must not repeat.
        let call = |_| json!({"message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"run_command","arguments":arguments}}]},"done":true,"done_reason":"stop"});
        let mut responses: Vec<Value> = (0..=MAX_TOOL_CALLS).map(call).collect();
        responses.push(json!({"message":{"role":"assistant","content":"เสร็จแล้วครับ ต้องการอะไรอีกไหมครับ?"},"done":true,"done_reason":"stop"}));
        let (url, server) = mock_server(responses).await;
        let mut client = test_client(Provider::Ollama, url);
        client.config.api_key.clear();
        let mut tools = FakeTools::default();
        // An empty key redacts nothing, and Aiko keeps her feminine particles.
        assert_eq!(
            client.chat(&[], &mut tools).await.unwrap(),
            "เสร็จแล้วค่ะ ต้องการอะไรอีกไหมคะ?"
        );
        assert_eq!(tools.commands.len(), MAX_TOOL_CALLS);
        let requests = server.await.unwrap();
        let first = &requests[0];
        assert!(first["tools"].is_array() && first.get("tool_choice").is_none());
        assert_eq!(first["think"], false);
        assert_eq!(first["keep_alive"], "30m");
        assert_eq!(first["options"]["num_ctx"], 8192);
        // Follow-ups send arguments back as an object and name the tool.
        let messages = requests[1]["messages"].as_array().unwrap();
        let (assistant, result) = (&messages[1], &messages[2]);
        assert_eq!(
            assistant["tool_calls"][0]["function"]["arguments"],
            arguments
        );
        assert_eq!(result["role"], "tool");
        assert_eq!(result["tool_name"], "run_command");
        assert_eq!(result["tool_call_id"], assistant["tool_calls"][0]["id"]);
        let last = requests.last().unwrap();
        assert!(last.get("tools").is_none());
        assert_eq!(
            last["messages"].as_array().unwrap().last().unwrap()["content"],
            LIMIT_NOTE
        );

        let (url, server) = mock_server(vec![json!({"message":{"role":"assistant","content":"ยาว"},"done":true,"done_reason":"length"})]).await;
        let reply = test_client(Provider::Ollama, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), format!("ยาว\n\n{CUT_OFF_TH}"));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn replies_cut_at_the_output_limit_are_kept_and_marked() {
        // A cut-off code block is closed so the rest of the reply renders.
        let code = "Here:\n```rust\nfor row in 0..40 {";
        let (url, server) = mock_server(vec![json!({"choices":[{"message":{"role":"assistant","content":code},"finish_reason":"length"}]})]).await;
        let mut tools = FakeTools::default();
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), format!("{code}\n```\n\n{CUT_OFF_EN}"));
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["max_tokens"], MAX_OUTPUT_TOKENS);

        // A cut-off tool call has partial arguments, so it stays an error.
        let call = json!({"id":"call-0","type":"function","function":{"name":"run_command","arguments":"{\"comm"}});
        let (url, server) = mock_server(vec![json!({"choices":[{"message":{"role":"assistant","content":null,"tool_calls":[call]},"finish_reason":"length"}]})]).await;
        let error = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(error.unwrap_err(), INCOMPLETE);
        assert!(tools.commands.is_empty());
        server.await.unwrap();

        let (url, server) = mock_server(vec![json!({"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"ยาวมาก"}]}]})]).await;
        let reply = test_client(Provider::OpenAi, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(reply.unwrap(), format!("ยาวมาก\n\n{CUT_OFF_TH}"));
        server.await.unwrap();

        let (url, server) = mock_server(vec![json!({"status":"incomplete","incomplete_details":{"reason":"content_filter"},"output":[{"type":"message","content":[{"type":"output_text","text":"x"}]}]})]).await;
        let error = test_client(Provider::OpenAi, url)
            .chat(&[], &mut tools)
            .await;
        assert_eq!(error.unwrap_err(), INCOMPLETE);
        server.await.unwrap();

        // An over-long reply is cut at a line break instead of failing.
        let line = "a".repeat(99);
        let long = vec![line.as_str(); 400].join("\n");
        let (url, server) = mock_server(vec![json!({"choices":[{"message":{"role":"assistant","content":long},"finish_reason":"stop"}]})]).await;
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&[], &mut tools)
            .await
            .unwrap();
        let (kept, note) = reply.rsplit_once("\n\n").unwrap();
        assert_eq!(note, CUT_OFF_EN);
        assert!(kept.len() <= MAX_REPLY_BYTES && kept.ends_with(&line));
        server.await.unwrap();
    }

    #[tokio::test]
    async fn claimed_actions_without_a_tool_get_one_correction() {
        let reply =
            |text: &str| json!({"choices":[{"message":{"role":"assistant","content":text}}]});
        let history = [Message {
            role: "user".into(),
            content: "ปิด terminal ที่เปิดเมื่อกี้หน่อย".into(),
            tool: false,
        }];
        let (url, server) = mock_server(vec![
            reply("ปิด terminal ให้แล้วนะคะ"),
            reply("ตอนนี้ยังปิด terminal ไม่ได้ค่ะ"),
        ])
        .await;
        let mut tools = FakeTools::default();
        let answer = test_client(Provider::DeepSeek, url)
            .chat(&history, &mut tools)
            .await;
        assert_eq!(answer.unwrap(), "ตอนนี้ยังปิด terminal ไม่ได้ค่ะ");
        let requests = server.await.unwrap();
        let messages = requests[1]["messages"].as_array().unwrap();
        assert_eq!(messages.last().unwrap()["content"], UNBACKED_NOTE);
        assert_eq!(requests[1]["tool_choice"], "auto");

        // Only one correction, and none for ordinary replies.
        let (url, server) = mock_server(vec![
            reply("ปิดให้แล้วค่ะ"),
            reply("ปิดให้แล้วค่ะ"),
            reply("สบายดีค่ะ"),
        ])
        .await;
        let client = test_client(Provider::DeepSeek, url);
        assert_eq!(
            client.chat(&history, &mut tools).await.unwrap(),
            "ปิดให้แล้วค่ะ"
        );
        assert_eq!(client.chat(&history, &mut tools).await.unwrap(), "สบายดีค่ะ");
        assert_eq!(server.await.unwrap().len(), 3);
        assert!(claims_action("Done, I've opened it."));
        assert!(!claims_action("ขอบคุณที่ถามนะคะ สบายดีค่ะ"));
    }

    #[test]
    fn leading_speaker_labels_are_dropped() {
        assert_eq!(without_speaker("ไอโกะ: เสร็จแล้วค่ะ"), "เสร็จแล้วค่ะ");
        assert_eq!(without_speaker(" Aiko : done"), "done");
        assert_eq!(without_speaker("[Aiko] hi"), "hi");
        assert_eq!(without_speaker("ไอโกะช่วยได้ค่ะ"), "ไอโกะช่วยได้ค่ะ");
    }

    #[test]
    fn feminine_particles_replace_masculine_ones_outside_code() {
        assert_eq!(
            feminine("สวัสดีครับ! ได้ครับผม เอาอะไรครับ นะครับ บอกนะค่ะ\n```sh\necho ครับ\n```\nโอเคครับ"),
            "สวัสดีค่ะ! ได้ค่ะ เอาอะไรคะ นะคะ บอกนะคะ\n```sh\necho ครับ\n```\nโอเคค่ะ"
        );
    }

    #[test]
    fn cjk_words_are_removed_and_other_text_kept() {
        assert_eq!(
            without_cjk("สวัสดีค่ะ 有什么可以帮您的吗？\nเรียกเปิด zter ให้แล้วค่ะ 有什么需要帮忙的吗? 😊"),
            "สวัสดีค่ะ\nเรียกเปิด zter ให้แล้วค่ะ 😊"
        );
        assert!(!"สวัสดี hello 😊 ค่ะ".chars().any(cjk));
        assert!("こんにちは 안녕 你好".chars().all(|c| c == ' ' || cjk(c)));
    }

    #[tokio::test]
    async fn replies_in_an_unasked_cjk_script_are_rewritten_once() {
        let native =
            |text: &str| json!({"message":{"role":"assistant","content":text},"done":true});
        let mixed = native("สวัสดีค่ะ 有什么可以帮您的吗?");
        let thai = native("สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ");
        let history = [Message {
            role: "user".into(),
            content: "ดีครับ".into(),
            tool: false,
        }];
        let (url, server) = mock_server(vec![mixed.clone(), thai]).await;
        let reply = test_client(Provider::Ollama, url)
            .chat(&history, &mut FakeTools::default())
            .await;
        assert_eq!(reply.unwrap(), "สวัสดีค่ะ มีอะไรให้ช่วยไหมคะ");
        let requests = server.await.unwrap();
        let system = requests[0]["messages"][0]["content"].as_str().unwrap();
        assert!(system.ends_with(OLLAMA_NOTE));
        let retry = &requests[1];
        assert!(retry.get("tools").is_none());
        assert_eq!(
            retry["messages"].as_array().unwrap().last().unwrap()["content"],
            LANGUAGE_NOTE
        );

        // A rewrite that still mixes scripts loses its CJK words.
        let mixed_completion = json!({"choices":[{"message":{"role":"assistant","content":"สวัสดีค่ะ 有什么可以帮您的吗?"}}]});
        let (url, server) = mock_server(vec![mixed_completion.clone(), mixed_completion]).await;
        let reply = test_client(Provider::DeepSeek, url)
            .chat(&history, &mut FakeTools::default())
            .await;
        assert_eq!(reply.unwrap(), "สวัสดีค่ะ");
        assert_eq!(server.await.unwrap().len(), 2);

        // CJK the user wrote is left alone, with no extra request.
        let asked = [Message {
            role: "user".into(),
            content: "你好 แปลว่าอะไร".into(),
            tool: false,
        }];
        let (url, server) = mock_server(vec![mixed]).await;
        let reply = test_client(Provider::Ollama, url)
            .chat(&asked, &mut FakeTools::default())
            .await;
        assert_eq!(reply.unwrap(), "สวัสดีค่ะ 有什么可以帮您的吗?");
        assert_eq!(server.await.unwrap().len(), 1);
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
                ollama_url: String::new(),
                ollama_context: 8192,
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
                        ollama_url: String::new(),
                        ollama_context: 8192,
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
                    Provider::DeepSeek | Provider::Ollama => &request["messages"][0]["content"],
                }
                .as_str()
                .unwrap();
                assert!(system.starts_with(SYSTEM));
                assert_eq!(system.contains(ASK_NOTE), permissions == Permissions::Ask);
            }
        }
    }
}
