//! The hub writer: the rooms a person leaves, queued on this device and
//! committed to the hub in coalesced batches. The surface reports each
//! leave with `hub_note_left`, which does no network I/O; the core keeps
//! the queue in memory and in an app-data file beside the device store,
//! commits it after a quiet window (or at once when it grows), and tries
//! once more at exit. Whatever does not land stays queued and is committed
//! at the next launch, so an offline desktop records nothing to temper,
//! crashes on nothing, and loses nothing.

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::hub::{commit_recent_work, RecentWorkEntry};
use crate::settings::SettingsState;
use crate::temper::TemperState;

const FILE_NAME: &str = "hub-queue.json";

/// How long the queue waits for quiet before committing: a person walking
/// through several rooms makes one commit, not one per room.
pub const QUIET_WINDOW: Duration = Duration::from_secs(30);

/// A queue this long commits without waiting for quiet.
pub const BATCH_TRIGGER: usize = 10;

/// A room left sooner than this was passed through, not worked in. A
/// threshold, not a truth: it keeps a walk along a trail from crowding out
/// where the person actually was.
pub const MIN_DWELL: Duration = Duration::from_secs(10);

/// How long exit waits on the last commit before leaving the rest queued.
pub const EXIT_FLUSH: Duration = Duration::from_secs(2);

/// A room left, as the surface watched it. The device is not the surface's
/// to say: the core fills it from the device store.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Leave {
    pub resource: String,
    /// The lens the room was seen through, as the registry names it.
    pub room: String,
    /// RFC 3339.
    pub opened_at: String,
    /// RFC 3339.
    pub left_at: String,
}

/// The entry a leave becomes, or why it is not one.
pub fn entry_for(leave: Leave, device: &str) -> Result<RecentWorkEntry, String> {
    let resource = Uuid::parse_str(leave.resource.trim())
        .map_err(|_| format!("{} is not a resource id", leave.resource))?
        .to_string();
    let room = leave.room.trim().to_string();
    if room.is_empty() {
        return Err("a leave names the lens it was seen through".to_string());
    }
    let parse = |at: &str| {
        chrono::DateTime::parse_from_rfc3339(at).map_err(|e| format!("{at} is not RFC 3339: {e}"))
    };
    let opened = parse(&leave.opened_at)?;
    let left = parse(&leave.left_at)?;
    let dwell = left.signed_duration_since(opened);
    if dwell < chrono::Duration::from_std(MIN_DWELL).expect("a small duration") {
        return Err(format!(
            "{}s in the room is passing through, not a place of work",
            dwell.num_seconds()
        ));
    }
    Ok(RecentWorkEntry {
        resource,
        room,
        opened_at: leave.opened_at,
        left_at: leave.left_at,
        device: device.to_string(),
    })
}

/// The queue: entries not yet committed, in the order they were left.
pub struct HubQueue {
    path: PathBuf,
    entries: Mutex<Vec<RecentWorkEntry>>,
    /// One commit at a time; a second flush while one is in flight is a no-op.
    flushing: tokio::sync::Mutex<()>,
    /// Bumped on every note, so a quiet-window timer knows whether it is
    /// still the latest.
    generation: AtomicU64,
}

impl HubQueue {
    /// Loads the queue. A missing or malformed file is an empty queue.
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join(FILE_NAME);
        let entries = fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        Self {
            path,
            entries: Mutex::new(entries),
            flushing: tokio::sync::Mutex::new(()),
            generation: AtomicU64::new(0),
        }
    }

    /// What is queued, oldest first.
    pub fn queued(&self) -> Vec<RecentWorkEntry> {
        self.entries.lock().expect("queue lock").clone()
    }

    /// Queues an entry and answers the queue's length and this note's
    /// generation. The file write is best-effort: a queue that cannot be
    /// saved still commits from memory.
    pub fn note(&self, entry: RecentWorkEntry) -> (usize, u64) {
        let mut entries = self.entries.lock().expect("queue lock");
        entries.push(entry);
        let _ = Self::write(&self.path, &entries);
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        (entries.len(), generation)
    }

    /// Whether no note has arrived since the one that answered `generation`.
    pub fn is_latest(&self, generation: u64) -> bool {
        self.generation.load(Ordering::SeqCst) == generation
    }

    /// Takes the committed entries out of the queue. Entries queued while
    /// the commit was in flight stay.
    pub fn settle(&self, committed: &[RecentWorkEntry]) {
        let mut entries = self.entries.lock().expect("queue lock");
        for done in committed {
            if let Some(i) = entries.iter().position(|e| e == done) {
                entries.remove(i);
            }
        }
        let _ = Self::write(&self.path, &entries);
    }

    fn write(path: &PathBuf, entries: &[RecentWorkEntry]) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let tmp = path.with_extension("json.tmp");
        let raw = serde_json::to_string(entries).map_err(|e| e.to_string())?;
        fs::write(&tmp, raw).map_err(|e| e.to_string())?;
        fs::rename(&tmp, path).map_err(|e| e.to_string())
    }
}

/// Commits whatever is queued. Answers how many entries landed; `Ok(0)`
/// when there was nothing to commit or a commit was already in flight.
/// A failure leaves every entry queued for the next attempt.
pub async fn flush(app: &AppHandle) -> Result<usize, String> {
    let queue = app.state::<HubQueue>();
    let Ok(_guard) = queue.flushing.try_lock() else {
        return Ok(0);
    };
    let batch = queue.queued();
    if batch.is_empty() {
        return Ok(0);
    }
    let temper = app.state::<TemperState>();
    let client = temper
        .client()
        .ok_or_else(|| "temper is not connected".to_string())?;
    let context_name = app
        .state::<SettingsState>()
        .get()
        .temper_context_name()
        .to_string();
    commit_recent_work(&client, &context_name, batch.clone()).await?;
    queue.settle(&batch);
    Ok(batch.len())
}

