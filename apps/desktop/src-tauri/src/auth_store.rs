//! Where the desktop keeps its temper credential.
//!
//! Custody is explicit and the desktop's own, in the discipline the
//! token-store seam asks of every surface: the client is built on the store
//! this module hands out, and no other surface's credential leaks in.
//! Normally the credential lives in the platform keychain, under a service
//! namespaced to the app. When `TEMPER_DESKTOP_AUTH_STORE` names a path, a
//! file-backed store is used instead — the desktop's analogue of the CLI's
//! `TEMPER_AUTH_PATH`, for development and for witnesses that must never
//! touch the person's real keychain entry.
//!
//! The file-backed arm is deliberately not `DiskTokenStore`: that store's
//! `load` prefers a `TEMPER_TOKEN` from the environment, and a developer
//! shell's env token must never hijack a desktop session or a witness. The
//! override file is the only source this store reads.
//!
//! Absence and failure stay apart: a credential that is not there reads as
//! `Ok(None)`, while a backend that could not be reached — keychain or file —
//! is an error in the client's own style. Error text interpolates `Display`
//! forms only, never `Debug`, so payload material stays out of messages the
//! way `StoredAuth`'s own `Debug` keeps it out.

use std::path::PathBuf;
use std::sync::Arc;

use temper_client::auth::{clear_auth_at, load_auth_from, save_auth_to, StoredAuth, TokenStore};
use temper_client::error::ClientError;

/// The override (`TEMPER_DESKTOP_AUTH_STORE`): when set and non-empty it
/// names the auth file the desktop's store reads and writes instead of the
/// keychain.
pub const AUTH_STORE_ENV: &str = "TEMPER_DESKTOP_AUTH_STORE";

/// The keychain service the desktop's credential lives under — namespaced to
/// the app — and the account naming the single entry: the desktop holds one
/// temper login per machine.
const KEYCHAIN_SERVICE: &str = "temper-desktop";
const KEYCHAIN_ACCOUNT: &str = "temper-api";

