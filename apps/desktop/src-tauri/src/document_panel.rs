//! The reads behind a document's "about this document" panel: connections, related resources,
//! history and sources. Each is its own command, called only when its tab is first opened, so a
//! failure in one never reaches the body or another tab.
//!
//! The server's connections and related reads are complete — neither pages nor caps what it
//! returns — so each comes back whole with its true total, and the panel bounds what it shows.
//! The history read is not paged either and grows with every edit, so it is bounded here: the
//! newest events are kept and the rest are counted, never silently dropped.
//!
//! The shaping is pure and tested without a client; the commands only fetch and classify.

use std::collections::BTreeMap;

use serde::Serialize;
use temper_client::error::ClientError;
use temper_client::TemperClient;
use temper_core::types::graph_atlas::AtlasSubgraph;
use temper_core::types::provenance::BlockProvenanceRow;
use temper_core::types::{ElementEvent, ElementKind, EventTrail};
use temper_workflow::types::graph::GraphEdgeRow;
use uuid::Uuid;

use crate::temper::{parse_ref, unresolved_reason, TemperState};

/// The most history events one read hands the panel. Older events are counted, not sent.
pub const TRAIL_BOUND: usize = 200;

/// What one panel read came to. `Unresolved` is temper saying there is nothing the person can see
/// at that reference; `Failed` is the read not completing, which verifies nothing either way.
#[derive(Serialize, Debug)]
#[serde(tag = "state", rename_all = "kebab-case")]
pub enum PanelRead<T> {
    Present { data: T },
    Unresolved { reason: String },
    Failed { message: String },
}

fn classify<T>(result: Result<T, ClientError>) -> PanelRead<T> {
    match result {
        Ok(data) => PanelRead::Present { data },
        Err(err) => match unresolved_reason(&err) {
            Some(reason) => PanelRead::Unresolved {
                reason: reason.into(),
            },
            None => PanelRead::Failed {
                message: err.to_string(),
            },
        },
    }
}

// ─── Connections ────────────────────────────────────────────────────────────────────────────────

/// One edge touching the document, told from the document's side.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub edge_id: Uuid,
    /// `outgoing` when the document is the edge's source, `incoming` when it is the target.
    pub direction: String,
    pub label: String,
    pub edge_kind: String,
    pub weight: f64,
    /// What the far end is: `kb_resources` for a resource the room can open, `kb_blobs` for a
    /// blob, which has no title and no reference to resolve.
    pub peer_table: String,
    pub peer_id: Uuid,
    /// The title the server read with the edge. The UI resolves resource peers itself, so this is
    /// shown only for peers a reference cannot resolve.
    pub peer_title: Option<String>,
    pub created: String,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Connections {
    pub total: usize,
    pub edges: Vec<Connection>,
}

/// The name an enum travels under on the wire (`outgoing`, `leads_to`), so the UI reads the
/// server's own vocabulary rather than a desktop spelling of it.
fn wire_name(value: &impl Serialize) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|v| v.as_str().map(str::to_string))
        .unwrap_or_default()
}

/// Every edge, outgoing before incoming, strongest first within each direction.
pub(crate) fn shape_connections(rows: Vec<GraphEdgeRow>) -> Connections {
    let mut edges: Vec<Connection> = rows
        .into_iter()
        .map(|row| Connection {
            edge_id: row.edge_id.0,
            direction: wire_name(&row.direction),
            label: row.label,
            edge_kind: wire_name(&row.edge_kind),
            weight: row.weight,
            peer_table: row.peer_table,
            peer_id: row.peer_id,
            peer_title: row.peer_title,
            created: row.created.to_rfc3339(),
        })
        .collect();
    edges.sort_by(|a, b| {
        (a.direction != "outgoing")
            .cmp(&(b.direction != "outgoing"))
            .then(b.weight.total_cmp(&a.weight))
            .then(a.label.cmp(&b.label))
    });
    Connections {
        total: edges.len(),
        edges,
    }
}

// ─── Related ────────────────────────────────────────────────────────────────────────────────────

/// A resource one hop from the document, with the edges that join them.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Neighbour {
    pub id: Uuid,
    pub title: String,
    pub doc_type: Option<String>,
    pub excerpt: Option<String>,
    /// How connected the neighbour is overall — a hint at where a walk leads, not a rank.
    pub degree: i32,
    /// The labels of the edges between the document and this neighbour.
    pub via: Vec<String>,
    /// The strongest of those edges.
    pub weight: f64,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Related {
    pub total: usize,
    pub neighbours: Vec<Neighbour>,
}

