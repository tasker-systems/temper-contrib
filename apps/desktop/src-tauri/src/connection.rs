//! The temper connection's setup and edit: the desktop's `temper init`
//! equivalent.
//!
//! `temper init` splits into `gather_answers` (interactive) and
//! `apply_answers` (pure config work); the desktop mirrors the pure half.
//! The room renders the same three-way choice the wizard's instance selector
//! asks — hosted (temperkb.io), self-hosted (own instance + Auth0/Okta
//! tenant), or temper-as (the instance's own Authorization Server) — and
//! this module derives the exact provider entry `init` would write.
//!
//! The write scopes by existence. On a config that exists the merge is
//! scoped to `[auth]`: `toml_edit` keeps every byte outside the section —
//! comments, foreign sections, formatting — exactly as the file carries it,
//! and the desktop never writes `auth.path`, the vault, or any CLI-owned
//! section. Where no config exists the desktop establishes the whole file
//! at `temper init` parity: the vault path the room chose (init's default
//! when blank), the vault root and its `.temper/` state dir, and the
//! `[vault]` + `[cloud]` + `[auth]` render `render_config_toml` produces
//! (`init.rs:653-705`), mirrored with parity witnesses because the CLI
//! crate is not a desktop dependency.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use temper_client::config::{api_url, load_cloud_config_from};
use temper_core::types::config::{global_config_path, AuthProvider};

/// The temperkb.io hosted preset, as the desktop's own constants module.
///
/// The mirrored values originate in `temper init`'s hosted constants
/// (`init.rs:27-30`) — the same deployment, restated here because the CLI
/// crate is not a desktop dependency.
pub mod hosted_preset {
    /// The hosted instance's API base.
    pub const API_URL: &str = "https://temperkb.io";
    /// The hosted Auth0 tenant domain.
    pub const AUTH_DOMAIN: &str = "temperkb.us.auth0.com";
    /// The CLI's hosted OAuth client id — the provider entry's `client_id`,
    /// which `temper auth login` authenticates with. The desktop's own id is
    /// a separate registration ([`DESKTOP_CLIENT_ID`]).
    pub const CLIENT_ID: &str = "mWp8znLw2MUJNCiZNl8wwBv6SPJI2mfF";
    /// The hosted API audience.
    pub const AUDIENCE: &str = "https://temperkb.io/api";
    /// The temperkb.io Auth0 application for the desktop itself — the
    /// desktop's own registration, minted beside the CLI's (`init.rs:29`,
    /// the mirror origin of every constant here). A public client id,
    /// repo-safe. Hosted sign-in authenticates with this id, never with
    /// [`CLIENT_ID`], whose registered redirect belongs to the CLI.
    pub const DESKTOP_CLIENT_ID: Option<&str> = Some("v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE");
}

/// The desktop's public client on a temper Authorization Server — the name
/// the instance registers in `AS_CLIENTS`, parallel to the CLI's
/// `temper-cli`.
pub const TEMPER_AS_DESKTOP_CLIENT: &str = "temper-desktop";

/// The OIDC scope set Auth0/Okta provider entries carry, as `init` writes it.
const AUTH0_SCOPES: [&str; 4] = ["openid", "profile", "email", "offline_access"];
/// The scope set a temper Authorization Server honors, as `init` writes it.
const TEMPER_AS_SCOPES: [&str; 2] = ["openid", "offline_access"];

/// Which URL template a provider entry's endpoints follow — the desktop's
/// mirror of `temper init`'s `Idp`. Auth0/Okta live on a separate auth
/// domain; TemperAs lives on the instance itself.
#[derive(Debug, Clone, PartialEq, Eq)]
enum UrlShape {
    Auth0,
    Okta { auth_server_id: String },
    TemperAs,
}

impl UrlShape {
    /// The `(authorize_url, token_url)` pair for a base — the auth domain
    /// for Auth0/Okta, the instance base URL (scheme-qualified) for
    /// TemperAs. The same templates `init`'s `provider_urls` writes.
    fn endpoints(&self, base: &str) -> (String, String) {
        match self {
            UrlShape::Auth0 => (
                format!("https://{base}/authorize"),
                format!("https://{base}/oauth/token"),
            ),
            UrlShape::Okta { auth_server_id } => (
                format!("https://{base}/oauth2/{auth_server_id}/v1/authorize"),
                format!("https://{base}/oauth2/{auth_server_id}/v1/token"),
            ),
            UrlShape::TemperAs => (
                format!("{base}/oauth/authorize"),
                format!("{base}/oauth/token"),
            ),
        }
    }

    /// The provider label and scope set the entry carries — the same split
    /// `init` writes: TemperAs is its own provider and asks only for the
    /// scopes it honors.
    fn label_and_scopes(&self) -> (&'static str, &'static [&'static str]) {
        match self {
            UrlShape::TemperAs => ("temper-as", &TEMPER_AS_SCOPES),
            UrlShape::Auth0 | UrlShape::Okta { .. } => ("auth0", &AUTH0_SCOPES),
        }
    }
}

/// The IdP a self-hosted instance authenticates against — Auth0 or an Okta
/// custom authorization server. (A temper Authorization Server is its own
/// connection choice, [`ConnectionChoice::TemperAs`], not a self-hosted IdP.)
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SelfHostIdp {
    Auth0,
    Okta { auth_server_id: String },
}

/// The per-instance OAuth inputs of a self-hosted deployment — the quad the
/// wizard's self-hosted branch asks for, mirroring `init`'s `SelfHostConfig`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SelfHosted {
    /// Instance base URL, e.g. `https://temper.acme.com`.
    pub instance_url: String,
    /// OAuth provider domain — `acme.us.auth0.com` or `acme.okta.com`.
    pub auth_domain: String,
    /// The deployment's CLI OAuth client id (the provider entry's
    /// `client_id`); the desktop's own id rides `desktop_client_id`.
    pub client_id: String,
    /// API audience, e.g. `https://temper.acme.com/api`.
    pub audience: String,
    pub idp: SelfHostIdp,
}

/// The connection choice the room renders — the same three-way choice the
/// wizard's instance selector asks, flattened to one arm each.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConnectionChoice {
    /// temperkb.io hosted preset.
    Hosted,
    /// A self-hosted instance with its own Auth0/Okta tenant.
    SelfHosted(SelfHosted),
    /// A native-SAML instance's own Authorization Server: everything derives
    /// from the instance base URL alone.
    TemperAs {
        /// Instance base URL, scheme-qualified, no trailing slash.
        instance_url: String,
    },
}

/// Refuse an instance URL the client would refuse at every later command —
/// the same rule `temper init` applies when the value is chosen
/// (`init.rs` `validate_instance_url`, delegating to
/// `temper_client::endpoint::validate_endpoint`).
fn validate_instance_url(url: &str) -> Result<(), String> {
    temper_client::endpoint::validate_endpoint(url, "instance_url").map_err(|e| e.to_string())
}

/// Trim the instance URL the way the wizard's prompts do: surrounding
/// whitespace and trailing slashes off before validation.
fn normalized_instance_url(raw: &str) -> String {
    raw.trim().trim_end_matches('/').to_string()
}

