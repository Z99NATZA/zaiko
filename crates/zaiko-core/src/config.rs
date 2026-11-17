use std::{collections::HashMap, path::Path};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    DeepSeek,
    /// A local Ollama server; it needs no API key.
    Ollama,
}

pub const DEFAULT_OLLAMA_URL: &str = "http://127.0.0.1:11434";
/// Large enough for the system prompt, tools, and a few turns, while an 8B
/// model still fits on an 8 GB GPU.
pub const DEFAULT_OLLAMA_CONTEXT: u32 = 8192;

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::DeepSeek => "deepseek",
            Self::Ollama => "ollama",
        }
    }

    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai" => Some(Self::OpenAi),
            "deepseek" => Some(Self::DeepSeek),
            "ollama" => Some(Self::Ollama),
            _ => None,
        }
    }

    /// The variable holding this provider's API key, if it needs one.
    pub fn key_name(self) -> Option<&'static str> {
        match self {
            Self::OpenAi => Some("OPENAI_API_KEY"),
            Self::DeepSeek => Some("DEEPSEEK_API_KEY"),
            Self::Ollama => None,
        }
    }

    const KEYED: [Self; 2] = [Self::OpenAi, Self::DeepSeek];
}

/// A model and the provider that serves it.
#[derive(Clone, PartialEq, Eq)]
pub struct ModelChoice {
    pub provider: Provider,
    pub model: String,
}

impl ModelChoice {
    /// Reads "openai:<id>", "deepseek:<id>" or "ollama:<id>", or infers the
    /// provider from the ID: a tagged name such as qwen3:8b is Ollama,
    /// deepseek* is DeepSeek, gpt-* is OpenAI, anything else uses `default`.
    pub fn parse(entry: &str, default: Provider) -> Option<Self> {
        let explicit = entry
            .split_once(':')
            .and_then(|(provider, model)| Provider::parse(provider).map(|p| (p, model)));
        let (provider, model) = explicit.unwrap_or_else(|| {
            let provider = if entry.contains(':') {
                Provider::Ollama
            } else if entry.starts_with("deepseek") {
                Provider::DeepSeek
            } else if entry.starts_with("gpt-") {
                Provider::OpenAi
            } else {
                default
            };
            (provider, entry)
        });
        valid_model(model).then(|| Self {
            provider,
            model: model.to_owned(),
        })
    }
}

// Deliberately no Debug: configuration contains credentials.
#[derive(Clone)]
pub struct Config {
    pub provider: Provider,
    pub model: String,
    /// Models offered by the /model picker; starts with `provider`/`model`.
    pub models: Vec<ModelChoice>,
    /// Key for `provider`; empty for a provider that needs none.
    pub api_key: String,
    /// Valid keys for the other providers, used by models switched to with /model.
    pub keys: Vec<(Provider, String)>,
    /// Base URL of the Ollama server.
    pub ollama_url: String,
    /// Context window, in tokens, requested from Ollama.
    pub ollama_context: u32,
}

impl Config {
    pub fn key(&self, provider: Provider) -> Option<&str> {
        if provider.key_name().is_none() {
            return Some("");
        }
        if provider == self.provider {
            return Some(&self.api_key);
        }
        self.keys
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, key)| key.as_str())
    }

    pub fn secrets(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.api_key.as_str())
            .chain(self.keys.iter().map(|(_, key)| key.as_str()))
            .filter(|key| !key.is_empty())
    }

    /// The same configuration, pointed at another model and its provider's key.
    pub fn with_choice(&self, choice: &ModelChoice) -> Option<Self> {
        let api_key = self.key(choice.provider)?.to_owned();
        Some(Self {
            provider: choice.provider,
            model: choice.model.clone(),
            api_key,
            ..self.clone()
        })
    }
}

pub fn load(path: &Path) -> Result<Config, String> {
    let file = match dotenvy::from_path_iter(path) {
        Ok(iter) => iter
            .collect::<Result<HashMap<_, _>, _>>()
            .map_err(|_| "Configuration file is not valid dotenv syntax.".to_owned())?,
        Err(error) if error.not_found() => HashMap::new(),
        Err(_) => return Err("Cannot read configuration file.".to_owned()),
    };
    parse(|key| std::env::var(key).ok().or_else(|| file.get(key).cloned()))
}

pub fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.len() <= 128
        && model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._/-:".contains(&c))
}

