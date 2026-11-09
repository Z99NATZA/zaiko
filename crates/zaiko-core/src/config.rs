use std::{collections::HashMap, path::Path};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    DeepSeek,
}

impl Provider {
    pub fn name(self) -> &'static str {
        match self {
            Self::OpenAi => "openai",
            Self::DeepSeek => "deepseek",
        }
    }
}

// Deliberately no Debug: configuration contains credentials.
#[derive(Clone)]
pub struct Config {
    pub provider: Provider,
    pub model: String,
    /// Models offered by the /model picker; always starts with `model`.
    pub models: Vec<String>,
    pub api_key: String,
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
    let provider = match get("ZAIKO_LLM_PROVIDER")
        .as_deref()
        .unwrap_or("openai")
        .trim()
    {
        "openai" => Provider::OpenAi,
        "deepseek" => Provider::DeepSeek,
        _ => return Err("ZAIKO_LLM_PROVIDER must be openai or deepseek.".to_owned()),
    };
    let model = get("ZAIKO_LLM_MODEL").unwrap_or_default().trim().to_owned();
    if model.is_empty() {
        return Err("ZAIKO_LLM_MODEL is required.".to_owned());
    }
    if !valid_model(&model) {
        return Err("ZAIKO_LLM_MODEL must be a valid model ID.".to_owned());
    }
    let key_name = match provider {
        Provider::OpenAi => "OPENAI_API_KEY",
        Provider::DeepSeek => "DEEPSEEK_API_KEY",
    };
    let api_key = get(key_name).unwrap_or_default().trim().to_owned();
    if api_key.is_empty() {
        return Err(format!("{key_name} is required for {}.", provider.name()));
    }
    if api_key.len() > 4096 || api_key.chars().any(char::is_control) {
        return Err(format!("{key_name} contains an invalid value."));
    }
    let mut models = vec![model.clone()];
    for item in get("ZAIKO_LLM_MODELS").unwrap_or_default().split(',') {
        let item = item.trim();
        if item.is_empty() || models.iter().any(|m| m == item) {
            continue;
        }
        // Snapshots are not redacted, so the key must never become a listed model.
        if !valid_model(item) || item.contains(&api_key) || models.len() >= 64 {
            return Err(
                "ZAIKO_LLM_MODELS must list up to 64 valid model IDs, separated by commas."
                    .to_owned(),
            );
        }
        models.push(item.to_owned());
    }
    Ok(Config {
        provider,
        model,
        models,
        api_key,
    })
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
        assert_eq!(config.models, ["deepseek-chat"]);
    }

    #[test]
    fn model_list_starts_with_the_configured_model_and_skips_duplicates() {
        let config = parse(|key| {
            match key {
                "ZAIKO_LLM_MODEL" => Some("gpt-b"),
                "ZAIKO_LLM_MODELS" => Some(" gpt-a, gpt-b ,,gpt-c,gpt-a "),
                "OPENAI_API_KEY" => Some("dummy-test-key"),
                _ => None,
            }
            .map(str::to_owned)
        })
        .unwrap();
        assert_eq!(config.models, ["gpt-b", "gpt-a", "gpt-c"]);
        for invalid in ["bad$id", "x-dummy-test-key"] {
            let result = parse(|key| {
                match key {
                    "ZAIKO_LLM_MODEL" => Some("gpt-b"),
                    "ZAIKO_LLM_MODELS" => Some(invalid),
                    "OPENAI_API_KEY" => Some("dummy-test-key"),
                    _ => None,
                }
                .map(str::to_owned)
            });
            assert!(!result.err().unwrap().contains("dummy-test-key"));
        }
    }

    #[test]
    fn errors_never_echo_supplied_values() {
        for invalid in ["super-secret-key", "unsupported-provider"] {
            let result = parse(|_| Some(invalid.to_owned()));
            assert!(!result.err().unwrap().contains(invalid));
        }
    }
}