/// Derive the provider entry `temper init` would write for this choice —
/// the same derivation `apply_answers`' config half performs, plus the
/// desktop's own client id when the deployment registered one.
///
/// Hosted fills domain/audience/api-url from the preset and carries the
/// desktop's own registration ([`hosted_preset::DESKTOP_CLIENT_ID`]).
/// Self-hosted leaves the field unset — the deployment registers the desktop
/// application itself, and [`sign_in_refusal`] names it until then.
/// Temper-as derives everything from the instance URL alone, including the
/// fixed [`TEMPER_AS_DESKTOP_CLIENT`] public client.
pub fn derive_provider(choice: &ConnectionChoice) -> Result<AuthProvider, String> {
    match choice {
        ConnectionChoice::Hosted => {
            let (authorize_url, token_url) = UrlShape::Auth0.endpoints(hosted_preset::AUTH_DOMAIN);
            Ok(AuthProvider {
                name: "auth0".to_string(),
                authorize_url,
                token_url,
                client_id: hosted_preset::CLIENT_ID.to_string(),
                audience: hosted_preset::AUDIENCE.to_string(),
                callback_url: format!("{}/api/auth/cli-callback", hosted_preset::API_URL),
                scopes: AUTH0_SCOPES.iter().map(|s| s.to_string()).collect(),
                desktop_client_id: hosted_preset::DESKTOP_CLIENT_ID.map(str::to_string),
            })
        }
        ConnectionChoice::SelfHosted(sh) => {
            let instance_url = normalized_instance_url(&sh.instance_url);
            validate_instance_url(&instance_url)?;
            let shape = match &sh.idp {
                SelfHostIdp::Auth0 => UrlShape::Auth0,
                SelfHostIdp::Okta { auth_server_id } => UrlShape::Okta {
                    auth_server_id: auth_server_id.clone(),
                },
            };
            let (authorize_url, token_url) = shape.endpoints(&sh.auth_domain);
            let (name, scopes) = shape.label_and_scopes();
            Ok(AuthProvider {
                name: name.to_string(),
                authorize_url,
                token_url,
                client_id: sh.client_id.clone(),
                audience: sh.audience.clone(),
                callback_url: format!("{instance_url}/api/auth/cli-callback"),
                scopes: scopes.iter().map(|s| s.to_string()).collect(),
                desktop_client_id: None,
            })
        }
        ConnectionChoice::TemperAs { instance_url } => {
            let instance_url = normalized_instance_url(instance_url);
            validate_instance_url(&instance_url)?;
            let (authorize_url, token_url) = UrlShape::TemperAs.endpoints(&instance_url);
            Ok(AuthProvider {
                name: "temper-as".to_string(),
                authorize_url,
                token_url,
                client_id: "temper-cli".to_string(),
                audience: format!("{instance_url}/api"),
                callback_url: format!("{instance_url}/api/auth/cli-callback"),
                scopes: TEMPER_AS_SCOPES.iter().map(|s| s.to_string()).collect(),
                desktop_client_id: Some(TEMPER_AS_DESKTOP_CLIENT.to_string()),
            })
        }
    }
}

/// The one-line reason a connection sign-in is refused, when it is: the
/// active provider entry carries no registration of the desktop's own OAuth
/// client. There is no fallback to `client_id` — that client's registered
/// redirect belongs to the CLI, which this app does not share.
pub fn sign_in_refusal(provider: &AuthProvider) -> Option<String> {
    let registered = provider
        .desktop_client_id
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty());
    if registered.is_some() {
        return None;
    }
    if provider.name == "temper-as" {
        // The instance is the AS: its audience is `{instance}/api`, and the
        // unregistered client has a name — the fixed desktop public client.
        let instance = provider
            .audience
            .strip_suffix("/api")
            .unwrap_or(&provider.audience);
        return Some(format!(
            "no desktop client is registered for {instance} — add the public client \
             \"{TEMPER_AS_DESKTOP_CLIENT}\" to the deployment's AS_CLIENTS"
        ));
    }
    // Auth0/Okta: name the tenant and the field the registration belongs in.
    let domain = authorize_domain(provider);
    Some(format!(
        "no desktop client is registered for {domain} — set desktop_client_id on the \
         \"{}\" provider entry to the temper desktop application's client id",
        provider.name
    ))
}

/// The auth domain an Auth0/Okta entry's endpoints live on, read out of the
/// authorize URL (`https://{domain}/...`).
fn authorize_domain(provider: &AuthProvider) -> &str {
    provider
        .authorize_url
        .strip_prefix("https://")
        .and_then(|rest| rest.split('/').next())
        .unwrap_or(&provider.authorize_url)
}

/// Where a fresh machine's vault lives — `init.rs:140-147`'s
/// `default_vault_path`, mirrored: the home-relative default, or
/// `./temper-vault` when home is unresolvable.
fn default_vault_path() -> String {
    dirs::home_dir()
        .map(|h| {
            h.join("Documents/temper-vault")
                .to_string_lossy()
                .to_string()
        })
        .unwrap_or_else(|| "./temper-vault".to_string())
}

/// The `[cloud] api_url` a choice's establish writes — the same value
/// `render_config_toml` passes its cloud section: the preset's for hosted,
/// the instance base URL otherwise.
fn cloud_api_url(choice: &ConnectionChoice) -> String {
    match choice {
        ConnectionChoice::Hosted => hosted_preset::API_URL.to_string(),
        ConnectionChoice::SelfHosted(sh) => normalized_instance_url(&sh.instance_url),
        ConnectionChoice::TemperAs { instance_url } => normalized_instance_url(instance_url),
    }
}

/// The whole-file render a fresh machine's establish writes — `[vault]`,
/// `[cloud] api_url`, and `[auth]` with the derived provider entry, the same
/// shapes `render_config_toml` emits (`init.rs:653-705`). Every interpolated
/// value routes through `toml::Value::String` the way init routes its own,
/// so characters requiring escaping round-trip through `TemperConfig`.
fn render_establish_config(vault_path: &str, api_url: &str, provider: &AuthProvider) -> String {
    let tv = |s: &str| toml::Value::String(s.to_string()).to_string();
    let mut scopes = toml_edit::Array::new();
    for scope in &provider.scopes {
        scopes.push(scope.as_str());
    }
    // Absent stays absent, the way `skip_serializing_if` would leave it.
    let desktop_line = provider
        .desktop_client_id
        .as_deref()
        .map(|id| format!("desktop_client_id = {}\n", tv(id)))
        .unwrap_or_default();
    format!(
        "[vault]\npath = {vault}\n\n\
         [cloud]\napi_url = {api}\n\n\
         [auth]\nprovider = {name}\n\n\
         [[auth.providers]]\n\
         name = {name}\n\
         authorize_url = {authorize}\n\
         token_url = {token}\n\
         client_id = {client}\n\
         audience = {audience}\n\
         callback_url = {callback}\n\
         scopes = {scopes}\n\
         {desktop_line}",
        vault = tv(vault_path),
        api = tv(api_url),
        name = tv(&provider.name),
        authorize = tv(&provider.authorize_url),
        token = tv(&provider.token_url),
        client = tv(&provider.client_id),
        audience = tv(&provider.audience),
        callback = tv(&provider.callback_url),
        scopes = scopes,
        desktop_line = desktop_line,
    )
}