pub fn parse(mut get: impl FnMut(&str) -> Option<String>) -> Result<Config, String> {
    let provider = Provider::parse(
        get("ZAIKO_LLM_PROVIDER")
            .as_deref()
            .unwrap_or("openai")
            .trim(),
    )
    .ok_or("ZAIKO_LLM_PROVIDER must be openai, deepseek or ollama.")?;
    let model = get("ZAIKO_LLM_MODEL").unwrap_or_default().trim().to_owned();
    if model.is_empty() {
        return Err("ZAIKO_LLM_MODEL is required.".to_owned());
    }
    if !valid_model(&model) {
        return Err("ZAIKO_LLM_MODEL must be a valid model ID.".to_owned());
    }
    let ollama_url = ollama_url(get("ZAIKO_OLLAMA_URL"))?;
    let ollama_context = match get("ZAIKO_OLLAMA_CONTEXT").as_deref().map(str::trim) {
        None | Some("") => DEFAULT_OLLAMA_CONTEXT,
        Some(value) => value
            .parse()
            .ok()
            .filter(|n| (2048..=262_144).contains(n))
            .ok_or("ZAIKO_OLLAMA_CONTEXT must be a number from 2048 to 262144.")?,
    };
    // A key is only an error when a configured model needs it.
    let mut key = |name: &str| -> Result<Option<String>, String> {
        let value = get(name).unwrap_or_default().trim().to_owned();
        if value.is_empty() {
            return Ok(None);
        }
        if value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(format!("{name} contains an invalid value."));
        }
        Ok(Some(value))
    };
    let api_key = match provider.key_name() {
        Some(name) => {
            key(name)?.ok_or_else(|| format!("{name} is required for {}.", provider.name()))?
        }
        None => String::new(),
    };
    // Keys of the other keyed providers, checked when a listed model needs one.
    let others: Vec<_> = Provider::KEYED
        .into_iter()
        .filter(|p| *p != provider)
        .map(|p| (p, key(p.key_name().unwrap_or_default())))
        .collect();
    let list = get("ZAIKO_LLM_MODELS").unwrap_or_default();
    let mut models = vec![ModelChoice {
        provider,
        model: model.clone(),
    }];
    let invalid_list =
        || "ZAIKO_LLM_MODELS must list up to 64 valid model IDs, separated by commas.".to_owned();
    for item in list
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let secret = (!api_key.is_empty() && item.contains(&api_key))
            || others.iter().any(|(_, key)| {
                key.as_ref()
                    .is_ok_and(|key| key.as_ref().is_some_and(|key| item.contains(key)))
            });
        // Snapshots are not redacted, so a key must never become a listed model.
        let Some(choice) = ModelChoice::parse(item, provider).filter(|_| !secret) else {
            return Err(invalid_list());
        };
        if models.contains(&choice) {
            continue;
        }
        if models.len() >= 64 {
            return Err(invalid_list());
        }
        if let Some((other, key)) = others.iter().find(|(p, _)| *p == choice.provider) {
            match key {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(format!(
                        "{} is required for {} models in ZAIKO_LLM_MODELS.",
                        other.key_name().unwrap_or_default(),
                        other.name()
                    ));
                }
                Err(error) => return Err(error.clone()),
            }
        }
        models.push(choice);
    }
    let keys = others
        .into_iter()
        .filter_map(|(p, key)| key.ok().flatten().map(|key| (p, key)))
        .collect();
    Ok(Config {
        provider,
        model,
        models,
        api_key,
        keys,
        ollama_url,
        ollama_context,
    })
}

