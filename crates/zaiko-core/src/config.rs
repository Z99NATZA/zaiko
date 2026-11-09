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

    fn parse(value: &str) -> Option<Self> {
        match value {
            "openai" => Some(Self::OpenAi),
            "deepseek" => Some(Self::DeepSeek),
            _ => None,
        }
    }

    pub fn key_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OPENAI_API_KEY",
            Self::DeepSeek => "DEEPSEEK_API_KEY",
        }
    }
}

/// A model and the provider that serves it.
#[derive(Clone, PartialEq, Eq)]
pub struct ModelChoice {
    pub provider: Provider,
    pub model: String,
}

impl ModelChoice {
    /// Reads "openai:<id>" or "deepseek:<id>", or infers the provider from the
    /// ID: deepseek* is DeepSeek, gpt-* is OpenAI, anything else uses `default`.
    pub fn parse(entry: &str, default: Provider) -> Option<Self> {
        let explicit = entry
            .split_once(':')
            .and_then(|(provider, model)| Provider::parse(provider).map(|p| (p, model)));
        let (provider, model) = explicit.unwrap_or_else(|| {
            let provider = if entry.starts_with("deepseek") {
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
    /// Key for `provider`.
    pub api_key: String,
    /// Valid keys for the other providers, used by models switched to with /model.
    pub keys: Vec<(Provider, String)>,
}

impl Config {
    pub fn key(&self, provider: Provider) -> Option<&str> {
        if provider == self.provider {
            return Some(&self.api_key);
        }
        self.keys
            .iter()
            .find(|(p, _)| *p == provider)
            .map(|(_, key)| key.as_str())
    }

    pub fn secrets(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.api_key.as_str()).chain(self.keys.iter().map(|(_, key)| key.as_str()))
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
    .ok_or("ZAIKO_LLM_PROVIDER must be openai or deepseek.")?;
    let model = get("ZAIKO_LLM_MODEL").unwrap_or_default().trim().to_owned();
    if model.is_empty() {
        return Err("ZAIKO_LLM_MODEL is required.".to_owned());
    }
    if !valid_model(&model) {
        return Err("ZAIKO_LLM_MODEL must be a valid model ID.".to_owned());
    }
    // A key is only an error when a configured model needs it.
    let mut key = |provider: Provider| -> Result<Option<String>, String> {
        let name = provider.key_name();
        let value = get(name).unwrap_or_default().trim().to_owned();
        if value.is_empty() {
            return Ok(None);
        }
        if value.len() > 4096 || value.chars().any(char::is_control) {
            return Err(format!("{name} contains an invalid value."));
        }
        Ok(Some(value))
    };
    let api_key = key(provider)?.ok_or_else(|| {
        format!(
            "{} is required for {}.",
            provider.key_name(),
            provider.name()
        )
    })?;
    let other = match provider {
        Provider::OpenAi => Provider::DeepSeek,
        Provider::DeepSeek => Provider::OpenAi,
    };
    let other_key = key(other);
    let list = get("ZAIKO_LLM_MODELS").unwrap_or_default();
    let mut models = vec![ModelChoice {
        provider,
        model: model.clone(),
    }];
    for item in list
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        let secret = item.contains(&api_key)
            || other_key
                .as_ref()
                .is_ok_and(|key| key.as_ref().is_some_and(|key| item.contains(key)));
        // Snapshots are not redacted, so a key must never become a listed model.
        let Some(choice) = ModelChoice::parse(item, provider).filter(|_| !secret) else {
            return Err(
                "ZAIKO_LLM_MODELS must list up to 64 valid model IDs, separated by commas."
                    .to_owned(),
            );
        };
        if models.contains(&choice) {
            continue;
        }
        if models.len() >= 64 {
            return Err(
                "ZAIKO_LLM_MODELS must list up to 64 valid model IDs, separated by commas."
                    .to_owned(),
            );
        }
        if choice.provider == other {
            match &other_key {
                Ok(Some(_)) => {}
                Ok(None) => {
                    return Err(format!(
                        "{} is required for {} models in ZAIKO_LLM_MODELS.",
                        other.key_name(),
                        other.name()
                    ));
                }
                Err(error) => return Err(error.clone()),
            }
        }
        models.push(choice);
    }
    let keys = match other_key {
        Ok(Some(key)) => vec![(other, key)],
        _ => Vec::new(),
    };
    Ok(Config {
        provider,
        model,
        models,
        api_key,
        keys,
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
    fn errors_never_echo_supplied_values() {
        for invalid in ["super-secret-key", "unsupported-provider"] {
            let result = parse(|_| Some(invalid.to_owned()));
            assert!(!result.err().unwrap().contains(invalid));
        }
    }
}