/// Establish the whole config a fresh machine needs: the vault root and its
/// `.temper/` state dir created exactly where init's `apply_answers` creates
/// them (`init.rs:483, 489-491`), then the config written at `temper init`
/// parity ([`render_establish_config`]). The vault path is the room's choice,
/// init's default when it left it blank. Returns the vault path as written.
pub fn establish_at_path(
    path: &Path,
    choice: &ConnectionChoice,
    vault_path: &str,
) -> Result<String, String> {
    let provider = derive_provider(choice)?;
    let api_url = cloud_api_url(choice);

    let vault = PathBuf::from(vault_path);
    std::fs::create_dir_all(&vault)
        .map_err(|e| format!("cannot create vault {}: {e}", vault.display()))?;
    std::fs::create_dir_all(vault.join(".temper"))
        .map_err(|e| format!("cannot create {}: {e}", vault.join(".temper").display()))?;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(
        path,
        render_establish_config(vault_path, &api_url, &provider),
    )
    .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(vault_path.to_string())
}

/// Apply the choice to the config file at `path`. The write scopes by
/// existence: on a config that exists, derive the provider entry (instance
/// URL validated, the same rule `init` applies) and merge it into `[auth]`
/// through `toml_edit`, preserving every byte outside the section — the
/// desktop never writes `auth.path`, the vault, or any CLI-owned section,
/// and an `[auth]` key it does not own (such as a hand-set `path`) is left
/// exactly as the file carries it. Where no config exists, the desktop
/// establishes the whole file at `temper init` parity with the default vault
/// path ([`establish_at_path`] takes the room's choice).
///
/// Returns the entry as written.
pub fn apply_to_path(path: &Path, choice: &ConnectionChoice) -> Result<AuthProvider, String> {
    if !path.exists() {
        establish_at_path(path, choice, &default_vault_path())?;
        return derive_provider(choice);
    }
    let provider = derive_provider(choice)?;
    let raw = std::fs::read_to_string(path)
        .map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let mut doc = raw
        .parse::<toml_edit::DocumentMut>()
        .map_err(|e| format!("{} is not readable TOML: {e}", path.display()))?;

    let auth_item = match doc.entry("auth") {
        toml_edit::Entry::Vacant(slot) => slot.insert(toml_edit::table()),
        toml_edit::Entry::Occupied(occupied) => occupied.into_mut(),
    };
    let auth = auth_item.as_table_like_mut().ok_or_else(|| {
        // A corrupt config is the person's to fix by hand, not one the
        // desktop may clobber.
        format!(
            "[auth] in {} is not a table — fix the config by hand",
            path.display()
        )
    })?;

    auth.insert("provider", toml_edit::value(provider.name.as_str()));

    let mut entry = toml_edit::Table::new();
    entry.insert("name", toml_edit::value(provider.name.as_str()));
    entry.insert(
        "authorize_url",
        toml_edit::value(provider.authorize_url.as_str()),
    );
    entry.insert("token_url", toml_edit::value(provider.token_url.as_str()));
    entry.insert("client_id", toml_edit::value(provider.client_id.as_str()));
    entry.insert("audience", toml_edit::value(provider.audience.as_str()));
    entry.insert(
        "callback_url",
        toml_edit::value(provider.callback_url.as_str()),
    );
    let mut scopes = toml_edit::Array::new();
    for scope in &provider.scopes {
        scopes.push(scope.as_str());
    }
    entry.insert("scopes", toml_edit::value(scopes));
    // Absent stays absent, the way `skip_serializing_if` would leave it.
    if let Some(id) = &provider.desktop_client_id {
        entry.insert("desktop_client_id", toml_edit::value(id.as_str()));
    }
    let mut providers = toml_edit::ArrayOfTables::new();
    providers.push(entry);
    auth.insert("providers", toml_edit::Item::ArrayOfTables(providers));

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    std::fs::write(path, doc.to_string())
        .map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    Ok(provider)
}

/// One provider entry, as the config file carries it — the room's read-back
/// of what resolves.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderView {
    pub name: String,
    pub authorize_url: String,
    pub token_url: String,
    pub client_id: String,
    pub audience: String,
    pub callback_url: String,
    pub scopes: Vec<String>,
    /// The deployment's registration of the desktop's own OAuth client;
    /// absent is the unregistered state [`ConnectionGather::sign_in_refusal`]
    /// names.
    pub desktop_client_id: Option<String>,
}

impl ProviderView {
    fn of(entry: &AuthProvider) -> Self {
        Self {
            name: entry.name.clone(),
            authorize_url: entry.authorize_url.clone(),
            token_url: entry.token_url.clone(),
            client_id: entry.client_id.clone(),
            audience: entry.audience.clone(),
            callback_url: entry.callback_url.clone(),
            scopes: entry.scopes.clone(),
            desktop_client_id: entry.desktop_client_id.clone(),
        }
    }
}

/// The connection's current state, as the machine's config resolves it —
/// the room's answer to "what do I have, and what's missing".
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionGather {
    /// Whether the machine carries a config file at all — the fresh-machine
    /// state the room offers the choice in.
    pub config_exists: bool,
    /// Where a fresh machine's vault would live — init's default, shown so
    /// the room can offer it editable. None once a config exists: the
    /// establish arm is the only user, and an existing config's vault is
    /// the person's own.
    pub default_vault_path: Option<String>,
    /// What resolves: `"hosted"`, `"self-hosted"`, or `"temper-as"`. None
    /// when nothing resolves — no config, `provider = "none"`, or an active
    /// entry outside the written shapes.
    pub choice: Option<String>,
    /// The active provider entry, as the config carries it.
    pub provider: Option<ProviderView>,
    /// The server URL the config resolves to — what
    /// `temper_connection_status` reports as `server_url`.
    pub api_url: Option<String>,
    /// The one-line reason connection sign-in is refused, when it is.
    pub sign_in_refusal: Option<String>,
}

/// What the config at `path` resolves to: the active provider entry,
/// classified into the choice vocabulary, with the sign-in refusal when the
/// desktop's own client is unregistered.
pub fn gather_from_path(path: &Path) -> Result<ConnectionGather, String> {
    let config_exists = path.exists();
    let cfg = load_cloud_config_from(path).map_err(|e| e.to_string())?;
    let api_url = api_url(&cfg);
    let api_url = (!api_url.trim().is_empty()).then_some(api_url);

    // The same resolution rule the client's own oauth_config uses: the
    // entry the `auth.provider` name picks.
    let entry = cfg
        .auth
        .providers
        .iter()
        .find(|p| p.name == cfg.auth.provider);

    let (choice, sign_in_refusal, provider) = match entry {
        None => (None, None, None),
        Some(entry) => (
            classify(entry).map(str::to_string),
            sign_in_refusal(entry),
            Some(ProviderView::of(entry)),
        ),
    };

    Ok(ConnectionGather {
        config_exists,
        default_vault_path: (!config_exists).then(default_vault_path),
        choice,
        provider,
        api_url,
        sign_in_refusal,
    })
}

/// Which choice vocabulary name an active provider entry reads as, if any.
/// Hosted is the exact hosted preset shape; `temper-as` names itself; any
/// other `auth0`-labeled entry is self-hosted. An entry outside the written
/// shapes has no choice name — the provider itself still resolves.
fn classify(entry: &AuthProvider) -> Option<&'static str> {
    let hosted = entry.audience == hosted_preset::AUDIENCE
        && entry.authorize_url == format!("https://{}/authorize", hosted_preset::AUTH_DOMAIN);
    if hosted {
        Some("hosted")
    } else if entry.name == "temper-as" {
        Some("temper-as")
    } else if entry.name == "auth0" {
        Some("self-hosted")
    } else {
        None
    }
}

