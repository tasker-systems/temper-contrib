//! The person's configured context: where this device's person-tier records
//! land. Found by profile owner and configured name, created on first write.
//! Creation races are harmless — the next write finds it. Both writers (the
//! conversation work record and the desktop hub) resolve through this one
//! predicate, so two copies of "resolves" cannot drift.

use temper_client::TemperClient;

/// The context is the person's when it is profile-owned AND carries the
/// configured name — a team's context of the same name is someone else's
/// home and must never receive this person's records.
pub fn is_persons_context(
    owner_table: &str,
    owner_id: uuid::Uuid,
    name: &str,
    wanted: &str,
    profile_id: uuid::Uuid,
) -> bool {
    owner_table == "kb_profiles" && owner_id == profile_id && name == wanted
}

/// The person's configured context: found by owner and name, created on
/// first write.
pub async fn persons_context_id(
    client: &TemperClient,
    context_name: &str,
) -> Result<uuid::Uuid, String> {
    let profile = client.profile().get().await.map_err(|e| e.to_string())?;
    let contexts = client.contexts().list().await.map_err(|e| e.to_string())?;
    if let Some(existing) = contexts.iter().find(|c| {
        is_persons_context(
            &c.kb_owner_table,
            c.kb_owner_id,
            &c.name,
            context_name,
            profile.id,
        )
    }) {
        return Ok(existing.id.0);
    }
    let created = client
        .contexts()
        .create(context_name, None)
        .await
        .map_err(|e| e.to_string())?;
    Ok(created.id.0)
}

/// Every context in the person's own list carrying the configured name —
/// the one that resolves, plus any race-made duplicates a read must still
/// see rather than drop.
pub async fn persons_contexts(
    client: &TemperClient,
    context_name: &str,
) -> Result<Vec<uuid::Uuid>, String> {
    let profile = client.profile().get().await.map_err(|e| e.to_string())?;
    let contexts = client.contexts().list().await.map_err(|e| e.to_string())?;
    Ok(contexts
        .iter()
        .filter(|c| {
            is_persons_context(
                &c.kb_owner_table,
                c.kb_owner_id,
                &c.name,
                context_name,
                profile.id,
            )
        })
        .map(|c| c.id.0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_context_is_the_persons_own_by_owner_and_configured_name() {
        let me = uuid::Uuid::nil();
        assert!(is_persons_context(
            "kb_profiles",
            me,
            "temper-desktop",
            "temper-desktop",
            me
        ));
        // Same name, team-owned: not this person's home.
        assert!(!is_persons_context(
            "kb_teams",
            me,
            "temper-desktop",
            "temper-desktop",
            me
        ));
        // Same owner, different name: not the configured context.
        assert!(!is_persons_context(
            "kb_profiles",
            me,
            "other",
            "temper-desktop",
            me
        ));
        // Same name, someone else's profile: not this person's home either.
        assert!(!is_persons_context(
            "kb_profiles",
            uuid::Uuid::new_v4(),
            "temper-desktop",
            "temper-desktop",
            me
        ));
    }
}
