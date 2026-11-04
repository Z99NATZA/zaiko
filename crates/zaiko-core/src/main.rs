mod command;
mod config;
mod provider;
mod service;

use std::{path::PathBuf, process::ExitCode};

const USAGE: &str = "zaiko-core [--config PATH] [--check-config]\nzaiko-core --help\nzaiko-core --version\n\nRun the Zaiko session D-Bus service. Environment variables override dotenv values.";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("zaiko-core: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), String> {
    let mut path = PathBuf::from(".env");
    let mut check = false;
    let mut args = std::env::args_os().skip(1);
    while let Some(arg) = args.next() {
        if arg == "--help" || arg == "-h" {
            println!("{USAGE}");
            return Ok(());
        } else if arg == "--version" || arg == "-v" {
            println!("zaiko-core {}", env!("CARGO_PKG_VERSION"));
            return Ok(());
        } else if arg == "--config" {
            path = args
                .next()
                .map(PathBuf::from)
                .ok_or("--config needs a path.")?;
        } else if arg == "--check-config" {
            check = true;
        } else {
            return Err("Unknown argument; use --help.".to_owned());
        }
    }
    let config = config::load(&path);
    if check {
        let config = config?;
        println!(
            "Configuration valid: provider={}, model={}",
            config.provider.name(),
            config.model
        );
        return Ok(());
    }
    service::run(config).await
}