/// Commits after the quiet window, unless another note arrived meanwhile —
/// that note's own timer commits instead.
fn commit_when_quiet(app: AppHandle, generation: u64) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(QUIET_WINDOW).await;
        if app.state::<HubQueue>().is_latest(generation) {
            let _ = flush(&app).await;
        }
    });
}

/// Commits now, in the background.
pub fn commit_soon(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let _ = flush(&app).await;
    });
}

/// At exit: one bounded attempt. What does not land stays in the file.
pub fn flush_at_exit(app: &AppHandle) {
    let app = app.clone();
    let _ = tauri::async_runtime::block_on(async move {
        tokio::time::timeout(EXIT_FLUSH, flush(&app)).await
    });
}

/// A room left. Queued here and committed later — never a network call on
/// the surface's move. A leave that is not a place of work is refused with
/// the reason, and the surface ignores it.
#[tauri::command]
pub fn hub_note_left(
    app: AppHandle,
    queue: tauri::State<'_, HubQueue>,
    settings: tauri::State<'_, SettingsState>,
    leave: Leave,
) -> Result<(), String> {
    let entry = entry_for(leave, &settings.device_label())?;
    let (len, generation) = queue.note(entry);
    if len >= BATCH_TRIGGER {
        commit_soon(app);
    } else {
        commit_when_quiet(app, generation);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desktop-hub-queue-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    const A: &str = "01a0e020-a6d7-7420-b924-000000000001";

    fn leave(opened: &str, left: &str) -> Leave {
        Leave {
            resource: A.to_string(),
            room: "core/document".to_string(),
            opened_at: opened.to_string(),
            left_at: left.to_string(),
        }
    }

    fn entry(left: &str) -> RecentWorkEntry {
        entry_for(leave("2026-09-28T10:00:00.000Z", left), "station").expect("an entry")
    }

    #[test]
    fn a_leave_becomes_an_entry_with_this_devices_label() {
        let made = entry("2026-09-28T10:05:00.000Z");
        assert_eq!(made.resource, A);
        assert_eq!(made.room, "core/document");
        assert_eq!(made.device, "station");
    }

    /// Passing through is not a place of work.
    #[test]
    fn a_leave_under_the_dwell_is_refused_with_why() {
        let err = entry_for(
            leave("2026-09-28T10:00:00.000Z", "2026-09-28T10:00:04.000Z"),
            "station",
        )
        .expect_err("four seconds is passing through");
        assert!(err.contains("passing through"), "{err}");
        assert!(entry_for(
            leave("2026-09-28T10:00:00.000Z", "2026-09-28T10:00:10.000Z"),
            "station"
        )
        .is_ok());
    }

    #[test]
    fn a_leave_that_names_no_resource_is_refused() {
        let mut bad = leave("2026-09-28T10:00:00.000Z", "2026-09-28T10:05:00.000Z");
        bad.resource = "not-a-uuid".to_string();
        assert!(entry_for(bad, "station").is_err());
        let mut bad = leave("2026-09-28T10:00:00.000Z", "2026-09-28T10:05:00.000Z");
        bad.opened_at = "yesterday".to_string();
        assert!(entry_for(bad, "station").is_err());
    }

    /// Notes coalesce: each is queued, and only the latest note's timer
    /// commits.
    #[test]
    fn notes_coalesce_and_only_the_latest_timer_commits() {
        let queue = HubQueue::load(temp_dir());
        let (len, first) = queue.note(entry("2026-09-28T10:05:00.000Z"));
        assert_eq!(len, 1);
        let (len, second) = queue.note(entry("2026-09-28T10:06:00.000Z"));
        assert_eq!(len, 2);
        assert!(!queue.is_latest(first), "a later note supersedes the timer");
        assert!(queue.is_latest(second));
    }

    #[test]
    fn the_batch_trigger_is_reached_by_notes_alone() {
        let queue = HubQueue::load(temp_dir());
        let mut len = 0;
        for minute in 0..BATCH_TRIGGER {
            len = queue
                .note(entry(&format!("2026-09-28T10:{:02}:30.000Z", minute + 1)))
                .0;
        }
        assert_eq!(len, BATCH_TRIGGER);
    }

    /// A committed batch leaves the queue; what arrived during the commit
    /// stays. A failed commit settles nothing, so every entry stays.
    #[test]
    fn settling_keeps_what_arrived_during_the_commit() {
        let queue = HubQueue::load(temp_dir());
        queue.note(entry("2026-09-28T10:05:00.000Z"));
        let batch = queue.queued();
        queue.note(entry("2026-09-28T10:07:00.000Z"));
        queue.settle(&batch);
        let left = queue.queued();
        assert_eq!(left.len(), 1);
        assert_eq!(left[0].left_at, "2026-09-28T10:07:00.000Z");
    }

    /// The queue survives a restart: what was not committed is committed at
    /// the next launch.
    #[test]
    fn the_queue_reloads_from_its_file() {
        let dir = temp_dir();
        {
            let queue = HubQueue::load(dir.clone());
            queue.note(entry("2026-09-28T10:05:00.000Z"));
            queue.note(entry("2026-09-28T10:07:00.000Z"));
        }
        let reloaded = HubQueue::load(dir.clone());
        assert_eq!(reloaded.queued().len(), 2);
        reloaded.settle(&reloaded.queued());
        assert!(HubQueue::load(dir).queued().is_empty());
    }

    #[test]
    fn a_malformed_file_is_an_empty_queue() {
        let dir = temp_dir();
        fs::write(dir.join(FILE_NAME), "not json").expect("write");
        assert!(HubQueue::load(dir).queued().is_empty());
    }
}
