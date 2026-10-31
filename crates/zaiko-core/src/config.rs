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
    if model.len() > 128
        || !model
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._/-:".contains(&c))
    {
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
    Ok(Config {
        provider,
        model,
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
    }

    #[test]
    fn errors_never_echo_supplied_values() {
        for invalid in ["super-secret-key", "unsupported-provider"] {
            let result = parse(|_| Some(invalid.to_owned()));
            assert!(!result.err().unwrap().contains(invalid));
        }
    }
}
