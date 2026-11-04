use std::{collections::HashMap, future::Future, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::config::{Config, Provider};

const MAX_RESPONSE_BYTES: usize = 1_048_576;
const MAX_TOOL_CALLS: usize = 4;
const SYSTEM: &str = include_str!("../prompts/aiko.md");

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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Message {
    pub role: String,
    pub content: String,
}

pub trait Tools {
    fn open_app(&mut self, app: App) -> impl Future<Output = Result<Value, String>> + Send;
}

#[derive(Clone)]
pub struct Client {
    http: reqwest::Client,
    config: Config,
    endpoint: String,
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
        })
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
        let mut executed = Executed::default();
        for _ in 0..=MAX_TOOL_CALLS {
            let mut request = json!({
                "model": self.config.model,
                "instructions": SYSTEM,
                "input": input,
                "tools": [{"type":"function","name":"open_app","description":"Open a new standalone zter terminal window or a new VS Code window.","parameters":schema(),"strict":true}],
                "parallel_tool_calls": false,
                "store": false,
                "include": ["reasoning.encrypted_content"],
                "max_output_tokens": 4096
            });
            if self.config.model.starts_with("gpt-6") || self.config.model.starts_with("gpt-5") {
                request["reasoning"] = json!({"effort":"low"});
            }
            let response = self.post(request).await?;
            if matches!(
                response["status"].as_str(),
                Some("failed" | "cancelled" | "incomplete")
            ) {
                return Err(
                    "Provider did not complete its response. Try a shorter request.".to_owned(),
                );
            }
            let output = response["output"]
                .as_array()
                .ok_or("Provider response has no output.")?;
            let calls: Vec<_> = output
                .iter()
                .filter(|item| item["type"] == "function_call")
                .collect();
            if calls.is_empty() {
                let text = output
                    .iter()
                    .filter(|item| item["type"] == "message")
                    .flat_map(|item| item["content"].as_array().into_iter().flatten())
                    .filter(|part| part["type"] == "output_text")
                    .filter_map(|part| part["text"].as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                return self.reply(text);
            }
            if calls.len() + executed.count > MAX_TOOL_CALLS {
                return Err("Tool call limit reached for this request.".to_owned());
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
        }
        Err("Tool call limit reached for this request.".to_owned())
    }

    async fn completions(
        &self,
        history: &[Message],
        tools: &mut impl Tools,
    ) -> Result<String, String> {
        let mut messages = vec![json!({"role":"system","content":SYSTEM})];
        messages.extend(
            history
                .iter()
                .map(|m| json!({"role":m.role,"content":m.content})),
        );
        let mut executed = Executed::default();
        for _ in 0..=MAX_TOOL_CALLS {
            let response = self.post(json!({
                "model":self.config.model,
                "messages":messages,
                "tools":[{"type":"function","function":{"name":"open_app","description":"Open a new standalone zter terminal window or a new VS Code window.","parameters":schema()}}],
                "max_tokens":2048,
                "stream":false
            })).await?;
            let choice = response["choices"]
                .as_array()
                .and_then(|v| v.first())
                .ok_or("Provider response has no choice.")?;
            if matches!(
                choice["finish_reason"].as_str(),
                Some("length" | "content_filter")
            ) {
                return Err(
                    "Provider did not complete its response. Try a shorter request.".to_owned(),
                );
            }
            let message = choice
                .get("message")
                .filter(|v| v.is_object())
                .ok_or("Provider response has no message.")?;
            let calls = message["tool_calls"]
                .as_array()
                .filter(|calls| !calls.is_empty());
            let Some(calls) = calls else {
                return self.reply(message["content"].as_str().unwrap_or_default().to_owned());
            };
            if calls.len() + executed.count > MAX_TOOL_CALLS {
                return Err("Tool call limit reached for this request.".to_owned());
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
        }
        Err("Tool call limit reached for this request.".to_owned())
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

fn field<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or_else(|| "Provider returned a malformed tool call.".to_owned())
}

fn schema() -> Value {
    json!({"type":"object","properties":{"app":{"type":"string","enum":["terminal","vscode"]}},"required":["app"],"additionalProperties":false})
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Arguments {
    app: App,
}

#[derive(Default)]
struct Executed {
    ids: HashMap<String, (String, String, Value)>,
    apps: HashMap<App, Value>,
    count: usize,
}

impl Executed {
    async fn call(
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
        let result = if name != "open_app" {
            json!({"success":false,"message":"Only open_app is supported."})
        } else {
            match serde_json::from_str::<Arguments>(arguments) {
                Ok(Arguments { app }) => {
                    if let Some(result) = self.apps.get(&app) {
                        result.clone()
                    } else {
                        let result = tools.open_app(app).await?;
                        self.apps.insert(app, result.clone());
                        result
                    }
                }
                Err(_) => {
                    json!({"success":false,"message":"open_app requires only app: terminal or vscode."})
                }
            }
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
        calls: Vec<App>,
    }
    impl Tools for FakeTools {
        async fn open_app(&mut self, app: App) -> Result<Value, String> {
            self.calls.push(app);
            Ok(json!({"success":true,"message":"Launch requested."}))
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
        assert_eq!(tools.calls, vec![App::Terminal]);
        assert!(
            executed
                .call("one", "open_app", r#"{"app":"vscode"}"#, &mut tools)
                .await
                .is_err()
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
        let first = json!({"status":"completed","output":[{"type":"reasoning","id":"rs_1","summary":[],"encrypted_content":"encrypted-test"},{"type":"function_call","id":"fc_1","call_id":"call_1","name":"open_app","arguments":"{\"app\":\"terminal\"}"}]});
        let last = json!({"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Launch requested."}]}]});
        let (url, server) = mock_server(vec![first.clone(), last]).await;
        let client = Client::with_endpoint(
            Config {
                provider: Provider::OpenAi,
                model: "gpt-6.1-sol".into(),
                api_key: "dummy-test-key".into(),
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
                        content: "เปิด terminal".into()
                    }],
                    &mut tools
                )
                .await
                .unwrap(),
            "Launch requested."
        );
        assert_eq!(tools.calls, vec![App::Terminal]);
        let requests = server.await.unwrap();
        assert_eq!(requests[0]["store"], false);
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
                api_key: "dummy-test-key".into(),
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
        assert_eq!(tools.calls, vec![App::Vscode]);
    }
}
