use std::{path::PathBuf, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use tokio::{io::AsyncReadExt, process::Command};

const OUTPUT_LIMIT: usize = 8192;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CommandRequest {
    pub command: String,
    #[serde(default)]
    pub workdir: Option<String>,
    #[serde(default)]
    pub timeout_ms: Option<u64>,
}

impl CommandRequest {
    pub fn validate(&self) -> Result<(), String> {
        if self.command.trim().is_empty()
            || self.command.len() > 8192
            || self.command.contains('\0')
        {
            return Err("command must contain 1–8192 UTF-8 bytes and no NUL bytes.".into());
        }
        if let Some(path) = &self.workdir
            && (path.len() > 4096 || path.contains('\0') || !PathBuf::from(path).is_absolute())
        {
            return Err("workdir must be an absolute directory path or null for your home.".into());
        }
        if self
            .timeout_ms
            .is_some_and(|value| !(1..=120_000).contains(&value))
        {
            return Err("timeout_ms must be between 1 and 120000, or null for 30000.".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
pub struct CommandOutput {
    pub success: bool,
    pub exit_code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub truncated: bool,
    pub workdir: String,
}

// A cancelled request drops its future. Kill the whole process group as well as
// the shell so foreground descendants cannot outlive timeout, Cancel, or Quit.
struct RunningCommand {
    child: tokio::process::Child,
    group: Option<i32>,
}

impl RunningCommand {
    fn stop(&mut self) {
        if let Some(group) = self.group.take() {
            // SAFETY: the child starts its own process group with this PID.
            unsafe { libc::kill(-group, libc::SIGKILL) };
        }
    }
}

impl Drop for RunningCommand {
    fn drop(&mut self) {
        self.stop();
        // kill_on_drop also arranges for Tokio to reap a still-running child.
    }
}

fn capture(output: &mut Vec<u8>, bytes: &[u8], truncated: &mut bool) {
    let available = OUTPUT_LIMIT - output.len();
    output.extend_from_slice(&bytes[..bytes.len().min(available)]);
    *truncated |= bytes.len() > available;
}

pub async fn run(request: CommandRequest) -> Result<CommandOutput, String> {
    request.validate()?;
    let directory = match &request.workdir {
        Some(path) => PathBuf::from(path),
        None => std::env::var_os("HOME")
            .map(PathBuf::from)
            .ok_or("Cannot locate your home; provide an absolute workdir.")?,
    };
    let directory = directory
        .canonicalize()
        .ok()
        .filter(|path| path.is_dir())
        .ok_or("workdir must be an existing accessible directory.")?;
    let child = Command::new("/bin/bash")
        .args(["--noprofile", "--norc", "-c", &request.command])
        .current_dir(&directory)
        .env_remove("OPENAI_API_KEY")
        .env_remove("DEEPSEEK_API_KEY")
        .env_remove("BASH_ENV")
        .env_remove("ENV")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0)
        .kill_on_drop(true)
        .spawn()
        .map_err(|_| "Cannot start Bash in the selected directory.".to_owned())?;
    let group = child.id().map(|id| id as i32);
    let mut running = RunningCommand { child, group };
    let mut stdout = running.child.stdout.take().expect("piped stdout");
    let mut stderr = running.child.stderr.take().expect("piped stderr");
    let mut stdout_bytes = Vec::new();
    let mut stderr_bytes = Vec::new();
    let mut stdout_buffer = [0; 4096];
    let mut stderr_buffer = [0; 4096];
    let (mut stdout_open, mut stderr_open) = (true, true);
    let (mut truncated, mut timed_out) = (false, false);
    let mut status = None;
    let deadline = tokio::time::sleep(Duration::from_millis(request.timeout_ms.unwrap_or(30_000)));
    tokio::pin!(deadline);
    while status.is_none() || stdout_open || stderr_open {
        tokio::select! {
            _ = &mut deadline => {
                timed_out = true;
                running.stop();
                if status.is_none() {
                    status = Some(running.child.wait().await.map_err(|_| "Cannot reap the command process.")?);
                }
                break;
            }
            result = running.child.wait(), if status.is_none() => {
                status = Some(result.map_err(|_| "Cannot read command exit status.")?);
            }
            result = stdout.read(&mut stdout_buffer), if stdout_open => {
                let size = result.map_err(|_| "Cannot read command stdout.")?;
                stdout_open = size != 0;
                capture(&mut stdout_bytes, &stdout_buffer[..size], &mut truncated);
            }
            result = stderr.read(&mut stderr_buffer), if stderr_open => {
                let size = result.map_err(|_| "Cannot read command stderr.")?;
                stderr_open = size != 0;
                capture(&mut stderr_bytes, &stderr_buffer[..size], &mut truncated);
            }
        }
    }
    let status = status.expect("command was reaped");
    // Normal shell completion preserves explicitly detached jobs that closed
    // their inherited pipes. They are no longer part of the active request.
    running.group = None;
    Ok(CommandOutput {
        success: status.success() && !timed_out,
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout_bytes).into_owned(),
        stderr: String::from_utf8_lossy(&stderr_bytes).into_owned(),
        timed_out,
        truncated,
        workdir: directory.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(command: &str) -> CommandRequest {
        CommandRequest {
            command: command.into(),
            workdir: Some("/tmp".into()),
            timeout_ms: Some(5000),
        }
    }

    #[tokio::test]
    async fn bash_returns_cwd_unicode_stderr_and_nonzero_exit() {
        let result = run(request("printf 'สวัสดี'; pwd >&2; exit 7"))
            .await
            .unwrap();
        assert!(!result.success);
        assert_eq!(result.exit_code, Some(7));
        assert_eq!(result.stdout, "สวัสดี");
        assert_eq!(result.stderr, "/tmp\n");
        assert!(!result.timed_out);
    }

    #[tokio::test]
    async fn excess_output_is_drained_and_bounded_without_deadlock() {
        let result = run(request(
            "head -c 100000 /dev/zero; head -c 100000 /dev/zero >&2",
        ))
        .await
        .unwrap();
        assert!(result.success);
        assert!(result.truncated);
        assert_eq!(result.stdout.len(), OUTPUT_LIMIT);
        assert_eq!(result.stderr.len(), OUTPUT_LIMIT);
    }

    #[tokio::test]
    async fn timeout_keeps_partial_output_and_stops_children() {
        let mut command = request("printf started; sleep 20");
        command.timeout_ms = Some(100);
        let result = run(command).await.unwrap();
        assert!(result.timed_out);
        assert!(!result.success);
        assert_eq!(result.stdout, "started");
    }

    #[tokio::test]
    async fn invalid_arguments_are_rejected_before_spawning() {
        for mut command in [request(""), request("echo ok")] {
            command.workdir = Some("relative/path".into());
            assert!(run(command).await.is_err());
        }
        let mut command = request("echo ok");
        command.timeout_ms = Some(120_001);
        assert!(run(command).await.is_err());
    }

    #[tokio::test]
    async fn explicitly_detached_jobs_can_survive_normal_shell_completion() {
        let result = run(request(
            "sleep 20 </dev/null >/dev/null 2>&1 & printf '%s' \"$!\"",
        ))
        .await
        .unwrap();
        let pid: i32 = result.stdout.parse().unwrap();
        // SAFETY: this PID belongs to the background process started above.
        let alive = unsafe { libc::kill(pid, 0) } == 0;
        unsafe { libc::kill(pid, libc::SIGKILL) };
        assert!(result.success);
        assert!(alive);
    }

    #[tokio::test]
    async fn dropping_the_executor_stops_the_shell_and_its_descendants() {
        let directory = std::env::temp_dir().join(format!(
            "zaiko-command-cancel-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&directory).unwrap();
        let marker = directory.join("pids");
        let task = tokio::spawn(run(request(&format!(
            "sleep 20 & printf '%s %s' \"$$\" \"$!\" > '{}'; wait",
            marker.display()
        ))));
        let pids = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                if let Ok(text) = std::fs::read_to_string(&marker) {
                    let pids: Vec<u32> = text
                        .split_whitespace()
                        .filter_map(|pid| pid.parse().ok())
                        .collect();
                    if pids.len() == 2 {
                        break pids;
                    }
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        task.abort();
        assert!(matches!(task.await, Err(error) if error.is_cancelled()));
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let running = pids.iter().any(|pid| {
                    std::fs::read_to_string(format!("/proc/{pid}/stat"))
                        .ok()
                        .and_then(|stat| {
                            stat.rsplit_once(')')
                                .map(|(_, rest)| rest.trim_start().starts_with('Z'))
                        })
                        == Some(false)
                });
                if !running {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("cancelled command descendants are still running");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