/// The neighbourhood at one hop: every visible node but the document itself, strongest joining
/// edge first. Edges among neighbours are not the document's and are left out.
pub(crate) fn shape_related(seed: Uuid, subgraph: AtlasSubgraph) -> Related {
    let mut joins: BTreeMap<Uuid, (Vec<String>, f64)> = BTreeMap::new();
    for edge in &subgraph.edges {
        let other = if edge.source == seed {
            edge.target
        } else if edge.target == seed {
            edge.source
        } else {
            continue;
        };
        let entry = joins.entry(other).or_insert((Vec::new(), f64::MIN));
        if let Some(label) = edge.label.as_ref().filter(|l| !l.is_empty()) {
            if !entry.0.contains(label) {
                entry.0.push(label.clone());
            }
        }
        entry.1 = entry.1.max(edge.weight);
    }
    let mut neighbours: Vec<Neighbour> = subgraph
        .nodes
        .into_iter()
        .filter(|node| node.id != seed)
        .filter_map(|node| {
            let (via, weight) = joins.remove(&node.id)?;
            Some(Neighbour {
                id: node.id,
                title: node.title,
                doc_type: node.doc_type,
                excerpt: node.excerpt,
                degree: node.degree,
                via,
                weight,
            })
        })
        .collect();
    neighbours.sort_by(|a, b| b.weight.total_cmp(&a.weight).then(a.title.cmp(&b.title)));
    Related {
        total: neighbours.len(),
        neighbours,
    }
}

// ─── History ────────────────────────────────────────────────────────────────────────────────────

/// One event in the document's history.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEvent {
    pub event_id: Uuid,
    pub kind: String,
    pub occurred_at: String,
}

/// Consecutive events by one actor, newest first: the grain at which history reads, so an
/// agent's run of small edits never buries the one edit a person made between them.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRun {
    pub actor_name: String,
    /// How many distinct acts the run holds; an act can emit several events.
    pub acts: usize,
    pub first_at: String,
    pub last_at: String,
    pub events: Vec<HistoryEvent>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// Every event the trail holds.
    pub total: usize,
    /// Events left out because they are older than the newest `TRAIL_BOUND`.
    pub omitted: usize,
    pub runs: Vec<HistoryRun>,
}

pub(crate) fn shape_history(trail: EventTrail, bound: usize) -> History {
    let total = trail.events.len();
    let mut events: Vec<ElementEvent> = trail.events;
    events.sort_by(|a, b| b.occurred_at.cmp(&a.occurred_at));
    let omitted = total.saturating_sub(bound);
    events.truncate(bound);

    let mut runs: Vec<HistoryRun> = Vec::new();
    let mut current_actor: Option<Uuid> = None;
    let mut acts: Vec<Uuid> = Vec::new();
    for event in events {
        let act = event.correlation_id.unwrap_or(event.event_id);
        let item = HistoryEvent {
            event_id: event.event_id,
            kind: event.kind,
            occurred_at: event.occurred_at.clone(),
        };
        match runs.last_mut() {
            Some(run) if current_actor == Some(event.actor_entity_id) => {
                if !acts.contains(&act) {
                    acts.push(act);
                    run.acts += 1;
                }
                run.first_at = event.occurred_at;
                run.events.push(item);
            }
            _ => {
                current_actor = Some(event.actor_entity_id);
                acts = vec![act];
                runs.push(HistoryRun {
                    actor_name: event.actor_name,
                    acts: 1,
                    first_at: event.occurred_at.clone(),
                    last_at: event.occurred_at,
                    events: vec![item],
                });
            }
        }
    }
    History {
        total,
        omitted,
        runs,
    }
}

// ─── Sources ────────────────────────────────────────────────────────────────────────────────────

/// One source a block was distilled from.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// `resource`, `event` or `remote`, as the server names it.
    pub kind: String,
    pub source_id: Uuid,
    pub uri: Option<String>,
    /// Attribution carried forward from a block this one replaced.
    pub carried: bool,
}

/// The sources recorded against one block, in the order they accrued.
#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct BlockSources {
    pub block_seq: i32,
    pub sources: Vec<Source>,
}

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Sources {
    /// Blocks that have at least one recorded source. A block with none has no row — sources are
    /// recorded only when a writer names them — so absence means none recorded, not unknown.
    pub blocks: Vec<BlockSources>,
}