/// Reads an http(s) base URL such as http://127.0.0.1:11434, without a trailing slash.
fn ollama_url(value: Option<String>) -> Result<String, String> {
    let value = value.unwrap_or_default();
    let value = value.trim().trim_end_matches('/');
    if value.is_empty() {
        return Ok(DEFAULT_OLLAMA_URL.to_owned());
    }
    let valid = value.len() <= 512
        && (value.starts_with("http://") || value.starts_with("https://"))
        && !value.chars().any(|c| c.is_control() || c.is_whitespace());
    if !valid {
        return Err("ZAIKO_OLLAMA_URL must be an http:// or https:// URL.".to_owned());
    }
    Ok(value.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn selected_provider_only_requires_its_own_key() {
        let config = parse(|key| {
            match key {
                "ZAIKO_LLM_PROVIDER" => Some("deepseek"),
                "ZAIKO_LLM_MODEL" => Some("deepseek-chat"),
                "DEEPSEEK_API_KEY" => Some("dummy-test-key"),
                _ => None,
            }
            .map(str::to_owned)
        })
        .unwrap();
        assert_eq!(config.provider.name(), "deepseek");
        assert_eq!(config.model, "deepseek-chat");
        assert!(
            config.models
                == [ModelChoice {
                    provider: Provider::DeepSeek,
                    model: "deepseek-chat".into()
                }]
        );
    }

    #[test]
    fn model_list_mixes_providers_and_infers_them_from_ids() {
        let get = |list: &'static str, openai: &'static str| {
            move |key: &str| {
                match key {
                    "ZAIKO_LLM_PROVIDER" => Some("deepseek"),
                    "ZAIKO_LLM_MODEL" => Some("deepseek-flash"),
                    "ZAIKO_LLM_MODELS" => Some(list),
                    "DEEPSEEK_API_KEY" => Some("dummy-deepseek-key"),
                    "OPENAI_API_KEY" => Some(openai),
                    _ => None,
                }
                .map(str::to_owned)
            }
        };
        let config = parse(get(
            " gpt-6.1-sol, deepseek-flash ,,openai:o9,custom,gpt-6.1-sol ",
            "dummy-openai-key",
        ))
        .unwrap();
        let listed: Vec<_> = config
            .models
            .iter()
            .map(|c| format!("{}:{}", c.provider.name(), c.model))
            .collect();
        assert_eq!(
            listed,
            [
                "deepseek:deepseek-flash",
                "openai:gpt-6.1-sol",
                "openai:o9",
                "deepseek:custom"
            ]
        );
        let sol = config.with_choice(&config.models[1]).unwrap();
        assert_eq!(sol.api_key, "dummy-openai-key");
        assert_eq!(sol.provider.name(), "openai");
        assert_eq!(config.secrets().count(), 2);

        // An OpenAI model needs OPENAI_API_KEY; errors never echo values.
        let missing = parse(get("gpt-6.1-sol", "")).err().unwrap();
        assert!(missing.contains("OPENAI_API_KEY"));
        for list in ["bad$id", "x-dummy-openai-key", "x-dummy-deepseek-key"] {
            let error = parse(get(list, "dummy-openai-key")).err().unwrap();
            assert!(!error.contains("dummy-"));
        }
        // Without OpenAI models, the unused OpenAI key is still optional.
        assert!(parse(get("deepseek-chat", "")).unwrap().keys.is_empty());
    }

    #[test]
    fn ollama_needs_no_key_and_tagged_ids_infer_it() {
        let get = |url: &'static str| {
            move |key: &str| {
                match key {
                    "ZAIKO_LLM_PROVIDER" => Some("ollama"),
                    "ZAIKO_LLM_MODEL" => Some("qwen3:8b"),
                    "ZAIKO_LLM_MODELS" => Some("llama3.2:3b,ollama:mistral,deepseek-chat"),
                    "ZAIKO_OLLAMA_URL" => Some(url),
                    "DEEPSEEK_API_KEY" => Some("dummy-deepseek-key"),
                    _ => None,
                }
                .map(str::to_owned)
            }
        };
        let config = parse(get("")).unwrap();
        assert!(config.api_key.is_empty());
        assert_eq!(config.ollama_url, DEFAULT_OLLAMA_URL);
        assert_eq!(config.ollama_context, DEFAULT_OLLAMA_CONTEXT);
        let listed: Vec<_> = config
            .models
            .iter()
            .map(|c| format!("{}:{}", c.provider.name(), c.model))
            .collect();
        assert_eq!(
            listed,
            [
                "ollama:qwen3:8b",
                "ollama:llama3.2:3b",
                "ollama:mistral",
                "deepseek:deepseek-chat"
            ]
        );
        assert_eq!(config.key(Provider::Ollama), Some(""));
        assert_eq!(config.secrets().collect::<Vec<_>>(), ["dummy-deepseek-key"]);
        let deepseek = config.with_choice(&config.models[3]).unwrap();
        assert_eq!(deepseek.api_key, "dummy-deepseek-key");

        let remote = parse(get(" http://gpu-box:11434/ ")).unwrap();
        assert_eq!(remote.ollama_url, "http://gpu-box:11434");
        assert!(parse(get("gpu-box:11434")).is_err());

        let context = |value: &'static str| {
            let base = get("");
            parse(move |key| match key {
                "ZAIKO_OLLAMA_CONTEXT" => Some(value.to_owned()),
                _ => base(key),
            })
        };
        assert_eq!(context(" 16384 ").unwrap().ollama_context, 16384);
        for invalid in ["1024", "lots", "999999"] {
            assert!(!context(invalid).err().unwrap().contains(invalid));
        }

        // Another provider's model still needs that provider's key.
        let openai = parse(|key| {
            match key {
                "ZAIKO_LLM_PROVIDER" => Some("ollama"),
                "ZAIKO_LLM_MODEL" => Some("qwen3:8b"),
                "ZAIKO_LLM_MODELS" => Some("gpt-6.1-sol"),
                _ => None,
            }
            .map(str::to_owned)
        });
        assert!(openai.err().unwrap().contains("OPENAI_API_KEY"));
    }

    #[test]
    fn errors_never_echo_supplied_values() {
        for invalid in ["super-secret-key", "unsupported-provider"] {
            let result = parse(|_| Some(invalid.to_owned()));
            assert!(!result.err().unwrap().contains(invalid));
        }
    }
}