/// The connection the room asks to apply, as the command reads it off the
/// wire — the optional-quads shape `init`'s `self_host_from_flags` parses.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionApplyRequest {
    /// `"hosted"`, `"self-hosted"`, or `"temper-as"`.
    pub choice: String,
    /// Instance base URL — required for `self-hosted` and `temper-as`.
    pub instance_url: Option<String>,
    /// OAuth provider domain — required for `self-hosted`.
    pub auth_domain: Option<String>,
    /// The deployment's CLI OAuth client id — required for `self-hosted`.
    pub client_id: Option<String>,
    /// API audience — required for `self-hosted`.
    pub audience: Option<String>,
    /// `"auth0"` (default) or `"okta"`.
    pub idp: Option<String>,
    /// Okta authorization server id — required when `idp` is `"okta"`.
    pub auth_server_id: Option<String>,
    /// Where a fresh machine's vault lives. Used only by the establish arm
    /// (a machine with no config); an existing config's apply never reads
    /// it. Blank or absent is init's default.
    pub vault_path: Option<String>,
}

/// The trimmed value of a quad field the missing-check already vetted.
fn trimmed_field(value: &Option<String>) -> &str {
    value
        .as_deref()
        .map(str::trim)
        .expect("quad field checked above")
}

/// Parse the request into a [`ConnectionChoice`], mirroring
/// `self_host_from_flags`: no instance URL is nothing to apply, temper-as
/// needs the instance URL alone, and a self-hosted instance requires the
/// full provider quad.
pub fn parse_request(req: &ConnectionApplyRequest) -> Result<ConnectionChoice, String> {
    let instance_url = || {
        req.instance_url
            .as_deref()
            .map(normalized_instance_url)
            .filter(|url| !url.is_empty())
            .ok_or_else(|| "instance_url is required".to_string())
    };
    let required = |field: &Option<String>, name: &str| -> Result<String, String> {
        field
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
            .ok_or_else(|| format!("{name} is required"))
    };
    match req.choice.as_str() {
        "hosted" => Ok(ConnectionChoice::Hosted),
        "temper-as" => {
            let instance_url = instance_url()?;
            validate_instance_url(&instance_url)?;
            Ok(ConnectionChoice::TemperAs { instance_url })
        }
        "self-hosted" => {
            let instance_url = instance_url()?;
            validate_instance_url(&instance_url)?;
            // The quad is required together and named together, the way
            // init's self_host_from_flags names its missing flags in one
            // line.
            let quad = [
                (&req.auth_domain, "auth_domain"),
                (&req.client_id, "client_id"),
                (&req.audience, "audience"),
            ];
            let missing: Vec<&str> = quad
                .iter()
                .filter(|(value, _)| {
                    value
                        .as_deref()
                        .map(str::trim)
                        .filter(|v| !v.is_empty())
                        .is_none()
                })
                .map(|(_, name)| *name)
                .collect();
            if !missing.is_empty() {
                return Err(format!(
                    "a self-hosted connection needs {}",
                    missing.join(", ")
                ));
            }
            let self_hosted = SelfHosted {
                instance_url,
                auth_domain: trimmed_field(&req.auth_domain).to_string(),
                client_id: trimmed_field(&req.client_id).to_string(),
                audience: trimmed_field(&req.audience).to_string(),
                idp: match req.idp.as_deref() {
                    None | Some("auth0") => SelfHostIdp::Auth0,
                    Some("okta") => SelfHostIdp::Okta {
                        auth_server_id: required(&req.auth_server_id, "auth_server_id")?,
                    },
                    Some(other) => {
                        return Err(format!(
                            "unknown idp '{other}' (expected 'auth0' or 'okta')"
                        ))
                    }
                },
            };
            Ok(ConnectionChoice::SelfHosted(self_hosted))
        }
        other => Err(format!(
            "unknown choice '{other}' (expected 'hosted', 'self-hosted', or 'temper-as')"
        )),
    }
}

/// The connection's current state, for the room.
#[tauri::command]
pub fn temper_connection_gather() -> Result<ConnectionGather, String> {
    gather_from_path(&global_config_path())
}

/// What an apply wrote: the refreshed connection state, and — on a fresh
/// machine — the vault path the establish arm chose and created. The reply
/// names what was established, so the room can say so.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionApplyReply {
    #[serde(flatten)]
    pub state: ConnectionGather,
    /// The vault path the establish arm wrote. None on an existing config,
    /// where the apply merged `[auth]` and nothing else.
    pub established_vault_path: Option<String>,
}

/// The vault path a fresh-machine apply uses: the request's non-blank value,
/// else init's default.
fn requested_vault_path(req: &ConnectionApplyRequest) -> String {
    req.vault_path
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .unwrap_or_else(default_vault_path)
}