pub(crate) fn shape_sources(mut rows: Vec<BlockProvenanceRow>) -> Sources {
    rows.sort_by_key(|row| (row.block_seq, row.accretion_seq));
    let mut blocks: Vec<BlockSources> = Vec::new();
    for row in rows {
        let source = Source {
            kind: row.source_kind,
            source_id: row.source_id,
            uri: row.source_uri,
            carried: row.is_carried,
        };
        match blocks.last_mut() {
            Some(block) if block.block_seq == row.block_seq => block.sources.push(source),
            _ => blocks.push(BlockSources {
                block_seq: row.block_seq,
                sources: vec![source],
            }),
        }
    }
    Sources { blocks }
}

// ─── Commands ───────────────────────────────────────────────────────────────────────────────────

fn connected<'a>(state: &'a tauri::State<'_, TemperState>) -> Result<&'a TemperClient, String> {
    state
        .client()
        .ok_or_else(|| "temper is not connected".to_string())
}

fn resource_id<T>(raw: &str) -> Result<Uuid, PanelRead<T>> {
    parse_ref(raw).ok_or_else(|| PanelRead::Unresolved {
        reason: "not a resource reference".into(),
    })
}

/// Every edge touching the document, inbound and outbound.
#[tauri::command]
pub async fn doc_connections(
    state: tauri::State<'_, TemperState>,
    id: String,
) -> Result<PanelRead<Connections>, String> {
    let client = connected(&state)?;
    let id = match resource_id(&id) {
        Ok(id) => id,
        Err(refused) => return Ok(refused),
    };
    Ok(classify(
        client.resources().edges(id).await.map(shape_connections),
    ))
}

/// The document's neighbourhood: every visible resource one hop away.
#[tauri::command]
pub async fn doc_related(
    state: tauri::State<'_, TemperState>,
    id: String,
) -> Result<PanelRead<Related>, String> {
    let client = connected(&state)?;
    let id = match resource_id(&id) {
        Ok(id) => id,
        Err(refused) => return Ok(refused),
    };
    Ok(classify(
        client
            .graph()
            .traverse(&[id], Some(1))
            .await
            .map(|subgraph| shape_related(id, subgraph)),
    ))
}

/// The document's history, newest first, in runs by actor, bounded at `TRAIL_BOUND` events.
#[tauri::command]
pub async fn doc_history(
    state: tauri::State<'_, TemperState>,
    id: String,
) -> Result<PanelRead<History>, String> {
    let client = connected(&state)?;
    let id = match resource_id(&id) {
        Ok(id) => id,
        Err(refused) => return Ok(refused),
    };
    Ok(classify(
        client
            .events()
            .element_trail(ElementKind::Node, id)
            .await
            .map(|trail| shape_history(trail, TRAIL_BOUND)),
    ))
}