/// The keychain (service, account) pair naming the desktop's credential
/// entry. A pure seam so the naming is testable without touching a keychain.
pub fn keychain_names() -> (&'static str, &'static str) {
    (KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
}

/// The override file path when `TEMPER_DESKTOP_AUTH_STORE` names one.
fn override_store_path() -> Option<PathBuf> {
    std::env::var(AUTH_STORE_ENV)
        .ok()
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
}

/// The token store the desktop keeps its temper credential in: file-backed
/// under the override env, keychain-backed otherwise. The one constructor the
/// connection state builds its client on.
pub fn desktop_token_store() -> Result<Arc<dyn TokenStore>, ClientError> {
    if let Some(path) = override_store_path() {
        return Ok(Arc::new(FileTokenStore { path }));
    }
    Ok(Arc::new(KeychainTokenStore::new()?))
}

/// The desktop's keychain-backed store: one entry, `(service, account)`
/// namespaced to the app, holding the `StoredAuth` JSON the stack already
/// serializes — token strings handled only by their own serde impls.
pub struct KeychainTokenStore {
    entry: keyring::Entry,
}

impl KeychainTokenStore {
    /// The store over the app's own keychain entry.
    pub fn new() -> Result<Self, ClientError> {
        let (service, account) = keychain_names();
        Self::at(service, account)
    }

    /// The store over an explicitly named entry. The hand-run keychain
    /// witness runs under its own witness-named service, never the app's.
    fn at(service: &str, account: &str) -> Result<Self, ClientError> {
        keyring::Entry::new(service, account)
            .map_err(|err| ClientError::Other(format!("the temper keychain is unavailable: {err}")))
            .map(|entry| Self { entry })
    }
}

impl TokenStore for KeychainTokenStore {
    fn load(&self) -> Result<Option<StoredAuth>, ClientError> {
        match self.entry.get_password() {
            // No entry is an absence, not a failure — the same shape an
            // absent auth file gives the file-backed arm.
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(store_error("read", err)),
            Ok(json) => serde_json::from_str(&json).map(Some).map_err(|err| {
                ClientError::Other(format!(
                    "the temper keychain credential is unreadable: {err}"
                ))
            }),
        }
    }

    fn save(&self, auth: &StoredAuth) -> Result<(), ClientError> {
        let json = serde_json::to_string(auth).map_err(|err| {
            ClientError::Other(format!("the temper credential does not serialize: {err}"))
        })?;
        self.entry
            .set_password(&json)
            .map_err(|err| store_error("write", err))
    }

    fn clear(&self) -> Result<(), ClientError> {
        match self.entry.delete_credential() {
            Ok(()) => Ok(()),
            // Already absent — clear is idempotent, like the file arm's
            // no-op-when-absent clear.
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(err) => Err(store_error("clear", err)),
        }
    }
}

/// A keychain backend failure is a real failure, mapped into the client's
/// error style with `Display` only — the platform's message, never payload.
fn store_error(what: &'static str, err: keyring::Error) -> ClientError {
    ClientError::Other(format!("temper keychain {what} failed: {err}"))
}

/// The file-backed store behind `TEMPER_DESKTOP_AUTH_STORE`: the client
/// crate's path-parameterised helpers at an explicit path, with no env-token
/// branch — the override file is the only source this store reads.
struct FileTokenStore {
    path: PathBuf,
}

impl TokenStore for FileTokenStore {
    fn load(&self) -> Result<Option<StoredAuth>, ClientError> {
        load_auth_from(&self.path)
    }

    fn save(&self, auth: &StoredAuth) -> Result<(), ClientError> {
        save_auth_to(auth, &self.path)
    }

    fn clear(&self) -> Result<(), ClientError> {
        clear_auth_at(&self.path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    use crate::witness_env::{cleared, ScopedEnv, ENV_SERIAL};

    /// The vars whose values could contaminate a store witness: the CLI's env
    /// token and auth path, and the provider/device tags a developer shell
    /// may carry.
    const CONTAMINATING_VARS: [&str; 4] = [
        "TEMPER_TOKEN",
        "TEMPER_AUTH_PATH",
        "TEMPER_PROVIDER",
        "TEMPER_DEVICE_ID",
    ];

    fn contaminated_env_cleared() -> Vec<ScopedEnv> {
        cleared(&CONTAMINATING_VARS)
    }

    /// A valid-shaped JWT a developer shell might carry: three dot-separated
    /// segments whose payload carries the `exp` claim the env-token path
    /// parses. The shape is valid so the env branch, if one existed, would
    /// happily answer — that is what makes the bite below load-bearing.
    const ENV_TOKEN_JWT: &str = "witness-header.eyJleHAiOjQxMDI0NDQ4MDB9.witness-signature";

    /// A `StoredAuth` fixture, built through its own serde impls — token
    /// strings enter and leave as JSON, never hand-handled.
    fn stored_auth(access_token: &str) -> StoredAuth {
        serde_json::from_value(serde_json::json!({
            "provider": { "kind": "auth0", "domain": "witness.invalid" },
            "access_token": access_token,
            "refresh_token": "witness-refresh-token",
            "expires_at": "2100-01-01T00:00:00Z",
            "profile_id": null,
            "device_id": "01900000-0000-7000-8000-000000000000",
        }))
        .expect("a StoredAuth fixture")
    }

    /// The fixture compared through its own serde impls, so equality is the
    /// stored shape's equality.
    fn stored_json(auth: &StoredAuth) -> serde_json::Value {
        serde_json::to_value(auth).expect("StoredAuth serializes")
    }

    /// An override auth-file path in the machine's temp dir, unique per run —
    /// the same scratch discipline as the settings state's temp dirs.
    fn override_path() -> PathBuf {
        std::env::temp_dir().join(format!("desktop-auth-store-{}.json", uuid::Uuid::new_v4()))
    }

    /// Round-trip through the override store: an empty file holds nothing,
    /// save then load back identical, clear then absent again — with the
    /// CLI's env vars cleared for the body, so nothing but the override file
    /// can answer.
    #[test]
    fn round_trip_through_the_override_store() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _cleared = contaminated_env_cleared();
        let _override = ScopedEnv::set(AUTH_STORE_ENV, override_path().to_str().unwrap());
        let store = desktop_token_store().expect("the override env selects the file-backed store");

        assert!(
            matches!(store.load(), Ok(None)),
            "an unwritten override file holds nothing"
        );

        let fixture = stored_auth("witness-access-token");
        store
            .save(&fixture)
            .expect("save through the override store");
        let loaded = store
            .load()
            .expect("load reads the file back")
            .expect("the credential is there");
        assert_eq!(stored_json(&loaded), stored_json(&fixture));

        store.clear().expect("clear through the override store");
        assert!(
            matches!(store.load(), Ok(None)),
            "after clear the override file holds nothing"
        );
    }

    /// The bite for an env-token branch: with a valid-shaped `TEMPER_TOKEN`
    /// in the shell and the override store configured, what the store loads
    /// is what the FILE holds — nothing, before a save. This is the witness
    /// that fails if the file arm is 'simplified' into a `DiskTokenStore`,
    /// whose `load` prefers the env token.
    #[test]
    fn an_env_token_cannot_hijack_the_override_store() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let _override = ScopedEnv::set(AUTH_STORE_ENV, override_path().to_str().unwrap());
        // The shell's token is the contamination under test — it is set, not
        // cleared; the other temper vars are cleared so only it could compete.
        let _cleared = cleared(&CONTAMINATING_VARS[1..]);
        let _token = ScopedEnv::set("TEMPER_TOKEN", ENV_TOKEN_JWT);
        let store = desktop_token_store().expect("the override env selects the file-backed store");

        assert!(
            matches!(store.load(), Ok(None)),
            "the override file is the only source — a shell's TEMPER_TOKEN never answers"
        );

        let fixture = stored_auth("file-access-token");
        store
            .save(&fixture)
            .expect("save through the override store");
        let loaded = store
            .load()
            .expect("load reads the file back")
            .expect("the file's credential is there");
        assert_eq!(stored_json(&loaded), stored_json(&fixture));
        assert_ne!(
            stored_json(&loaded)["access_token"],
            ENV_TOKEN_JWT,
            "what loaded is the file's token, not the shell's"
        );
    }

    /// The override selects the file arm only when set AND non-empty; an
    /// empty value is no override. The no-override arm — the keychain — is
    /// exercised only by the hand-run witness below; the unit suite never
    /// constructs the keychain store against the real default service.
    #[test]
    fn the_override_requires_a_non_empty_value() {
        let _order = ENV_SERIAL.lock().unwrap_or_else(|e| e.into_inner());

        let _unset = ScopedEnv::removed(AUTH_STORE_ENV);
        assert_eq!(override_store_path(), None, "no override means no path");
        drop(_unset);

        let _empty = ScopedEnv::set(AUTH_STORE_ENV, "");
        assert_eq!(
            override_store_path(),
            None,
            "an empty override is no override"
        );
        drop(_empty);

        let _named = ScopedEnv::set(AUTH_STORE_ENV, "/tmp/somewhere/auth.json");
        assert_eq!(
            override_store_path(),
            Some(PathBuf::from("/tmp/somewhere/auth.json")),
            "a named path is the override"
        );
    }

    /// A corrupt override file is a failure, never an absence: a credential
    /// that cannot be parsed must not read as signed-out.
    #[test]
    fn a_corrupt_override_file_is_an_error_not_an_absence() {
        let path = override_path();
        std::fs::write(&path, "{not json").expect("write a corrupt file");
        let store = FileTokenStore { path: path.clone() };

        let loaded = store.load();
        assert!(loaded.is_err(), "corrupt is an error, got {loaded:?}");

        std::fs::remove_file(&path).ok();
    }

    /// The keychain entry the app's own store targets is namespaced to the
    /// app, with the account distinguishing the single entry. Pinned so a
    /// rename is deliberate — the entry outlives app updates.
    #[test]
    fn the_keychain_entry_is_namespaced_to_the_app() {
        let (service, account) = keychain_names();
        assert_eq!(service, "temper-desktop");
        assert_eq!(account, "temper-api");
    }

    /// A keychain backend failure maps into the client's error style as a
    /// real failure — never a silent absence.
    #[test]
    fn a_keychain_failure_is_an_error_not_an_absence() {
        let err = store_error("read", keyring::Error::NoDefaultStore);
        match err {
            ClientError::Other(message) => assert!(
                message.contains("keychain") && message.contains("read"),
                "the failure names the backend and the operation: {message}"
            ),
            other => panic!("a backend failure is a ClientError::Other, got {other:?}"),
        }
    }

    /// Witness for the keychain arm: round-trips a witness-named credential
    /// through the real keychain — save, load back identical, clear, then
    /// gone — and cleans up after itself. Ignored by default: it needs a real
    /// keychain, and it runs under its own witness-named service so the
    /// app's entry is never touched.
    /// Run locally: `cargo test -p desktop -- --ignored keychain_round_trip`
    #[test]
    #[ignore = "requires a real macOS keychain"]
    fn keychain_round_trip() {
        let service = format!("temper-desktop-witness-{}", uuid::Uuid::new_v4().simple());
        let store = KeychainTokenStore::at(&service, KEYCHAIN_ACCOUNT)
            .expect("a witness-named keychain entry handle");

        assert!(
            matches!(store.load(), Ok(None)),
            "a fresh witness name holds nothing"
        );

        let fixture = stored_auth("witness-access-token");
        store
            .save(&fixture)
            .expect("save through the real keychain");
        let loaded = store
            .load()
            .expect("load reads the keychain back")
            .expect("the credential is there");
        assert_eq!(stored_json(&loaded), stored_json(&fixture));

        store.clear().expect("clear through the real keychain");
        assert!(
            matches!(store.load(), Ok(None)),
            "after clear the witness entry is gone"
        );
    }
}