/// Apply the connection the room chose: validate, derive the provider entry
/// `init` would write, and write it — scoped by existence. An existing
/// config takes the byte-preserving `[auth]` merge and nothing else; a fresh
/// machine is established whole at `temper init` parity (the vault
/// directories with it), with the vault path the room chose and the reply
/// naming it. Either way the answer carries the refreshed state, so the room
/// reads what now resolves.
#[tauri::command]
pub fn temper_connection_apply(
    request: ConnectionApplyRequest,
) -> Result<ConnectionApplyReply, String> {
    let choice = parse_request(&request)?;
    let path = global_config_path();
    let established_vault_path = if path.exists() {
        apply_to_path(&path, &choice)?;
        None
    } else {
        let vault_path = requested_vault_path(&request);
        establish_at_path(&path, &choice, &vault_path)?;
        Some(vault_path)
    };
    let state = gather_from_path(&path)?;
    Ok(ConnectionApplyReply {
        state,
        established_vault_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use temper_core::types::config::TemperConfig;

    /// A scratch config path in the machine's temp dir, unique per run — the
    /// same discipline as the auth-store witnesses. No keychain, no env.
    fn scratch_path(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "desktop-connection-{name}-{}.toml",
            uuid::Uuid::new_v4()
        ))
    }

    /// The quad the derivation vectors share with `temper init`'s own
    /// `self_hosted_emits_derived_urls` test.
    fn acme_auth0() -> ConnectionChoice {
        ConnectionChoice::SelfHosted(SelfHosted {
            instance_url: "https://temper.acme.com".to_string(),
            auth_domain: "acme.us.auth0.com".to_string(),
            client_id: "AcMeClientId123".to_string(),
            audience: "https://temper.acme.com/api".to_string(),
            idp: SelfHostIdp::Auth0,
        })
    }

    /// WITNESS (derivation parity, hosted): the entry the desktop derives for
    /// Hosted is the block `temper init` writes from its hosted preset
    /// (`init.rs:27-30`, consumed at `render_config_toml`) — same name, same
    /// endpoint templates, same CLI client id, same callback — and it
    /// additionally carries the desktop's own Auth0 registration, which the
    /// CLI's block never does.
    #[test]
    fn hosted_derivation_matches_init_emission() {
        let entry = derive_provider(&ConnectionChoice::Hosted).expect("hosted derives");
        assert_eq!(entry.name, "auth0");
        assert_eq!(
            entry.authorize_url,
            format!("https://{}/authorize", hosted_preset::AUTH_DOMAIN)
        );
        assert_eq!(
            entry.token_url,
            format!("https://{}/oauth/token", hosted_preset::AUTH_DOMAIN)
        );
        assert_eq!(entry.client_id, hosted_preset::CLIENT_ID);
        assert_eq!(entry.audience, hosted_preset::AUDIENCE);
        assert_eq!(
            entry.callback_url,
            format!("{}/api/auth/cli-callback", hosted_preset::API_URL)
        );
        assert_eq!(
            entry.scopes,
            vec!["openid", "profile", "email", "offline_access"]
        );
        assert_eq!(
            entry.desktop_client_id.as_deref(),
            hosted_preset::DESKTOP_CLIENT_ID,
            "the entry carries exactly the preset's registration"
        );
        assert_eq!(
            entry.desktop_client_id.as_deref(),
            Some("v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE"),
            "the desktop's own Auth0 application for temperkb.io — a separate \
             registration from the CLI's, never a fallback to it"
        );
    }

    /// WITNESS (derivation parity, self-hosted Auth0): the same quad `init`'s
    /// own test fixes produces the same provider block — endpoints templated
    /// onto the auth domain, callback derived from the instance URL.
    #[test]
    fn self_hosted_auth0_derivation_matches_init_emission() {
        let entry = derive_provider(&acme_auth0()).expect("self-hosted derives");
        assert_eq!(entry.name, "auth0");
        assert_eq!(entry.authorize_url, "https://acme.us.auth0.com/authorize");
        assert_eq!(entry.token_url, "https://acme.us.auth0.com/oauth/token");
        assert_eq!(entry.client_id, "AcMeClientId123");
        assert_eq!(entry.audience, "https://temper.acme.com/api");
        assert_eq!(
            entry.callback_url,
            "https://temper.acme.com/api/auth/cli-callback"
        );
        assert_eq!(
            entry.scopes,
            vec!["openid", "profile", "email", "offline_access"]
        );
    }

    /// WITNESS (derivation parity, Okta): the custom authorization server id
    /// lands in both endpoint templates, the way `init`'s Okta shape writes
    /// them.
    #[test]
    fn okta_derivation_matches_init_url_templates() {
        let choice = ConnectionChoice::SelfHosted(SelfHosted {
            instance_url: "https://temper.acme.com".to_string(),
            auth_domain: "acme.okta.com".to_string(),
            client_id: "AcMeClientId123".to_string(),
            audience: "https://temper.acme.com/api".to_string(),
            idp: SelfHostIdp::Okta {
                auth_server_id: "aus1a2b3c".to_string(),
            },
        });
        let entry = derive_provider(&choice).expect("okta derives");
        assert_eq!(entry.name, "auth0", "Okta keeps the auth0 label");
        assert_eq!(
            entry.authorize_url,
            "https://acme.okta.com/oauth2/aus1a2b3c/v1/authorize"
        );
        assert_eq!(
            entry.token_url,
            "https://acme.okta.com/oauth2/aus1a2b3c/v1/token"
        );
    }

    /// WITNESS (temper-as derives from the instance URL alone): the whole
    /// block — instance OAuth endpoints, `{instance}/api` audience, the CLI's
    /// `temper-cli` client id for parity, and the desktop's own fixed public
    /// client — comes from one scheme-qualified URL, trailing slash trimmed.
    #[test]
    fn temper_as_derives_from_instance_url_alone() {
        let choice = ConnectionChoice::TemperAs {
            instance_url: "https://saml.acme.com/".to_string(),
        };
        let entry = derive_provider(&choice).expect("temper-as derives");
        assert_eq!(entry.name, "temper-as");
        assert_eq!(entry.authorize_url, "https://saml.acme.com/oauth/authorize");
        assert_eq!(entry.token_url, "https://saml.acme.com/oauth/token");
        assert_eq!(entry.audience, "https://saml.acme.com/api");
        assert_eq!(entry.client_id, "temper-cli");
        assert_eq!(
            entry.callback_url,
            "https://saml.acme.com/api/auth/cli-callback"
        );
        assert_eq!(entry.scopes, vec!["openid", "offline_access"]);
        assert_eq!(
            entry.desktop_client_id.as_deref(),
            Some(TEMPER_AS_DESKTOP_CLIENT),
            "the desktop public client is part of the derivation, registered by the deployment"
        );
    }

    /// WITNESS (the init rule): an instance URL the client would refuse at
    /// every later command is refused at the derivation — the same rule
    /// `validate_instance_url` applies when init chooses the value.
    #[test]
    fn a_bad_instance_url_is_refused_like_init_refuses() {
        let userinfo = ConnectionChoice::TemperAs {
            instance_url: "https://id:secret@saml.acme.com".to_string(),
        };
        assert!(
            derive_provider(&userinfo).is_err(),
            "userinfo would ride the secret in every error message"
        );
        let scheme = ConnectionChoice::TemperAs {
            instance_url: "ftp://saml.acme.com".to_string(),
        };
        assert!(derive_provider(&scheme).is_err(), "non-http(s) is refused");
        let relative = ConnectionChoice::TemperAs {
            instance_url: "saml.acme.com".to_string(),
        };
        assert!(
            derive_provider(&relative).is_err(),
            "no scheme, no host — refused"
        );
    }

    /// The person's config as the CLI and init leave it: comments, a vault,
    /// sync, skill and cli sections, a hand-set `auth.path`, and one provider
    /// entry — everything the merge must not disturb outside `[auth]`.
    const PERSONAL_CONFIG: &str = r#"# the person's own comment, above everything
[vault]
path = "~/vault"  # a trailing comment on the vault line

[sync.subscriptions]
contexts = ["default", "writing"]

[auth]
# the person pinned where the auth file lives
provider = "auth0"
path = "~/.config/temper/auth.json"

[[auth.providers]]
name = "auth0"
authorize_url = "https://acme.us.auth0.com/authorize"
token_url = "https://acme.us.auth0.com/oauth/token"
client_id = "AcMeClientId123"
audience = "https://temper.acme.com/api"
callback_url = "https://temper.acme.com/api/auth/cli-callback"
scopes = ["openid", "profile", "email", "offline_access"]

[cloud]
api_url = "https://temper.acme.com"

# [cli] — output-presentation defaults the CLI owns; the desktop never writes here.
# [cli]
"#;

    /// The smallest config the stack parses: the vault section is the one
    /// TemperConfig field without a default.
    const MINIMAL_CONFIG: &str = "[vault]\npath = \"~/vault\"\n";

    /// WITNESS (merge preservation): applying hosted over the person's acme
    /// config rewrites `[auth]` and changes nothing else — the bytes before
    /// and after the section survive byte-for-byte, and the hand-set
    /// `auth.path` is left alone. A naive parse-and-rewrite fails this:
    /// `toml::to_string` alphabetizes keys and drops every comment.
    #[test]
    fn apply_preserves_everything_outside_auth() {
        let path = scratch_path("merge");
        std::fs::write(&path, PERSONAL_CONFIG).expect("fixture written");

        let written = apply_to_path(&path, &ConnectionChoice::Hosted).expect("apply");
        assert_eq!(written.name, "auth0", "the derived hosted entry came back");

        let merged = std::fs::read_to_string(&path).expect("merged config read");

        let auth_start = merged.find("[auth]").expect("[auth] present");
        let cloud_start = merged.find("[cloud]").expect("[cloud] present");
        // Everything before the rewritten section, byte-for-byte.
        assert_eq!(
            &merged[..auth_start],
            &PERSONAL_CONFIG[..PERSONAL_CONFIG.find("[auth]").expect("fixture has [auth]")],
            "bytes before [auth] survive exactly"
        );
        // Everything from the next foreign section on, byte-for-byte.
        assert_eq!(
            &merged[cloud_start..],
            &PERSONAL_CONFIG[PERSONAL_CONFIG
                .find("[cloud]")
                .expect("fixture has [cloud]")..],
            "bytes from [cloud] on survive exactly, comments included"
        );

        // The hand-set auth.path was not written over or dropped.
        assert!(
            merged.contains("path = \"~/.config/temper/auth.json\""),
            "the person's auth.path survives inside [auth]"
        );

        // And the merged file is still the config the stack parses.
        let cfg: TemperConfig =
            toml::from_str(&merged).expect("the merged config parses as TemperConfig");
        let entry = &cfg.auth.providers[0];
        assert_eq!(entry.audience, hosted_preset::AUDIENCE, "[auth] did change");
        assert_eq!(
            cfg.auth.path.as_deref(),
            Some("~/.config/temper/auth.json"),
            "the parsed config still carries the pinned auth path"
        );
        std::fs::remove_file(&path).ok();
    }

    /// `temper init`'s rendered config for the hosted preset, as its
    /// `render_config_toml` emits it (`init.rs:653-705`; the provider and
    /// cloud sections at `init.rs:597-645`) — fixed here because the CLI
    /// crate is not a desktop dependency and mirroring with parity witnesses
    /// is the only consumption path. The `{vault_path}` slot is the one
    /// input init fills per machine (its `WizardAnswers.vault_path`); every
    /// other byte is init's own emission.
    const INIT_HOSTED_RENDER: &str = r#"[vault]
path = "{vault_path}"

[sync.subscriptions]
contexts = ["default"]

[skill]
output = "~/.claude/skills/temper"

[auth]
provider = "auth0"

[[auth.providers]]
name = "auth0"
authorize_url = "https://temperkb.us.auth0.com/authorize"
token_url = "https://temperkb.us.auth0.com/oauth/token"
client_id = "mWp8znLw2MUJNCiZNl8wwBv6SPJI2mfF"
audience = "https://temperkb.io/api"
callback_url = "https://temperkb.io/api/auth/cli-callback"
scopes = ["openid", "profile", "email", "offline_access"]

[cloud]
api_url = "https://temperkb.io"

# [cli] — output-presentation defaults (optional; omit for agent-first auto behavior).
# [cli]
# format = "json"
"#;

    /// WITNESS (establish, the fresh arm): a machine with no config is no
    /// longer refused — the desktop establishes the whole file at `temper
    /// init` parity. The vault root and its `.temper/` state dir exist at
    /// init's default location, the written config parses as the stack's
    /// TemperConfig with the sections init writes, and the connection now
    /// resolves. The old refusal witness (apply naming `temper init` on a
    /// fresh path) modelled the overturned behavior and is gone with it.
    #[test]
    fn a_fresh_machine_is_established_whole() {
        let _order = crate::witness_env::ENV_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        // The default vault path resolves from $HOME: scoped to a scratch
        // root, so the witness never writes the person's real home.
        let home =
            std::env::temp_dir().join(format!("desktop-connection-home-{}", uuid::Uuid::new_v4()));
        let _home = crate::witness_env::ScopedEnv::set("HOME", home.to_str().unwrap());
        let path = scratch_path("establish");
        assert!(!path.exists(), "precondition: no config");

        let written =
            apply_to_path(&path, &ConnectionChoice::Hosted).expect("a fresh machine establishes");
        assert_eq!(written.name, "auth0", "the derived hosted entry came back");

        // The vault directories, exactly the two `create_dir_all`s init's
        // apply_answers makes (init.rs:483, 489-491) at init's default.
        let vault = home.join("Documents/temper-vault");
        assert!(vault.is_dir(), "the vault root exists at init's default");
        assert!(
            vault.join(".temper").is_dir(),
            "the .temper state dir exists"
        );
        assert!(path.is_file(), "the config was written");

        // The file is a config the whole stack parses, and the connection resolves.
        let cfg: TemperConfig =
            toml::from_str(&std::fs::read_to_string(&path).expect("config read"))
                .expect("the established config parses as TemperConfig");
        assert_eq!(
            cfg.vault.path,
            vault.to_string_lossy(),
            "the [vault] path names the vault that was created"
        );
        assert_eq!(
            cfg.cloud.api_url,
            hosted_preset::API_URL,
            "[cloud] is init's"
        );
        assert_eq!(cfg.auth.provider, "auth0");
        assert_eq!(cfg.auth.providers[0].audience, hosted_preset::AUDIENCE);

        let gathered = gather_from_path(&path).expect("gather after establish");
        assert!(gathered.config_exists);
        assert_eq!(gathered.choice.as_deref(), Some("hosted"));
        std::fs::remove_dir_all(&home).ok();
    }

    /// WITNESS (differential, the published parser): the desktop-established
    /// config and `temper init`'s own render load through the same published
    /// loader (`load_cloud_config_from`) with every section the way init's
    /// would — and the one delta is named: the desktop's own client
    /// registration, which init's block never carries.
    #[test]
    fn the_established_config_loads_like_inits() {
        let _order = crate::witness_env::ENV_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let home =
            std::env::temp_dir().join(format!("desktop-connection-home-{}", uuid::Uuid::new_v4()));
        let _home = crate::witness_env::ScopedEnv::set("HOME", home.to_str().unwrap());
        let path = scratch_path("establish-load");
        apply_to_path(&path, &ConnectionChoice::Hosted).expect("establishes");

        // init's render for the same input: its default vault path under the
        // same scoped home, the one per-machine input filled.
        let vault = home.join("Documents/temper-vault");
        let init_path = scratch_path("init-render");
        std::fs::write(
            &init_path,
            INIT_HOSTED_RENDER.replace("{vault_path}", vault.to_string_lossy().as_ref()),
        )
        .expect("the init vector writes");

        let desktop = load_cloud_config_from(&path).expect("the desktop-written config loads");
        let init = load_cloud_config_from(&init_path).expect("init's render loads");
        assert_eq!(desktop.vault.path, init.vault.path);
        assert_eq!(desktop.cloud.api_url, init.cloud.api_url);
        assert_eq!(desktop.auth.provider, init.auth.provider);

        assert_eq!(desktop.auth.providers.len(), 1);
        let (written, initd) = (&desktop.auth.providers[0], &init.auth.providers[0]);
        assert_eq!(written.name, initd.name);
        assert_eq!(written.authorize_url, initd.authorize_url);
        assert_eq!(written.token_url, initd.token_url);
        assert_eq!(
            written.client_id, initd.client_id,
            "the CLI's id stays the entry's client_id"
        );
        assert_eq!(written.audience, initd.audience);
        assert_eq!(written.callback_url, initd.callback_url);
        assert_eq!(written.scopes, initd.scopes);
        assert_eq!(
            initd.desktop_client_id, None,
            "init's block registers no desktop client"
        );
        assert_eq!(
            written.desktop_client_id.as_deref(),
            Some("v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE"),
            "the one delta: the desktop's own registration rides the entry"
        );
        std::fs::remove_dir_all(&home).ok();
    }

    /// A write over a minimal-but-valid config touches only `[auth]`: the
    /// file gains no vault, cloud, or cli section — those are init's to
    /// write — and the result still parses as the stack's TemperConfig.
    #[test]
    fn apply_writes_only_the_auth_section() {
        let path = scratch_path("minimal");
        std::fs::write(&path, MINIMAL_CONFIG).expect("fixture written");
        apply_to_path(&path, &ConnectionChoice::Hosted).expect("apply");

        let written = std::fs::read_to_string(&path).expect("written config read");
        for foreign in ["[cloud]", "[cli]", "[sync"] {
            assert!(!written.contains(foreign), "the write carries no {foreign}");
        }
        let cfg: TemperConfig =
            toml::from_str(&written).expect("the written config parses as TemperConfig");
        assert_eq!(cfg.auth.provider, "auth0");
        assert_eq!(cfg.auth.providers[0].audience, hosted_preset::AUDIENCE);
        assert!(
            cfg.auth.path.is_none(),
            "the desktop never writes auth.path"
        );
        std::fs::remove_file(&path).ok();
    }

    /// `temper init`'s rendered config for a temper-as choice, same source
    /// (`init.rs:653-705`, with `provider_and_cloud_sections`' temper-as arm
    /// at `init.rs:616-622,629-645`), the vault path the one filled input.
    const INIT_TEMPER_AS_RENDER: &str = r#"[vault]
path = "{vault_path}"

[sync.subscriptions]
contexts = ["default"]

[skill]
output = "~/.claude/skills/temper"

[auth]
provider = "temper-as"

[[auth.providers]]
name = "temper-as"
authorize_url = "https://saml.acme.com/oauth/authorize"
token_url = "https://saml.acme.com/oauth/token"
client_id = "temper-cli"
audience = "https://saml.acme.com/api"
callback_url = "https://saml.acme.com/api/auth/cli-callback"
scopes = ["openid", "offline_access"]

[cloud]
api_url = "https://saml.acme.com"

# [cli] — output-presentation defaults (optional; omit for agent-first auto behavior).
# [cli]
# format = "json"
"#;

    /// WITNESS (establish, init parity, fixed vectors): the establish arm's
    /// config, parsed, matches `temper init`'s own render section by section
    /// — `[vault]`, `[cloud]`, and the provider entry — for the hosted
    /// preset and the temper-as choice, the two fully-derivable shapes. The
    /// named delta is the desktop's own registration on the hosted entry,
    /// which init's block never carries.
    #[test]
    fn establish_matches_init_rendered_shape() {
        // A scratch vault root: the establish arm creates the directories it
        // names, so the chosen path is real but disposable.
        let vault_root =
            std::env::temp_dir().join(format!("desktop-connection-shape-{}", uuid::Uuid::new_v4()));
        let hosted_vault = vault_root.join("hosted-vault");

        let hosted_path = scratch_path("establish-hosted");
        establish_at_path(
            &hosted_path,
            &ConnectionChoice::Hosted,
            hosted_vault.to_string_lossy().as_ref(),
        )
        .expect("hosted establish");
        let hosted: TemperConfig =
            toml::from_str(&std::fs::read_to_string(&hosted_path).expect("config read"))
                .expect("the established config parses as TemperConfig");
        let hosted_init: TemperConfig = toml::from_str(
            &INIT_HOSTED_RENDER.replace("{vault_path}", hosted_vault.to_string_lossy().as_ref()),
        )
        .expect("the init vector parses");
        assert_eq!(hosted.vault.path, hosted_init.vault.path);
        assert_eq!(hosted.cloud.api_url, hosted_init.cloud.api_url);
        assert_eq!(hosted.auth.provider, hosted_init.auth.provider);
        assert_eq!(hosted.auth.providers.len(), 1);
        let (written, initd) = (&hosted.auth.providers[0], &hosted_init.auth.providers[0]);
        assert_eq!(written.name, initd.name);
        assert_eq!(written.authorize_url, initd.authorize_url);
        assert_eq!(written.token_url, initd.token_url);
        assert_eq!(written.client_id, initd.client_id);
        assert_eq!(written.audience, initd.audience);
        assert_eq!(written.callback_url, initd.callback_url);
        assert_eq!(written.scopes, initd.scopes);
        assert_eq!(
            written.desktop_client_id.as_deref(),
            Some("v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE"),
            "the desktop's own registration rides the hosted entry"
        );
        assert_eq!(initd.desktop_client_id, None);
        std::fs::remove_file(&hosted_path).ok();

        let as_vault = vault_root.join("as-vault");
        let as_path = scratch_path("establish-temper-as");
        establish_at_path(
            &as_path,
            &ConnectionChoice::TemperAs {
                instance_url: "https://saml.acme.com/".to_string(),
            },
            as_vault.to_string_lossy().as_ref(),
        )
        .expect("temper-as establish");
        let as_written: TemperConfig =
            toml::from_str(&std::fs::read_to_string(&as_path).expect("config read"))
                .expect("the established config parses as TemperConfig");
        let as_init: TemperConfig = toml::from_str(
            &INIT_TEMPER_AS_RENDER.replace("{vault_path}", as_vault.to_string_lossy().as_ref()),
        )
        .expect("the init vector parses");
        assert_eq!(as_written.vault.path, as_init.vault.path);
        assert_eq!(as_written.cloud.api_url, as_init.cloud.api_url);
        assert_eq!(as_written.auth.provider, as_init.auth.provider);
        assert_eq!(
            as_written.auth.providers[0].name, as_init.auth.providers[0].name,
            "temper-as is its own provider, the way init writes it"
        );
        assert_eq!(
            as_init.auth.providers[0].desktop_client_id, None,
            "init writes no desktop registration; the AS_CLIENTS entry is the deployment's to add"
        );
        assert_eq!(
            as_written.auth.providers[0].desktop_client_id.as_deref(),
            Some(TEMPER_AS_DESKTOP_CLIENT),
            "the desktop's fixed public client is part of the temper-as derivation"
        );
        std::fs::remove_file(&as_path).ok();
        std::fs::remove_dir_all(&vault_root).ok();
    }

    /// WITNESS (establish, the vault directories and the reply): the
    /// establish arm creates the vault root and its `.temper/` state dir
    /// where the chosen path names them, and the command's reply names the
    /// vault path it established. The command runs against a config path
    /// relocated by `TEMPER_GLOBAL_CONFIG` (honored by
    /// `global_config_path`, temper-core config.rs:487-496), so nothing
    /// touches the machine's real config.
    #[test]
    fn the_reply_names_what_was_established() {
        let _order = crate::witness_env::ENV_SERIAL
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        let config_path = std::env::temp_dir()
            .join(format!("desktop-connection-reply-{}", uuid::Uuid::new_v4()))
            .join("config.toml");
        let _env = crate::witness_env::ScopedEnv::set(
            "TEMPER_GLOBAL_CONFIG",
            config_path.to_str().unwrap(),
        );
        let vault_root = std::env::temp_dir().join(format!(
            "desktop-connection-reply-vault-{}",
            uuid::Uuid::new_v4()
        ));
        let vault_path = vault_root.join("vault");

        let reply = temper_connection_apply(
            serde_json::from_value(serde_json::json!({
                "choice": "hosted",
                "vaultPath": vault_path.to_string_lossy(),
            }))
            .expect("the request parses"),
        )
        .expect("a fresh machine's apply establishes");

        assert_eq!(
            reply.established_vault_path.as_deref(),
            Some(vault_path.to_string_lossy().as_ref()),
            "the reply names the vault path it chose"
        );
        assert!(vault_path.is_dir(), "the vault root was created");
        assert!(vault_path.join(".temper").is_dir(), "the state dir with it");
        assert!(config_path.is_file(), "the config was written");
        assert!(reply.state.config_exists);
        assert_eq!(reply.state.choice.as_deref(), Some("hosted"));

        // A second apply, the config now existing, is a merge: the reply
        // names no establish, and the vault is untouched.
        let second = temper_connection_apply(
            serde_json::from_value(serde_json::json!({
                "choice": "hosted",
            }))
            .expect("the request parses"),
        )
        .expect("the merge answers");
        assert_eq!(
            second.established_vault_path, None,
            "an existing config is a merge, not an establish"
        );
        std::fs::remove_dir_all(&vault_root).ok();
        std::fs::remove_dir_all(config_path.parent().expect("config has a parent")).ok();
    }

    /// WITNESS (no fallback): an entry without the desktop's registration
    /// refuses sign-in with one line that names the unregistered client —
    /// and never leaks the CLI's client id as a stand-in.
    #[test]
    fn a_missing_desktop_registration_refuses_without_fallback() {
        let entry = derive_provider(&acme_auth0()).expect("self-hosted derives");
        assert_eq!(entry.desktop_client_id, None);
        let refusal = sign_in_refusal(&entry).expect("unregistered refuses");
        assert!(
            refusal.contains("desktop_client_id"),
            "the line names the field the registration belongs in: {refusal}"
        );
        assert!(
            refusal.contains("acme.us.auth0.com"),
            "the line names the tenant the client is unregistered at: {refusal}"
        );
        assert!(
            !refusal.contains(&entry.client_id),
            "the CLI's client id is never a fallback: {refusal}"
        );

        // temper-as names its fixed public client and the AS_CLIENTS fix.
        // The derivation fills the field, so the unregistered state is a
        // deployment that has not added the AS_CLIENTS entry — or a config
        // predating it: the field cleared.
        let as_choice = ConnectionChoice::TemperAs {
            instance_url: "https://saml.acme.com".to_string(),
        };
        let mut as_entry = derive_provider(&as_choice).expect("temper-as derives");
        as_entry.desktop_client_id = None;
        let as_refusal = sign_in_refusal(&as_entry).expect("unregistered refuses");
        assert!(
            as_refusal.contains(TEMPER_AS_DESKTOP_CLIENT) && as_refusal.contains("AS_CLIENTS"),
            "the temper-as line names the client and the registry: {as_refusal}"
        );

        // A present registration is no refusal; a blank one is absence.
        let mut registered = entry.clone();
        registered.desktop_client_id = Some("  ".to_string());
        assert!(
            sign_in_refusal(&registered).is_some(),
            "a blank registration is no registration"
        );
        registered.desktop_client_id = Some("0aBcDeFg123".to_string());
        assert_eq!(sign_in_refusal(&registered), None, "registered signs in");
    }

    /// WITNESS (gather): the config's active entry classifies into the choice
    /// vocabulary, the hosted fresh write reports the unregistered-client
    /// refusal, and an absent config is the fresh-machine state.
    #[test]
    fn gather_classifies_what_resolves_and_names_whats_missing() {
        // No file: the fresh machine.
        let absent = scratch_path("absent");
        let gathered = gather_from_path(&absent).expect("gather over nothing");
        assert!(!gathered.config_exists);
        assert!(
            gathered.default_vault_path.is_some(),
            "a fresh machine is shown init's default vault path"
        );
        assert_eq!(gathered.choice, None);
        assert_eq!(gathered.provider, None);
        assert_eq!(
            gathered.sign_in_refusal, None,
            "nothing resolves, nothing refuses"
        );

        // Hosted, as a desktop write produces it: choice resolves, the
        // registration absence is named.
        let hosted_path = scratch_path("hosted");
        std::fs::write(&hosted_path, MINIMAL_CONFIG).expect("fixture written");
        apply_to_path(&hosted_path, &ConnectionChoice::Hosted).expect("hosted apply");
        let gathered = gather_from_path(&hosted_path).expect("gather over hosted");
        assert!(gathered.config_exists);
        assert_eq!(gathered.choice.as_deref(), Some("hosted"));
        assert_eq!(
            gathered.default_vault_path, None,
            "an existing config's vault is the person's own; the default is none of the room's business"
        );
        assert_eq!(
            gathered
                .provider
                .as_ref()
                .expect("provider")
                .desktop_client_id
                .as_deref(),
            Some("v77CQpR2P5EUNfPAkiPPaHXIQbGG5dsE"),
            "the hosted write carries the desktop's own registration"
        );
        assert_eq!(
            gathered.sign_in_refusal, None,
            "the desktop's own client is registered: hosted sign-in is ready"
        );

        // temper-as with its registration: resolves, and sign-in is ready.
        let as_path = scratch_path("temper-as");
        let as_choice = ConnectionChoice::TemperAs {
            instance_url: "https://saml.acme.com".to_string(),
        };
        std::fs::write(&as_path, MINIMAL_CONFIG).expect("fixture written");
        apply_to_path(&as_path, &as_choice).expect("temper-as apply");
        let gathered = gather_from_path(&as_path).expect("gather over temper-as");
        assert_eq!(gathered.choice.as_deref(), Some("temper-as"));
        assert_eq!(
            gathered.sign_in_refusal, None,
            "the registration is present"
        );
        std::fs::remove_file(&hosted_path).ok();
        std::fs::remove_file(&as_path).ok();
    }

    /// The request parse mirrors `self_host_from_flags`: hosted needs
    /// nothing, temper-as needs the instance URL alone, self-hosted needs the
    /// quad (plus the Okta server id when Okta), and the instance URL is
    /// canonicalized before validation.
    #[test]
    fn parse_request_mirrors_self_host_from_flags() {
        let hosted = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "hosted",
            }))
            .expect("hosted request"),
        )
        .expect("hosted parses");
        assert_eq!(hosted, ConnectionChoice::Hosted);

        let temper_as = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "temper-as",
                "instanceUrl": "https://saml.acme.com/",
            }))
            .expect("temper-as request"),
        )
        .expect("temper-as parses");
        assert_eq!(
            temper_as,
            ConnectionChoice::TemperAs {
                instance_url: "https://saml.acme.com".to_string()
            },
            "the trailing slash is trimmed before validation"
        );

        let err = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "temper-as",
            }))
            .expect("request"),
        )
        .expect_err("temper-as without an instance URL refuses");
        assert!(err.contains("instance_url"));

        let err = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "self-hosted",
                "instanceUrl": "https://temper.acme.com",
                "authDomain": "acme.us.auth0.com",
            }))
            .expect("request"),
        )
        .expect_err("a self-hosted quad without client_id/audience refuses");
        assert!(err.contains("client_id") && err.contains("audience"));

        let err = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "self-hosted",
                "instanceUrl": "https://temper.acme.com",
                "authDomain": "acme.okta.com",
                "clientId": "c",
                "audience": "https://temper.acme.com/api",
                "idp": "okta",
            }))
            .expect("request"),
        )
        .expect_err("okta without a server id refuses");
        assert!(err.contains("auth_server_id"));

        let okta = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "self-hosted",
                "instanceUrl": "https://temper.acme.com",
                "authDomain": "acme.okta.com",
                "clientId": "c",
                "audience": "https://temper.acme.com/api",
                "idp": "okta",
                "authServerId": "aus1a2b3c",
            }))
            .expect("request"),
        )
        .expect("okta quad parses");
        assert!(matches!(
            okta,
            ConnectionChoice::SelfHosted(SelfHosted {
                idp: SelfHostIdp::Okta { .. },
                ..
            })
        ));

        let err = parse_request(
            &serde_json::from_value(serde_json::json!({
                "choice": "local",
            }))
            .expect("request"),
        )
        .expect_err("an unknown choice refuses");
        assert!(err.contains("hosted") && err.contains("temper-as"));
    }
}