/// The sources recorded against the document's blocks.
#[tauri::command]
pub async fn doc_sources(
    state: tauri::State<'_, TemperState>,
    id: String,
) -> Result<PanelRead<Sources>, String> {
    let client = connected(&state)?;
    let id = match resource_id(&id) {
        Ok(id) => id,
        Err(refused) => return Ok(refused),
    };
    Ok(classify(
        client.resources().provenance(id).await.map(shape_sources),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const SEED: &str = "01a0e020-a6d7-7420-b924-68f5e89f354b";
    const A: &str = "01a0e0b8-39a6-7c42-97a4-3c1380308dc7";
    const B: &str = "01a0e0a3-065b-75c0-b603-bfd2b9728ddf";
    const C: &str = "01a0df70-526f-7022-8d33-7b95e91ff8c2";
    const PERSON: &str = "019eea5e-daf6-7916-92ca-65e712695c3b";
    const AGENT: &str = "019eea5e-daf6-7146-943a-c3aff1983a66";

    fn uuid(s: &str) -> Uuid {
        Uuid::parse_str(s).unwrap()
    }

    fn edge_row(label: &str, direction: &str, weight: f64) -> GraphEdgeRow {
        serde_json::from_value(json!({
            "edge_id": Uuid::new_v4(),
            "peer_table": "kb_resources",
            "peer_id": A,
            "peer_title": "Peer",
            "peer_slug": null,
            "edge_kind": "leads_to",
            "polarity": "forward",
            "label": label,
            "direction": direction,
            "weight": weight,
            "created": "2026-09-27T00:00:00Z"
        }))
        .expect("an edge row deserializes")
    }

    #[test]
    fn connections_come_back_whole_outgoing_first_strongest_first() {
        let shaped = shape_connections(vec![
            edge_row("cites", "incoming", 0.9),
            edge_row("depends_on", "outgoing", 0.4),
            edge_row("advances", "outgoing", 0.8),
        ]);
        assert_eq!(shaped.total, 3, "nothing is dropped from a complete read");
        let order: Vec<(&str, &str)> = shaped
            .edges
            .iter()
            .map(|e| (e.direction.as_str(), e.label.as_str()))
            .collect();
        assert_eq!(
            order,
            vec![
                ("outgoing", "advances"),
                ("outgoing", "depends_on"),
                ("incoming", "cites")
            ]
        );
        assert_eq!(shaped.edges[0].edge_kind, "leads_to");
    }

    fn node(id: &str, title: &str) -> serde_json::Value {
        json!({ "id": id, "title": title, "doc_type": "task", "home": "context", "degree": 3 })
    }

    fn atlas_edge(source: &str, target: &str, label: &str, weight: f64) -> serde_json::Value {
        json!({
            "id": Uuid::new_v4(), "source": source, "target": target,
            "edge_kind": "leads_to", "polarity": "forward", "label": label, "weight": weight
        })
    }

    #[test]
    fn related_is_the_neighbourhood_without_the_document_itself() {
        let subgraph: AtlasSubgraph = serde_json::from_value(json!({
            "nodes": [node(SEED, "Seed"), node(A, "Alpha"), node(B, "Beta"), node(C, "Gamma")],
            "edges": [
                atlas_edge(SEED, A, "depends_on", 0.5),
                atlas_edge(B, SEED, "advances", 0.9),
                atlas_edge(A, SEED, "relates_to", 0.7),
                // Between two neighbours: not the document's edge.
                atlas_edge(A, C, "cites", 1.0),
                // A document that points at itself is still not its own neighbour.
                atlas_edge(SEED, SEED, "supersedes", 1.0)
            ]
        }))
        .expect("a subgraph deserializes");
        let related = shape_related(uuid(SEED), subgraph);
        let titles: Vec<&str> = related
            .neighbours
            .iter()
            .map(|n| n.title.as_str())
            .collect();
        assert_eq!(
            titles,
            vec!["Beta", "Alpha"],
            "strongest joining edge first; Gamma joins only through Alpha, not the document"
        );
        assert_eq!(related.total, 2);
        assert_eq!(related.neighbours[1].via, vec!["depends_on", "relates_to"]);
        assert_eq!(related.neighbours[1].weight, 0.7);
    }

    fn event(actor: &str, name: &str, at: &str, correlation: Option<&str>) -> serde_json::Value {
        json!({
            "event_id": Uuid::new_v4(), "kind": "resource_reblocked",
            "actor_entity_id": actor, "actor_name": name, "occurred_at": at,
            "correlation_id": correlation, "payload": {}
        })
    }

    fn trail(events: Vec<serde_json::Value>) -> EventTrail {
        serde_json::from_value(json!({
            "element_kind": "node", "element_id": SEED, "events": events
        }))
        .expect("a trail deserializes")
    }

    const ACT_1: &str = "01a0e01f-0083-71cb-87ee-323c916b617b";
    const ACT_2: &str = "01a0e00c-aaf3-791d-abc6-979e71709150";

    /// The bite: a person's single edit between two agent runs stays its own run, rather than
    /// being folded into the agent's activity around it.
    #[test]
    fn history_runs_keep_a_person_edit_between_agent_runs_visible() {
        let shaped = shape_history(
            trail(vec![
                event(AGENT, "agent@mcp", "2026-09-27T10:00:00Z", Some(ACT_1)),
                event(AGENT, "agent@mcp", "2026-09-27T10:01:00Z", Some(ACT_1)),
                event(AGENT, "agent@mcp", "2026-09-27T10:02:00Z", Some(ACT_2)),
                event(PERSON, "person@cli", "2026-09-27T10:05:00Z", None),
                event(AGENT, "agent@mcp", "2026-09-27T10:09:00Z", None),
            ]),
            TRAIL_BOUND,
        );
        let runs: Vec<(&str, usize, usize)> = shaped
            .runs
            .iter()
            .map(|r| (r.actor_name.as_str(), r.acts, r.events.len()))
            .collect();
        assert_eq!(
            runs,
            vec![
                ("agent@mcp", 1, 1),
                ("person@cli", 1, 1),
                ("agent@mcp", 2, 3)
            ],
            "newest first, one run per unbroken stretch by an actor, acts counted by correlation"
        );
        assert_eq!(shaped.runs[2].first_at, "2026-09-27T10:00:00Z");
        assert_eq!(shaped.runs[2].last_at, "2026-09-27T10:02:00Z");
        assert_eq!(shaped.omitted, 0);
    }

    #[test]
    fn history_past_the_bound_keeps_the_newest_and_counts_the_rest() {
        let events = (0..5)
            .map(|i| event(PERSON, "person", &format!("2026-09-27T10:0{i}:00Z"), None))
            .collect();
        let shaped = shape_history(trail(events), 3);
        assert_eq!(shaped.total, 5);
        assert_eq!(shaped.omitted, 2);
        let kept: Vec<&str> = shaped.runs[0]
            .events
            .iter()
            .map(|e| e.occurred_at.as_str())
            .collect();
        assert_eq!(
            kept,
            vec![
                "2026-09-27T10:04:00Z",
                "2026-09-27T10:03:00Z",
                "2026-09-27T10:02:00Z"
            ]
        );
    }

    fn provenance(seq: i32, accretion: i32, carried: bool) -> BlockProvenanceRow {
        serde_json::from_value(json!({
            "block_id": Uuid::new_v4(), "block_seq": seq, "source_kind": "resource",
            "source_id": A, "source_uri": null, "accretion_seq": accretion,
            "contributed_by_event_id": Uuid::new_v4(), "created": "2026-09-27T00:00:00Z",
            "is_carried": carried
        }))
        .expect("a provenance row deserializes")
    }

    #[test]
    fn sources_group_by_block_in_document_and_accretion_order() {
        let shaped = shape_sources(vec![
            provenance(3, 1, false),
            provenance(0, 2, true),
            provenance(0, 1, false),
        ]);
        let shape: Vec<(i32, Vec<bool>)> = shaped
            .blocks
            .iter()
            .map(|b| (b.block_seq, b.sources.iter().map(|s| s.carried).collect()))
            .collect();
        assert_eq!(shape, vec![(0, vec![false, true]), (3, vec![false])]);
    }

    #[test]
    fn no_rows_is_no_blocks_not_an_error() {
        assert!(shape_sources(Vec::new()).blocks.is_empty());
    }

    #[test]
    fn a_non_reference_is_unresolved() {
        assert!(matches!(
            resource_id::<()>("not-a-ref"),
            Err(PanelRead::Unresolved { .. })
        ));
    }

    /// Witness against the real API: each panel read answers for a readable resource. Ignored by
    /// default — it needs the machine's temper credentials, network and a readable resource.
    /// Run locally: `TEMPER_WITNESS_REF=<id> cargo test -- --ignored panel_reads_answer`
    #[tokio::test]
    #[ignore = "requires temper credentials, network, and TEMPER_WITNESS_REF"]
    async fn panel_reads_answer() {
        let state = TemperState::connect();
        let client = state
            .client()
            .expect("machine temper credentials should resolve to a client");
        let known = std::env::var("TEMPER_WITNESS_REF")
            .expect("set TEMPER_WITNESS_REF to a readable resource id");
        let id = parse_ref(&known).expect("TEMPER_WITNESS_REF is a resource reference");

        let connections = client.resources().edges(id).await.expect("edges read");
        let shaped = shape_connections(connections);
        assert_eq!(shaped.total, shaped.edges.len());

        let related = client
            .graph()
            .traverse(&[id], Some(1))
            .await
            .expect("traverse read");
        let shaped = shape_related(id, related);
        assert!(shaped.neighbours.iter().all(|n| n.id != id));

        let history = client
            .events()
            .element_trail(ElementKind::Node, id)
            .await
            .expect("trail read");
        let shaped = shape_history(history, TRAIL_BOUND);
        assert!(
            shaped.total > 0,
            "a readable resource has at least its creation"
        );

        client
            .resources()
            .provenance(id)
            .await
            .expect("provenance read");
    }
}
